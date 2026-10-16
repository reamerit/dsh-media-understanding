/**
 * `dsh-media-understanding` —— DSH 宿主侧插件的入口。
 *
 * 注册三个工具：
 * - `media_probe`：环境探测（完全只读），也是"装载闭环"的验证工具；
 * - `transcribe_audio`：音视频 → 带时间戳转录，**走后台作业**（长任务）；
 * - `video_frames`：视频 → 带时间戳关键帧**真图**（同步，帧图必须内联）。
 *
 * 输入统一为"一段媒体"：本地绝对路径（含 GUI 上传落地后的路径）**或** http(s) 链接
 * （直链走 ffmpeg / 平台页面走 yt-dlp）。任务要求由**主模型**消化成具体工具调用，
 * 插件不额外引入 `task` 参数。
 *
 * 设备策略见 docs/coding-plan.md §5.1.0：有卡用卡、无卡自动降级，任何 CUDA
 * 探测失败都不抛错。
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

import { registerFramesTool } from './tools/frames.js'
import { registerProbeTool } from './tools/probe.js'
import { registerTranscribeTool } from './tools/transcribe.js'

export const name = 'media-understanding'

/**
 * 静态 inject：这些服务在 base bundle 里必然存在，缺一个插件就该装不上
 * （而不是运行到一半才炸）。可选能力（attachments / llm）走 `ctx.get` 探测，
 * 见 `tools/frames.ts`。
 */
export const inject = ['tools', 'subprocess', 'jobs']

export interface Config {
  /** Python 解释器；缺省用 PATH 上的 `python`。 */
  whisper?: {
    pythonPath?: string
    model?: string
    /** `auto`（默认，有卡用卡、无卡落 CPU）| `cuda` | `cpu`。 */
    device?: string
    /** `auto`（默认，按设备取可用档）| int8 | int8_float32 | float16 | float32 … */
    computeType?: string
    modelCacheDir?: string
    localFilesOnly?: boolean
    /** 单次转录的子进程预算（毫秒）。 */
    timeoutMs?: number
  }
  frames?: {
    threshold?: number
    maxFrames?: number
    jpegQuality?: number
    maxWidth?: number
  }
  transcribe?: {
    /** 作业的模型面字节上限。 */
    jobOutputLimitBytes?: number
    maxSegments?: number
  }
  download?: {
    /** 覆盖 yt-dlp 可执行文件；缺省 `python -m yt_dlp`。 */
    ytDlpPath?: string
    /** 单个链接的下载预算（毫秒）。 */
    timeoutMs?: number
  }
  ffmpeg?: {
    path?: string
  }
  ffprobe?: {
    path?: string
  }
}

export const Config: Schema<Config> = Schema.object({
  whisper: Schema.object({
    pythonPath: Schema.string().description('Python 解释器路径（缺省用 PATH 上的 python）'),
    model: Schema.string()
      .default('small')
      .description('Whisper 规格：tiny/base/small/medium/large-v3'),
    device: Schema.string()
      .default('auto')
      .description('auto（有卡用卡、无卡落 CPU）/ cuda / cpu'),
    computeType: Schema.string()
      .default('auto')
      .description('auto 会按设备取可用档（GPU int8_float32 / CPU int8）'),
    modelCacheDir: Schema.string().description('模型缓存目录（HF hub）'),
    localFilesOnly: Schema.boolean().default(false).description('只用本地已下载模型，不联网'),
    timeoutMs: Schema.number().description('单次转录的子进程预算（毫秒）'),
  })
    .description('Whisper 转录设置')
    .default({}),
  frames: Schema.object({
    threshold: Schema.number().min(0).max(1).default(0.3).description('场景变化灵敏度'),
    maxFrames: Schema.number().min(1).max(50).default(16).description('单次抽帧上限'),
    jpegQuality: Schema.number().min(2).max(31).default(3).description('ffmpeg -q:v，越小越清晰'),
    maxWidth: Schema.number().min(64).default(1280).description('帧图宽度上限'),
  })
    .description('抽帧设置')
    .default({}),
  transcribe: Schema.object({
    jobOutputLimitBytes: Schema.number().default(262144).description('作业的模型面字节上限'),
    maxSegments: Schema.number().default(5000).description('分段上限，超出即截断并标注'),
  })
    .description('转录作业设置')
    .default({}),
  download: Schema.object({
    ytDlpPath: Schema.string().description('yt-dlp 可执行文件（缺省 python -m yt_dlp）'),
    timeoutMs: Schema.number().description('单个链接的下载预算（毫秒）'),
  })
    .description('链接下载设置')
    .default({}),
  ffmpeg: Schema.object({ path: Schema.string().description('ffmpeg 路径（缺省自动解析）') })
    .description('ffmpeg 设置')
    .default({}),
  ffprobe: Schema.object({ path: Schema.string().description('ffprobe 路径（缺省自动解析）') })
    .description('ffprobe 设置')
    .default({}),
})

/**
 * 定位 **worker 脚本目录**（`<pkg>/src/workers`，里面是 `probe.py` / `transcribe.py`）。
 *
 * ⚠️ 这里连续踩过两次真实故障，所以约定必须写死、不能再含糊：
 *
 * 1. 产物入口是 `<pkg>/lib/index.js`，`import.meta.url` 的目录是 `<pkg>/lib`，
 *    所以候选要从 `<pkg>` 下找 `src/workers`；
 * 2. 曾出现"这里返回 workers 目录、下游又拼一次 `workers`"（或反过来的错配），
 *    最终路径变成 `<pkg>/src/workers/workers/probe.py` 或 `<pkg>/workers/probe.py`。
 *
 * 两种错法的后果都极隐蔽：python 立刻以"打不开文件"退出、探针 stdout 为空 ⇒
 * 设备静默落 CPU、`fasterWhisper.ready: false`，看着像"这台机器没装依赖"，
 * 而 shell 里手跑同一脚本却完全正常。
 *
 * ⇒ **唯一约定**：本函数返回的就是 workers 目录本身；调用方一律
 * `join(workerDir, 'probe.py')`（见 `media/whisper.ts` 的 `probeScriptPath`），
 * **任何一处都不再额外拼 `workers`**。`runPythonProbe` 还会断言脚本确实存在。
 */
function workersDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, '..', 'src', 'workers'), // 构建产物：here = <pkg>/lib
    join(here, 'workers'), // 直跑源码：here = <pkg>/src
    join(here, '..', '..', 'src', 'workers'), // 防御：多一层产物目录
  ]
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'probe.py'))) return candidate
  }
  return candidates[0]!
}

export function apply(ctx: Context, config: Config = {}): void {
  const workerDir = workersDir()

  ctx.effect(() => {
    const disposers: Array<() => void> = []
    try {
      disposers.push(registerProbeTool(ctx, { config, workerDir }))
      disposers.push(registerTranscribeTool(ctx, { config, workerDir }))
      disposers.push(registerFramesTool(ctx, { config, workerDir }))
    } catch (error) {
      for (const dispose of disposers) dispose()
      throw error
    }
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'media-understanding: tools')
}
