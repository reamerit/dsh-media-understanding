/**
 * ffmpeg / ffprobe 封装：流探测、抽音轨、场景抽帧（含时间戳解析）。
 *
 * 命令形状来自 coding-plan C4a（本机已实测通过），两个不可忽略的细节：
 * - **不要用 `-vsync`**（ffmpeg 6.0 已废弃、9.0 已移除）→ 统一 `-fps_mode vfr`（5.1+ 通用）；
 * - 时间戳靠 `metadata=mode=print` 把被选中帧的 `pts_time` 打到 stderr，与输出文件 1:1；
 *   解析失败时必须如实标 `estimated`，不假装精确。
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'

import { classifyFailure, describeError, type ClassifiedError } from '../pure/errors.js'
import { pairTimestamps, parseSceneTimestamps, type PairingResult } from '../pure/timestamps.js'
import { cleanupSpill, runCommand, type RunResult } from './exec.js'

export interface FfmpegConfig {
  /** 覆盖解析结果的可执行文件路径。 */
  readonly ffmpegPath?: string
  readonly ffprobePath?: string
  /** 子进程时间预算（毫秒）。 */
  readonly timeoutMs?: number
}

export interface MediaStreams {
  readonly hasVideo: boolean
  readonly hasAudio: boolean
  readonly durationSec: number
  readonly width?: number
  readonly height?: number
  readonly videoCodec?: string
  readonly audioCodec?: string
}

export interface ProbeOutcome {
  readonly streams: MediaStreams | null
  readonly error?: ClassifiedError
}

interface FfprobeJson {
  readonly streams?: ReadonlyArray<{
    readonly codec_type?: string
    readonly codec_name?: string
    readonly width?: number
    readonly height?: number
  }>
  readonly format?: { readonly duration?: string }
}

/** 用 ffprobe 读流信息；返回结构化结果而不是抛错，由调用方决定语义。 */
export async function probeMedia(
  ctx: Context,
  input: string,
  config: FfmpegConfig = {},
  signal?: AbortSignal,
): Promise<ProbeOutcome> {
  const result = await runCommand(ctx, {
    command: config.ffprobePath ?? 'ffprobe',
    argv: [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      input,
    ],
    signal,
    timeoutMs: config.timeoutMs ?? 60_000,
    missingKind: config.ffprobePath ? undefined : 'ffprobe',
  })

  if (!result.ok) {
    return {
      streams: null,
      error:
        result.error ??
        classifyFailure({ stderr: result.stderr, exitCode: result.exitCode ?? undefined }),
    }
  }

  let parsed: FfprobeJson
  try {
    parsed = JSON.parse(result.stdout) as FfprobeJson
  } catch (error) {
    return { streams: null, error: describeError('ffmpeg-failed') }
  }

  const streams = parsed.streams ?? []
  const video = streams.find((s) => s.codec_type === 'video')
  const audio = streams.find((s) => s.codec_type === 'audio')
  const durationRaw = parsed.format?.duration
  const durationSec = durationRaw ? Number(durationRaw) : 0

  return {
    streams: {
      hasVideo: Boolean(video),
      hasAudio: Boolean(audio),
      durationSec: Number.isFinite(durationSec) ? durationSec : 0,
      width: video?.width,
      height: video?.height,
      videoCodec: video?.codec_name,
      audioCodec: audio?.codec_name,
    },
  }
}

export interface ExtractedAudio {
  /** 抽出的 16k 单声道 WAV；调用方 **必须** 在 finally 里删掉整个 workDir。 */
  readonly wavPath: string
  readonly workDir: string
  readonly error?: ClassifiedError
}

/** 抽音轨到 16 kHz 单声道 WAV（whisper 的输入形状）。 */
export async function extractAudio(
  ctx: Context,
  input: string,
  config: FfmpegConfig = {},
  signal?: AbortSignal,
): Promise<ExtractedAudio> {
  const workDir = await mkdtemp(join(tmpdir(), 'dsh-media-'))
  const wavPath = join(workDir, 'audio.wav')

  const result = await runCommand(ctx, {
    command: config.ffmpegPath ?? 'ffmpeg',
    argv: [
      '-hide_banner',
      '-nostdin',
      '-i', input,
      '-vn',
      '-ar', '16000',
      '-ac', '1',
      '-c:a', 'pcm_s16le',
      '-y', wavPath,
    ],
    signal,
    timeoutMs: config.timeoutMs ?? 30 * 60_000,
    missingKind: config.ffmpegPath ? undefined : 'ffmpeg',
  })

  if (!result.ok) {
    await cleanupSpill(result.spillPath)
    await rm(workDir, { recursive: true, force: true })
    return {
      wavPath,
      workDir,
      error: result.error ?? describeError('ffmpeg-failed'),
    }
  }
  return { wavPath, workDir }
}

export interface SampledFrame {
  readonly index: number
  readonly timestampSec: number
  readonly path: string
  readonly estimated: boolean
}

export interface SampleFramesOutcome {
  readonly frames: SampledFrame[]
  readonly workDir: string
  /** `exact` = 时间戳来自 stderr；`estimated` = 解析不到，按 fps 估算。 */
  readonly timestampSource: 'exact' | 'estimated'
  readonly pairing?: PairingResult
  readonly error?: ClassifiedError
}

export interface SampleFramesOptions {
  readonly strategy?: 'scene' | 'fps'
  readonly threshold?: number
  readonly fps?: number
  readonly maxFrames?: number
  readonly jpegQuality?: number
  /** 与 `attachments.imageLimits` 取小值后的宽度上限。 */
  readonly maxWidth?: number
  /** ffprobe 报的时长，仅用于 fps 策略下的估算兜底。 */
  readonly durationSec?: number
}

/**
 * 抽帧。
 *
 * - `strategy: 'scene'`（默认）：`select='gt(scene,TH)'` + `metadata=mode=print`；
 * - `strategy: 'fps'`：固定采样，命令更简单，仍复用同一套时间戳解析。
 *
 * 输出文件名固定 `f_%04d.jpg`，序号与 stderr 里的 `pts_time` **同序**。
 */
export async function sampleFrames(
  ctx: Context,
  input: string,
  options: SampleFramesOptions = {},
  config: FfmpegConfig = {},
  signal?: AbortSignal,
): Promise<SampleFramesOutcome> {
  const strategy = options.strategy ?? 'scene'
  const threshold = options.threshold ?? 0.3
  const maxFrames = Math.max(1, options.maxFrames ?? 16)
  const maxWidth = options.maxWidth ?? 1280
  const quality = options.jpegQuality ?? 3
  const fps = options.fps ?? 1

  const workDir = await mkdtemp(join(tmpdir(), 'dsh-media-frames-'))
  const outputPattern = join(workDir, 'f_%04d.jpg')
  // 宽高都用 min(limit, iw) 并保持偶数高度：jpeg 需要偶数？不必，但 -2 是 ffmpeg 约定。
  const scale = `scale='min(${maxWidth},iw)':-2`

  // ⚠️ 时间戳打印机必须用 **`showinfo`**，不能用 `metadata=mode=print`：
  // 本机 ffmpeg 6.0 实测 `metadata=mode=print` **不输出 `pts_time`**（只有普通的
  // "Metadata:" 行），于是所有时间戳都退化成按 fps 估算——而估算值在 fps 采样下
  // 看似正确，在场景采样下则完全对不上，属于"静默失准"。
  // `showinfo` 每个被输出帧打一行，含 `n: <序号> pts: … pts_time:<秒>`，与输出文件 1:1。
  const filter =
    strategy === 'fps'
      ? `fps=${fps},showinfo,${scale}`
      : `select='gt(scene,${threshold})',showinfo,${scale}`

  const argv = [
    '-hide_banner',
    '-nostdin',
    '-i', input,
    '-vf', filter,
    // ⚠️ 不用 -vsync（6.0 已废弃 / 9.0 已移除）：5.1+ 统一用 -fps_mode
    '-fps_mode', 'vfr',
    '-frames:v', String(maxFrames),
    '-q:v', String(quality),
    '-y', outputPattern,
  ]

  const result = await runCommand(ctx, {
    command: config.ffmpegPath ?? 'ffmpeg',
    argv,
    signal,
    timeoutMs: config.timeoutMs ?? 10 * 60_000,
    missingKind: config.ffmpegPath ? undefined : 'ffmpeg',
  })

  // 即使 ffmpeg 非零退出，也可能已经落了部分帧（例如 select 到尾），先看文件再说。
  let files: string[] = []
  try {
    files = (await readdir(workDir))
      .filter((name) => name.startsWith('f_') && name.endsWith('.jpg'))
      .sort()
  } catch {
    files = []
  }

  const parsed = parseSceneTimestamps(result.stderr)
  const pairing = pairTimestamps(files.length, parsed.timestamps, fps)
  const frames: SampledFrame[] = pairing.pairs.map((pair, i) => ({
    index: i,
    timestampSec: pair.timestampSec,
    path: join(workDir, files[i]!),
    estimated: pair.estimated,
  }))

  await cleanupSpill(result.spillPath)

  if (!result.ok && files.length === 0) {
    return {
      frames: [],
      workDir,
      timestampSource: 'estimated',
      error:
        result.error ??
        classifyFailure({ stderr: result.stderr, exitCode: result.exitCode ?? undefined }),
    }
  }

  return {
    frames,
    workDir,
    timestampSource: parsed.source === 'exact' ? 'exact' : 'estimated',
    pairing,
  }
}

/** 清理抽帧/抽音轨用的临时目录（必须在 finally 里调）。 */
export async function cleanupWorkDir(dir: string | undefined): Promise<void> {
  if (!dir) return
  try {
    await rm(dir, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响主流程 */
  }
}

/** 方便上层判断：一次 RunResult 是否值得当"基础设施故障"抛出。 */
export function isInfrastructureFailure(result: RunResult): boolean {
  return result.error?.infrastructure === true
}
