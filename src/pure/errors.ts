/**
 * 错误分类（coding-plan C4b/R3d/R3e）：把"子进程挂了"变成**可行动的结论**。
 *
 * 本机踩过的两个坑决定了这里必须分类而不是笼统报错：
 *
 * - **MSVCP140.dll 过旧** → `ctranslate2`/`onnxruntime` 一调用就 `0xC0000005` **硬崩溃**，
 *   **无 traceback、无输出**，表现为"python 子进程莫名消失"。识别特征是
 *   **退出码是 0xC0000005 / -1073741819 且输出为空**。
 * - **内存不足** → `mkl_malloc: failed to allocate memory`，可捕获，应独立回报。
 *
 * 纯逻辑，不 import 宿主包 —— 由 `scripts/selftest-errors.mjs` 用真实样本断言。
 */

export type MediaErrorKind =
  | 'missing-ffmpeg'
  | 'missing-ffprobe'
  | 'missing-python'
  | 'missing-faster-whisper'
  | 'missing-msvc-runtime'
  | 'out-of-memory'
  | 'unsupported-av-version'
  | 'no-audio-track'
  | 'no-video-stream'
  | 'no-scene-change'
  | 'cuda-unavailable'
  | 'cuda-oom'
  | 'download-failed'
  | 'download-tool-missing'
  | 'unsupported-url'
  | 'input-not-found'
  | 'timeout'
  | 'cancelled'
  | 'ffmpeg-failed'
  | 'unknown'

export interface ClassifiedError {
  readonly kind: MediaErrorKind
  /** 面向模型的一句话结论（英文，工具输出统一英文）。 */
  readonly summary: string
  /** 给维护者看的修复动作；没有明确动作时为 null。 */
  readonly remedy: string | null
  /** 是否属于"基础设施故障"（按 DSH 契约应当 throw，而非返回 canonical 值）。 */
  readonly infrastructure: boolean
}

/** Windows 上的 `0xC0000005`（访问冲突）在 Node 里可能以有符号 32 位出现。 */
const ACCESS_VIOLATION_CODES = new Set([0xc0000005, -1073741819])

interface Rule {
  readonly kind: MediaErrorKind
  readonly match: (ctx: ClassifyContext) => boolean
}

export interface ClassifyContext {
  /** 子进程 stderr（clipped）。 */
  readonly stderr: string
  /** 子进程 stdout（clipped）。 */
  readonly stdout?: string
  /** 退出码；未退出传 undefined。 */
  readonly exitCode?: number
  /** 可执行文件是否解析失败（`resolveExecutable` 抛错）。 */
  readonly executableMissing?: 'ffmpeg' | 'ffprobe' | 'python'
}

const has = (text: string, needle: string): boolean =>
  text.toLowerCase().includes(needle.toLowerCase())

/** 规则表：顺序即优先级，先匹配者胜。 */
const RULES: readonly Rule[] = [
  {
    kind: 'missing-msvc-runtime',
    match: (c) =>
      c.exitCode !== undefined &&
      ACCESS_VIOLATION_CODES.has(c.exitCode) &&
      (c.stderr.trim() === '' && (c.stdout ?? '').trim() === ''),
  },
  {
    kind: 'missing-faster-whisper',
    match: (c) => has(c.stderr, 'ModuleNotFoundError') && has(c.stderr, 'faster_whisper'),
  },
  {
    kind: 'missing-faster-whisper',
    match: (c) => has(c.stderr, 'No module named') && has(c.stderr, 'faster_whisper'),
  },
  {
    kind: 'out-of-memory',
    match: (c) => has(c.stderr, 'mkl_malloc') || has(c.stderr, 'failed to allocate memory'),
  },
  {
    kind: 'cuda-oom',
    match: (c) =>
      has(c.stderr, 'out of memory') && (has(c.stderr, 'cuda') || has(c.stderr, 'cublas')),
  },
  {
    kind: 'cuda-unavailable',
    match: (c) =>
      has(c.stderr, 'no CUDA-capable device') ||
      has(c.stderr, 'CUDA failed with error') ||
      has(c.stderr, 'cuda driver version is insufficient'),
  },
  {
    kind: 'unsupported-av-version',
    match: (c) => has(c.stderr, 'metadata_errors'),
  },
  {
    kind: 'download-tool-missing',
    match: (c) => has(c.stderr, 'yt_dlp') && has(c.stderr, 'No module named'),
  },
  {
    // 实测样本（ffmpeg 拉死链）：`[https @ …] HTTP error 404 Not Found` 与
    // `https://…: Server returned 404 Not Found`；yt-dlp 侧是
    // `ERROR: … Unable to download webpage: HTTP Error 404: Not Found`。
    kind: 'download-failed',
    match: (c) =>
      /HTTP [Ee]rror \d{3}/.test(c.stderr) ||
      /Server returned \d{3}/.test(c.stderr) ||
      /HTTP\/[\d.]+ \d{3}/.test(c.stderr) ||
      has(c.stderr, 'unable to download webpage') ||
      has(c.stderr, 'video unavailable') ||
      has(c.stderr, 'unsupported url') ||
      has(c.stderr, 'no such host') ||
      has(c.stderr, 'connection refused') ||
      has(c.stderr, 'failed to resolve'),
  },
  {
    kind: 'timeout',
    match: (c) => c.exitCode === 124 || has(c.stderr, 'timed out') || has(c.stderr, 'timeout'),
  },
  {
    kind: 'no-audio-track',
    match: (c) => has(c.stderr, 'does not contain any stream') || has(c.stderr, 'Audio: none'),
  },
  {
    kind: 'no-video-stream',
    match: (c) => has(c.stderr, 'matches no streams') || has(c.stderr, 'Invalid argument') && has(c.stderr, '-vn'),
  },
]

const DESCRIPTIONS: Readonly<Record<MediaErrorKind, Omit<ClassifiedError, 'kind'>>> = {
  'missing-ffmpeg': {
    summary: 'ffmpeg is not available; install it and make sure it is on PATH (or set ffmpeg.path).',
    remedy: 'Install ffmpeg 6.0+ and ensure `ffmpeg` resolves on PATH, or set config `ffmpeg.path`.',
    infrastructure: true,
  },
  'missing-ffprobe': {
    summary: 'ffprobe is not available; it ships with ffmpeg (or set ffprobe.path).',
    remedy: 'Install ffmpeg (which includes ffprobe) or set config `ffprobe.path`.',
    infrastructure: true,
  },
  'missing-python': {
    summary: 'No usable Python interpreter was found for the whisper worker.',
    remedy: 'Install Python 3.14 and set config `whisper.pythonPath`.',
    infrastructure: true,
  },
  'missing-faster-whisper': {
    summary: 'Python could not import faster_whisper, so local transcription is unavailable.',
    remedy: 'Run `python -m pip install "faster-whisper==1.2.1" "av<19"` for the configured interpreter.',
    infrastructure: true,
  },
  'missing-msvc-runtime': {
    summary:
      'A native dependency crashed with 0xC0000005 and produced no output — this is the known stale Visual C++ runtime failure.',
    remedy: 'Install the VC++ 2015-2022 redistributable so MSVCP140.dll is >= 14.40.',
    infrastructure: true,
  },
  'out-of-memory': {
    summary: 'The transcription process ran out of memory while loading or running the model.',
    remedy: 'Use a smaller model (tiny/base/small), or free memory; the GPU path can be tried instead.',
    infrastructure: false,
  },
  'unsupported-av-version': {
    summary:
      'PyAV is too new for this faster-whisper: av>=19 removed the metadata_errors argument it still passes.',
    remedy: 'Pin PyAV below 19 (`pip install "av<19"`); 18.1.0 is verified.',
    infrastructure: true,
  },
  'no-audio-track': {
    summary: 'The file has no audio track, so there is nothing to transcribe.',
    remedy: null,
    infrastructure: false,
  },
  'no-video-stream': {
    summary: 'The file has no usable video stream.',
    remedy: null,
    infrastructure: false,
  },
  'no-scene-change': {
    summary: 'No scene change was detected; try strategy "fps" instead.',
    remedy: null,
    infrastructure: false,
  },
  'cuda-unavailable': {
    summary: 'CUDA was requested but no usable CUDA device is present on this machine.',
    remedy: 'Use device "auto" (falls back to CPU) or "cpu".',
    infrastructure: true,
  },
  'cuda-oom': {
    summary: 'The GPU ran out of memory during transcription.',
    remedy: 'Use a smaller model or fall back to CPU.',
    infrastructure: false,
  },
  'download-failed': {
    summary: 'The media could not be downloaded from the given link.',
    remedy: 'Check that the link is reachable and public, then retry.',
    infrastructure: false,
  },
  'download-tool-missing': {
    summary: 'Downloading this kind of link needs yt-dlp, which is not installed for this interpreter.',
    remedy: 'Run `python -m pip install yt-dlp`.',
    infrastructure: true,
  },
  'unsupported-url': {
    summary: 'Only http(s) links are supported (plus local file paths).',
    remedy: null,
    infrastructure: false,
  },
  'input-not-found': {
    summary: 'The given local file does not exist or is not readable.',
    remedy: null,
    infrastructure: true,
  },
  timeout: {
    summary: 'The media operation exceeded its time budget.',
    remedy: 'Raise the configured timeout or use a shorter clip.',
    infrastructure: false,
  },
  cancelled: {
    summary: 'The media operation was cancelled.',
    remedy: null,
    infrastructure: false,
  },
  'ffmpeg-failed': {
    summary: 'ffmpeg failed while processing the media.',
    remedy: null,
    infrastructure: true,
  },
  unknown: {
    summary: 'The media operation failed for an unrecognised reason.',
    remedy: null,
    infrastructure: true,
  },
}

/** 由 kind 取标准描述（summary/remedy/infrastructure）。 */
export function describeError(kind: MediaErrorKind): ClassifiedError {
  return { kind, ...DESCRIPTIONS[kind] }
}

/**
 * 按优先级把一次子进程失败分类。
 *
 * `executableMissing` 优先于文本匹配：解析不到可执行文件时 stderr 往往是空的，
 * 文本规则抓不到，而原因其实很确定。
 */
export function classifyFailure(ctx: ClassifyContext): ClassifiedError {
  if (ctx.executableMissing === 'ffmpeg') return describeError('missing-ffmpeg')
  if (ctx.executableMissing === 'ffprobe') return describeError('missing-ffprobe')
  if (ctx.executableMissing === 'python') return describeError('missing-python')

  for (const rule of RULES) {
    if (rule.match(ctx)) return describeError(rule.kind)
  }
  return describeError('unknown')
}

/**
 * 从 worker 的 JSON 结果里识别"业务失败但进程正常退出"的情况
 * （无音轨、无场景变化等应当返回 canonical 值 + reason，而不是 throw）。
 */
export function classifyBusinessReason(reason: string | undefined): ClassifiedError | null {
  if (!reason) return null
  const map: Record<string, MediaErrorKind> = {
    'no-audio-track': 'no-audio-track',
    'no-video-stream': 'no-video-stream',
    'no-scene-change': 'no-scene-change',
    'model-lacks-image-input': 'unknown',
  }
  const kind = map[reason]
  return kind ? describeError(kind) : null
}
