/**
 * 输入解析：用户给的是**本地文件**还是**视频链接**（coding-plan 新增需求）。
 *
 * 插件对外只暴露一个输入概念 ——"一段媒体 + 一句任务要求"，由**主模型**把任务要求
 * 消化成具体工具调用（不额外引入 `task` 参数）。工具侧要做的只是把输入变成
 * "一个确实存在、ffmpeg 读得动的本地文件"：
 *
 * - 本地路径（含 GUI 上传落地后的路径）→ 直接使用；
 * - `http(s)` 链接 → 交给下载器（平台页面靠 yt-dlp，直链靠 ffmpeg/yt-dlp）；
 * - 其余 scheme（`file:`/`ftp:`/`rtsp:` 等）→ 明确拒绝，而不是悄悄当成路径。
 *
 * 纯逻辑，不 import 宿主包、不碰文件系统 —— 由 `scripts/selftest-resolve.mjs` 断言。
 */

/** 输入分类结果。 */
export type MediaInput =
  | { readonly kind: 'local'; readonly path: string; readonly scheme: null }
  | { readonly kind: 'remote'; readonly url: string; readonly scheme: 'http' | 'https' }
  | { readonly kind: 'unsupported-scheme'; readonly raw: string; readonly scheme: string }
  | { readonly kind: 'empty'; readonly raw: string }

const HTTP_URL = /^https?:\/\/[^\s]+$/i
const ANY_SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i
/** Windows 盘符（`C:\...` 或 `C:/...`）要当作本地路径，不能误判成 scheme。 */
const WINDOWS_DRIVE = /^[a-zA-Z]:[\\/]/

/** 媒体扩展名集合：只用于"看起来像个文件"的判断与输出命名，不用于拒绝输入。 */
const MEDIA_EXTENSIONS = new Set([
  // video
  'mp4', 'mkv', 'mov', 'avi', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', 'ts', 'm2ts', '3gp', 'ogv',
  // audio
  'mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wma', 'amr', 'aiff', 'ape',
])

/**
 * 把用户/模型给的输入字符串分类。
 *
 * 注意顺序：先排除 Windows 盘符，再判 URL，最后才当成 scheme —— 否则 `C:\x.mp4`
 * 会被 `ANY_SCHEME` 误判。
 */
export function classifyMediaInput(raw: string): MediaInput {
  const trimmed = (raw ?? '').trim()
  if (trimmed === '') return { kind: 'empty', raw }

  if (WINDOWS_DRIVE.test(trimmed)) {
    return { kind: 'local', path: trimmed, scheme: null }
  }

  if (HTTP_URL.test(trimmed)) {
    const scheme = trimmed.slice(0, trimmed.indexOf(':')).toLowerCase()
    return {
      kind: 'remote',
      url: trimmed,
      scheme: scheme === 'https' ? 'https' : 'http',
    }
  }

  const schemeMatch = ANY_SCHEME.exec(trimmed)
  if (schemeMatch) {
    return {
      kind: 'unsupported-scheme',
      raw: trimmed,
      scheme: schemeMatch[1]!.toLowerCase(),
    }
  }

  return { kind: 'local', path: trimmed, scheme: null }
}

/** 扩展名（小写，不含点）；没有则返回空串。 */
export function extensionOf(value: string): string {
  const withoutQuery = value.split(/[?#]/, 1)[0] ?? ''
  const lastSegment = withoutQuery.split(/[\\/]/).pop() ?? ''
  const dot = lastSegment.lastIndexOf('.')
  if (dot <= 0 || dot === lastSegment.length - 1) return ''
  return lastSegment.slice(dot + 1).toLowerCase()
}

/** 是否像是 ffmpeg 能直接读的媒体文件（仅用于提示与命名，不作为准入条件）。 */
export function looksLikeMediaFile(value: string): boolean {
  return MEDIA_EXTENSIONS.has(extensionOf(value))
}

/**
 * 由 URL 推导一个**安全的**下载文件名。
 *
 * - 优先用路径最后一段（去掉 query/fragment 与 URL 编码）；
 * - 没有可用段（例如 `https://host/`）时退化为 `host` + 时间戳；
 * - 非 ASCII 与控制字符替换为 `_`，并限制长度 —— 临时目录名/文件名保持 ASCII 安全
 *   （coding-plan R7：Windows 路径与中文文件名各自都有坑，临时产物一律 ASCII）。
 * - **始终附带扩展名**：即使 URL 里没有（页面链接），也给 `.mp4`，因为 yt-dlp 会
 *   按容器写文件，而 ffmpeg 在没有扩展名时会拒绝推断格式。
 */
export function suggestDownloadFileName(url: string, at: Date = new Date()): string {
  let pathPart = ''
  let host = 'media'
  try {
    const parsed = new URL(url)
    host = parsed.hostname.replace(/^www\./i, '') || host
    pathPart = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? '')
  } catch {
    pathPart = url.split(/[?#]/, 1)[0]?.split('/').filter(Boolean).pop() ?? ''
  }

  const ext = extensionOf(pathPart)
  const base = ext ? pathPart.slice(0, pathPart.length - ext.length - 1) : pathPart
  const safeBase = sanitizeFileStem(base || `${host}-${at.toISOString().replace(/[-:T]/g, '').slice(0, 14)}`)
  return `${safeBase}.${ext || 'mp4'}`
}

/**
 * 清洗文件名主干：保留 ASCII 字母数字与 `._-`，其余压成 `_`，长度上限 60。
 * 结果永不为空（空则回退 `media`），也不以 `.` 结尾（避免 Windows 拒写）。
 */
export function sanitizeFileStem(stem: string): string {
  const cleaned = stem
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 60)
  return cleaned || 'media'
}

/** 给模型看的一句话输入说明——工具参数说明复用，保证三种输入形式口径一致。 */
export const INPUT_PARAM_HINT =
  'Local absolute file path, or an http(s) link (direct media URL or a platform page such as YouTube/Bilibili).'
