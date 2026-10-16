/**
 * `video_frames` —— 视频 → 带时间戳关键帧**真图**（coding-plan Phase 3，风险最高）。
 *
 * 三处必须做对的地方：
 *
 * 1. **能力门控（C2）**：产出 image 块前必须确认当前路由声明了图片输入。
 *    上游适配器在未声明时是**硬失败**（整轮对话报 `UNSUPPORTED_CONTENT`），
 *    比"看不到图"严重得多。所以按 §5.1 的口径**降级为 `mode: 'text-only'`**
 *    （给帧文件路径 + 时间戳）而不是抛错——这正是"后续对话不报错"的保证。
 * 2. **附件持久化（C1）**：image 块只认 `ctx.attachments` 的持久引用，
 *    不能凭空构造 base64。帧图必须在 `execute` 里落到附件服务，`render` 只做投影。
 * 3. **时间戳（C4a）**：`metadata=mode=print` 打印的 `pts_time` 与输出文件 1:1；
 *    解析不到时如实标 `estimated`。
 */
import { readFile } from 'node:fs/promises'

import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

import type { Config } from '../index.js'
import { cleanupWorkDir, probeMedia, sampleFrames } from '../media/ffmpeg.js'
import { releaseInput, resolveInput } from '../media/input.js'
import { describeError } from '../pure/errors.js'
import { pruneUndefined } from '../pure/json.js'
import { formatTime, renderFrames as renderFramesPure } from '../pure/render.js'
import { INPUT_PARAM_HINT } from '../pure/resolve-input.js'

export interface FramesToolDeps {
  readonly config: Config
  /** workers 目录（`<pkg>/src/workers`），由 `index.ts` 的 `workersDir()` 定位。 */
  readonly workerDir: string
}

/** canonical 值：永远有值，降级也走这里。 */
interface FrameEntry {
  readonly index: number
  readonly timestampSec: number
  readonly attachmentId?: string
  readonly mediaType?: string
  readonly bytes?: number
  readonly width?: number
  readonly height?: number
  readonly path?: string
}

interface FramesValue {
  /** ⚠️ 不能用 readonly：`output.schema` 推导出的值类型是可变数组。 */
  frames: FrameEntry[]
  readonly strategy: 'scene' | 'fps'
  readonly timestampSource: 'exact' | 'estimated'
  readonly mode: 'images' | 'text-only'
  readonly reason?: string
  readonly durationSec: number
  readonly note?: string
}

/** 供会话回放：`render` 拿不到文件，必须把附件引用持久化进 meta。 */
interface FramesMeta {
  readonly mode: 'images' | 'text-only'
  readonly frames: Array<{
    readonly index: number
    readonly timestampSec: number
    readonly attachmentId?: string
    readonly mediaType?: string
  }>
  readonly reason?: string
}

export function registerFramesTool(ctx: Context, deps: FramesToolDeps): () => void {
  const framesConfig = deps.config.frames ?? {}
  const defaultThreshold = framesConfig.threshold ?? 0.3
  const defaultMaxFrames = framesConfig.maxFrames ?? 16
  const jpegQuality = framesConfig.jpegQuality ?? 3
  const maxWidth = framesConfig.maxWidth ?? 1280

  const definition = defineTool({
    name: 'video_frames',
    description:
      'Extract timestamped keyframe images from a video file or an http(s) link (direct media ' +
      'URL, or a platform page such as YouTube/Bilibili, downloaded with yt-dlp first). Returns ' +
      'real images inline with their timestamps so you can see what was on screen, e.g. to read a ' +
      'slide or on-screen text at a given moment. Uses scene-change detection by default; pass ' +
      'strategy "fps" for animation or a video with no scene cuts. If the current model cannot ' +
      'accept images, this returns frame file paths and timestamps instead of images.',
    parameters: {
      file_path: {
        type: 'string',
        required: true,
        description: `${INPUT_PARAM_HINT} The link is downloaded to a temporary file first.`,
      },
      threshold: {
        type: 'number',
        description: `Scene-change sensitivity between 0 and 1 (default ${defaultThreshold}). Lower finds more cuts.`,
      },
      max_frames: {
        type: 'integer',
        description: `Maximum frames to return (default ${defaultMaxFrames}). Each frame costs context.`,
      },
      strategy: {
        type: 'string',
        enum: ['scene', 'fps'],
        description: 'scene = sample on scene changes (default); fps = fixed-interval sampling.',
      },
      fps: {
        type: 'number',
        description: 'Sampling rate when strategy is "fps" (default 1 frame per second).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          frames: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer', required: true },
                timestampSec: { type: 'number', required: true },
                attachmentId: { type: 'string' },
                mediaType: { type: 'string' },
                bytes: { type: 'integer' },
                width: { type: 'integer' },
                height: { type: 'integer' },
                path: { type: 'string' },
              },
            },
          },
          strategy: { type: 'string', required: true },
          timestampSource: { type: 'string', required: true },
          mode: { type: 'string', required: true },
          reason: { type: 'string' },
          durationSec: { type: 'number', required: true },
          note: { type: 'string' },
        },
      },
      // render 必须是纯函数：只做投影，不读文件、不编码。IO 全在 execute 里完成，
      // 结果已体现在 canonical 值与 presentationMeta 里。
      render: (args, value) => renderFrames(args as { max_frames?: number }, value as FramesValue),
      presentationMeta: (_args, value) => {
        const v = value as FramesValue
        const meta: FramesMeta = {
        mode: v.mode,
        frames: v.frames.map((frame) => ({
          index: frame.index,
          timestampSec: frame.timestampSec,
          ...(frame.attachmentId ? { attachmentId: frame.attachmentId } : {}),
          ...(frame.mediaType ? { mediaType: frame.mediaType } : {}),
        })),
        ...(v.reason ? { reason: v.reason } : {}),
      }
      return pruneUndefined(meta) as unknown as never
      },
    },
    timeoutMs: 10 * 60_000,
    isConcurrencySafe: () => true,
    execute: async (args, exec): Promise<FramesValue> => {
      const input = String(args.file_path ?? '').trim()
      const strategy = args.strategy === 'fps' ? 'fps' : 'scene'
      const threshold = clampNumber(args.threshold, 0, 1, defaultThreshold)
      const requestedMax = Math.trunc(clampNumber(args.max_frames, 1, 50, defaultMaxFrames))
      const fps = clampNumber(args.fps, 0.01, 60, 1)

      const outcome = await resolveInput(
        ctx,
        input,
        {
          pythonPath: deps.config.whisper?.pythonPath,
          ...deps.config.download,
          ffmpegPath: deps.config.ffmpeg?.path,
        },
        exec.signal,
      )
      if (!outcome.resolved) {
        const error = outcome.error ?? describeError('unknown')
        if (error.infrastructure) throw new Error(error.summary)
        return pruneUndefined({
          frames: [],
          strategy,
          timestampSource: 'estimated',
          mode: 'text-only',
          reason: error.kind,
          durationSec: 0,
          note: error.summary,
        }) as FramesValue
      }
      const resolved = outcome.resolved

      let workDir: string | undefined
      try {
        const probe = await probeMedia(
          ctx,
          resolved.path,
          { ffprobePath: deps.config.ffprobe?.path, ffmpegPath: deps.config.ffmpeg?.path },
          exec.signal,
        )
        if (!probe.streams) {
          const error = probe.error ?? describeError('ffmpeg-failed')
          // 基础设施故障按契约 throw，但把 summary 一并带上，别让模型只看到裸错误。
          throw new Error(error.summary)
        }
        if (!probe.streams.hasVideo) {
          return pruneUndefined({
            frames: [],
            strategy,
            // 一个帧都没抽到时，说"时间戳是估算"是无意义的（且会误导）。
            timestampSource: 'estimated',
            mode: 'text-only',
            reason: 'no-video-stream',
            durationSec: probe.streams.durationSec,
          }) as FramesValue
        }

        // 图片张数上限：与部署的 imageLimits 取小，绝不越过 maxImagesPerMessage。
        const attachments = ctx.get('attachments')
        const perMessageLimit = attachments?.imageLimits.maxImagesPerMessage ?? requestedMax
        const maxFrames = Math.max(1, Math.min(requestedMax, perMessageLimit))

        const sampled = await sampleFrames(
          ctx,
          resolved.path,
          {
            strategy,
            threshold,
            fps,
            maxFrames,
            jpegQuality,
            maxWidth,
            durationSec: probe.streams.durationSec,
          },
          { ffmpegPath: deps.config.ffmpeg?.path },
          exec.signal,
        )
        workDir = sampled.workDir

        if (sampled.frames.length === 0) {
          return pruneUndefined({
            frames: [],
            strategy,
            // 没有帧时沿用采样器的判定（通常是 'none' 的语义），不再编造来源。
            timestampSource: sampled.timestampSource === 'exact' ? 'exact' : 'estimated',
            mode: 'text-only',
            reason: sampled.error ? sampled.error.kind : 'no-scene-change',
            durationSec: probe.streams.durationSec,
            note:
              strategy === 'scene'
                ? 'no scene change was detected; retry with strategy "fps" to sample at fixed intervals'
                : 'no frames could be extracted',
          }) as FramesValue
        }

        // 能力门控（C2）：未声明图片输入 → 只给路径 + 时间戳，绝不产出 image 块。
        const canSeeImages = await routeAcceptsImages(ctx, exec)
        if (!canSeeImages) {
          return pruneUndefined({
            frames: sampled.frames.map((frame) => ({
              index: frame.index,
              timestampSec: frame.timestampSec,
              path: frame.path,
              ...(probe.streams?.width ? { width: probe.streams.width } : {}),
              ...(probe.streams?.height ? { height: probe.streams.height } : {}),
            })),
            strategy,
            timestampSource: sampled.timestampSource,
            mode: 'text-only',
            reason: 'model-lacks-image-input',
            durationSec: probe.streams.durationSec,
            note:
              'the current model route does not declare image input, so frames were saved as ' +
              'files and only their paths and timestamps are returned; switch to an ' +
              'image-capable model to see the frames',
          }) as FramesValue
        }

        if (!attachments) {
          // 宿主没挂附件服务：同样降级为路径，而不是凭空构造 image 块。
          return pruneUndefined({
            frames: sampled.frames.map((frame) => ({
              index: frame.index,
              timestampSec: frame.timestampSec,
              path: frame.path,
            })),
            strategy,
            timestampSource: sampled.timestampSource,
            mode: 'text-only',
            reason: 'attachments-unavailable',
            durationSec: probe.streams.durationSec,
            note: 'the attachment service is not mounted, so frames could not be persisted as images',
          }) as FramesValue
        }

        // 附件持久化（C1）：批量 saveImages，再按顺序配回时间戳。
        const payloads = await Promise.all(
          sampled.frames.map(async (frame) => ({
            frame,
            data: new Uint8Array(await readFile(frame.path)),
          })),
        )
        const refs = await attachments.saveImages(
          payloads.map((entry) => ({
            data: entry.data,
            mediaType: 'image/jpeg' as const,
            name: `frame-${String(entry.frame.index + 1).padStart(4, '0')}.jpg`,
          })),
        )

        const frames: FrameEntry[] = payloads.map((entry, i) => {
          const ref = refs[i]
          return {
            index: entry.frame.index,
            timestampSec: entry.frame.timestampSec,
            ...(ref
              ? {
                  attachmentId: String(ref.attachmentId),
                  mediaType: ref.mediaType,
                  bytes: ref.bytes,
                  width: ref.width,
                  height: ref.height,
                }
              : { path: entry.frame.path }),
          }
        })

        return pruneUndefined({
          frames,
          strategy,
          timestampSource: sampled.timestampSource,
          mode: 'images',
          durationSec: probe.streams.durationSec,
        }) as FramesValue
      } finally {
        await cleanupWorkDir(workDir)
        await releaseInput(resolved)
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `video_frames: ${basename(String(args.file_path ?? ''))}`,
      kind: 'other',
      rawInput: {
        note: 'samples frames synchronously; images come back with this result',
        ...(args.strategy ? { strategy: String(args.strategy) } : {}),
        ...(args.max_frames !== undefined ? { max_frames: args.max_frames } : {}),
      },
    }),
    presentResult: (_args, result) => {
      // 回放路径：render 已在当时产出内容，这里从持久化的 meta 重建视图。
      const meta = result.meta as FramesMeta | undefined
      if (!meta) return { card: 'generic', title: 'video frames' }
      return {
        card: 'generic',
        title:
          meta.mode === 'images'
            ? `${meta.frames.length} frames`
            : `frames (text-only: ${meta.reason ?? 'unavailable'})`,
      }
    },
  })

  return ctx.tools.register(definition)
}
/** `render`：薄适配层——纯投影逻辑在 `src/pure/render.ts`（可单测、零宿主依赖）。 */
function renderFrames(_args: { max_frames?: number }, value: FramesValue): ContentBlock[] {
  return renderFramesPure(value, (frame) => {
    const ref = toImageRef(frame)
    // 只投影引用；真正的 bytes 由附件服务拥有。
    return ref ? { type: 'image', attachment: ref } : undefined
  }) as ContentBlock[]
}

/**
 * 把一段帧条目还原成附件引用。
 *
 * `execute` 已经拿到 `ImageAttachmentRef`；但 canonical 值必须能过
 * `output.schema` 校验（只留 id/mediaType/宽高/字节数），所以回放路径要在这里重建引用。
 */
function toImageRef(frame: FrameEntry): ImageAttachmentRef | undefined {
  if (!frame.attachmentId || !frame.mediaType) return undefined
  return {
    attachmentId: frame.attachmentId as ImageAttachmentRef['attachmentId'],
    mediaType: frame.mediaType as ImageAttachmentRef['mediaType'],
    bytes: frame.bytes ?? 0,
    width: frame.width ?? 0,
    height: frame.height ?? 0,
  }
}

/**
 * 当前路由是否声明图片输入。
 *
 * 与内置 `read_image` 同一套解析顺序（requestHeader 优先，其次 agent options），
 * 差别只在于**缺声明时的行为**：内置工具直接拒绝，本工具降级为 text-only。
 */
async function routeAcceptsImages(
  ctx: Context,
  exec: {
    agent?: {
      session: {
        requestHeader(): { config?: { provider?: string; model?: string } } | undefined
      }
      options: { provider?: string; model?: string }
    }
    signal: AbortSignal
  },
): Promise<boolean> {
  const llm = ctx.get('llm')
  if (!llm) return false
  const routed = exec.agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? exec.agent?.options.provider
  const model = routed?.model ?? exec.agent?.options.model
  if (!provider || !model) return false
  try {
    const info = await llm.resolveModelInfo(provider, model, exec.signal)
    return info.inputModalities?.includes('image') === true
  } catch {
    // 解析不出来就按"不支持"处理：降级是可恢复的，硬失败不是。
    return false
  }
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, num))
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}
