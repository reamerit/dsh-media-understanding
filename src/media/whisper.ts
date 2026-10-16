/**
 * whisper 侧：环境探测、设备/计算档解析、Python worker 调用。
 *
 * 设计要点：
 * - **探测与决策分离**：Python 探针只报事实（`python/src/workers/probe.py`），
 *   决策（用不用卡、用哪个计算档）在 `src/pure/device.ts` 里，纯函数、可单测。
 * - **无卡必须照跑**：任何 CUDA 探测失败都不抛错，只记 `reason`（coding-plan §5.1.0）。
 * - **只 import 不算数**：探针会真的构造一次原生对象；而这里只认探针的结论。
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'

import {
  resolveDevice,
  type DeviceProbe,
  type DeviceResolution,
  type DeviceRequest,
} from '../pure/device.js'
import { classifyFailure, describeError, type ClassifiedError } from '../pure/errors.js'
import { runCommand } from './exec.js'

export interface WhisperConfig {
  /** Python 解释器路径；缺省 `python`（走宿主解析）。 */
  readonly pythonPath?: string
  /** 模型规格：tiny/base/small/medium/large-v3。 */
  readonly model?: string
  /** `auto` | `cuda` | `cpu`。 */
  readonly device?: string
  /** `auto` | int8 | int8_float32 | float16 | float32 … */
  readonly computeType?: string
  readonly modelCacheDir?: string
  readonly localFilesOnly?: boolean
  /** worker 的子进程预算（毫秒），覆盖下载 + 长音频。 */
  readonly timeoutMs?: number
}

export const DEFAULT_WHISPER: Required<
  Pick<WhisperConfig, 'model' | 'device' | 'computeType' | 'localFilesOnly'>
> = {
  model: 'small',
  device: 'auto',
  computeType: 'auto',
  localFilesOnly: false,
}

interface ProbeModuleEntry {
  imported: boolean
  version: string | null
  exercised?: boolean | null
  error: string | null
  majorVersion?: number | null
  compatibleWithFasterWhisper?: boolean
}

export interface PythonProbeResult {
  readonly ok: boolean
  readonly python: { version: string; executable: string }
  readonly modules: Record<string, ProbeModuleEntry>
  readonly cuda: {
    deviceCount: number | null
    supportedComputeTypes: string[] | null
    error: string | null
  }
  readonly cpuComputeTypes: string[] | null
  readonly models: { cached: string[] | null; dir: string | null; error: string | null }
  readonly errors: Array<Record<string, unknown>>
}

export interface EnvironmentReport {
  readonly probe: PythonProbeResult | null
  readonly resolution: DeviceResolution
  readonly error?: ClassifiedError
  /** GPU 摘要（`nvidia-smi` 能答就给），取不到为 null。 */
  readonly gpu: GpuSummary | null
  readonly ffmpegReady: boolean
  readonly ffprobeReady: boolean
  readonly avCompatible: boolean | null
  readonly fasterWhisperReady: boolean
  readonly cachedModels: readonly string[]
  readonly modelCached: boolean
}

/**
 * GPU 摘要。
 *
 * ⚠️ 可选字段一律用 `undefined` 而不是 `null`：这些值直接进 `output.schema`
 * 的 optional 语义，`null` 会被 `valueSchemaSpecToJsonSchema` 推出的类型拒绝。
 */
export interface GpuSummary {
  readonly name: string
  readonly memoryMiB?: number
  readonly driverVersion?: string
  readonly computeCapability?: string
}

/**
 * 探针脚本路径。
 *
 * ⚠️ `workerDir` 已经是 **workers 目录本身**（由 `index.ts` 的 `workersDir()` 定位并断言过），
 * 所以这里**只拼文件名，绝不再拼 `workers`**。历史上这里多拼了一次，得到
 * `<pkg>/src/workers/workers/probe.py`，症状是"探针全空、设备落 CPU"，极难定位。
 */
function probeScriptPath(workerDir: string): string {
  return join(workerDir, 'probe.py')
}

/** 转录 worker 路径；与探针同目录，取同一份 `workerDir` 保证不会各算各的。 */
function transcribeScriptPath(workerDir: string): string {
  return join(workerDir, 'transcribe.py')
}

/**
 * 把 Python 探针的事实翻译成"设备决策"的输入。
 *
 * 注意 `cudaCountError` / `probeError` 的区分：前者是"驱动/设备层面拿不到"，
 * 后者是"连 ctranslate2 都 import 不了"——两者的 `reason` 不同，便于现场排查。
 */
export function toDeviceProbe(probe: PythonProbeResult | null): DeviceProbe {
  if (!probe) return { probeError: 'probe-unavailable' }
  const supported: Record<string, readonly string[]> = {}
  if (probe.cpuComputeTypes) supported['cpu'] = probe.cpuComputeTypes
  if (probe.cuda.supportedComputeTypes) supported['cuda'] = probe.cuda.supportedComputeTypes

  return {
    cudaDeviceCount: probe.cuda.deviceCount ?? 0,
    cudaCountError: probe.cuda.error ?? undefined,
    supportedComputeTypes: supported,
  }
}

/**
 * 断言 worker 脚本确实存在。
 *
 * ⚠️ 这条断言来自一个代价很高的真实故障：`workersDir()` 与 `probeScriptPath()` 各自
 * 拼了一次 `workers`，最终路径是 `<pkg>/src/workers/workers/probe.py`。python 立刻以
 * "打不开文件"退出、stdout 为空，于是探针看起来像"这台机器没装依赖"——设备静默落 CPU、
 * `fasterWhisper.ready: false`，而 shell 里手跑同一脚本一切正常。**路径错误绝不该伪装成
 * 环境缺失**，所以这里直接抛错，并带上实际路径。
 */
function assertWorkerScript(scriptPath: string): void {
  if (!existsSync(scriptPath)) {
    throw new Error(
      `media worker script not found: ${scriptPath}. This is a packaging/path bug, not a ` +
        `missing dependency — the plugin could not locate its own Python worker.`,
    )
  }
}

/** 跑一次 Python 探针。脚本缺失直接抛错；探针自身失败不抛错，返回 null 让上层如实回报。 */
export async function runPythonProbe(
  ctx: Context,
  config: WhisperConfig,
  workerDir: string,
  signal?: AbortSignal,
): Promise<{ probe: PythonProbeResult | null; error?: ClassifiedError }> {
  const script = probeScriptPath(workerDir)
  assertWorkerScript(script)

  const result = await runCommand(ctx, {
    command: config.pythonPath ?? 'python',
    argv: [script],
    signal,
    timeoutMs: 120_000,
    missingKind: config.pythonPath ? undefined : 'python',
    env: { PYTHONIOENCODING: 'utf-8' },
  })

  if (!result.ok && !result.stdout.trim()) {
    return {
      probe: null,
      error:
        result.error ??
        classifyFailure({ stderr: result.stderr, exitCode: result.exitCode ?? undefined }),
    }
  }

  try {
    return { probe: JSON.parse(result.stdout) as PythonProbeResult }
  } catch {
    return { probe: null, error: describeError('unknown') }
  }
}

/** 读 `nvidia-smi` 摘要；没有卡就返回 null（不是错误）。 */
export async function readGpuSummary(ctx: Context, signal?: AbortSignal): Promise<GpuSummary | null> {
  const result = await runCommand(ctx, {
    command: 'nvidia-smi',
    argv: [
      '--query-gpu=name,memory.total,driver_version,compute_cap',
      '--format=csv,noheader,nounits',
    ],
    signal,
    timeoutMs: 15_000,
  })
  if (!result.ok) return null
  const line = result.stdout.split(/\r?\n/).find((l) => l.trim() !== '')
  if (!line) return null
  const [name, memory, driver, cap] = line.split(',').map((part) => part.trim())
  if (!name) return null
  const memoryMiB = memory && /^\d+$/.test(memory) ? Number(memory) : undefined
  return {
    name,
    ...(memoryMiB !== undefined ? { memoryMiB } : {}),
    ...(driver ? { driverVersion: driver } : {}),
    ...(cap ? { computeCapability: cap } : {}),
  }
}

/**
 * 汇总环境：探针 + 设备解析 + GPU 摘要 + 模型缓存。
 *
 * `ffmpegReady`/`ffprobeReady` 只做"能不能解析到可执行文件"，不做重量级调用；
 * 可执行文件路径不从这里猜——`ctx` 上没有 subprocess 配置访问器，ffmpeg/ffprobe
 * 的覆盖值由调用方（工具层）从插件 Config 传入。
 */
export async function inspectEnvironment(
  ctx: Context,
  config: WhisperConfig,
  workerDir: string,
  signal?: AbortSignal,
  executables: { ffmpegPath?: string; ffprobePath?: string } = {},
): Promise<EnvironmentReport> {
  const [probeOutcome, gpu, ffmpegPath, ffprobePath] = await Promise.all([
    runPythonProbe(ctx, config, workerDir, signal),
    readGpuSummary(ctx, signal),
    resolveQuietly(ctx, executables.ffmpegPath ?? 'ffmpeg', signal),
    resolveQuietly(ctx, executables.ffprobePath ?? 'ffprobe', signal),
  ])

  const probe = probeOutcome.probe
  const deviceRequest = normalizeDevice(config.device)
  const resolution = resolveDevice(deviceRequest, toDeviceProbe(probe))

  const fasterWhisper = probe?.modules?.['faster_whisper']
  const av = probe?.modules?.['av']
  const cachedModels = probe?.models?.cached ?? []
  const model = config.model ?? DEFAULT_WHISPER.model

  return {
    probe,
    resolution,
    error: probeOutcome.error,
    gpu,
    ffmpegReady: ffmpegPath !== null,
    ffprobeReady: ffprobePath !== null,
    avCompatible: av?.compatibleWithFasterWhisper ?? null,
    fasterWhisperReady: fasterWhisper?.imported === true,
    cachedModels,
    modelCached: cachedModels.includes(model),
  }
}

async function resolveQuietly(
  ctx: Context,
  command: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    return await ctx.subprocess.resolveExecutable(command, undefined, signal)
  } catch {
    return null
  }
}

function normalizeDevice(value: string | undefined): DeviceRequest {
  return value === 'cuda' || value === 'cpu' ? value : 'auto'
}

export interface TranscribeOptions {
  readonly audioPath: string
  readonly model: string
  readonly device: string
  readonly computeType: string
  readonly language?: string
  readonly translateToEnglish?: boolean
  readonly localFilesOnly?: boolean
  readonly modelCacheDir?: string
  readonly beamSize?: number
  /** 覆盖最终计算档（`computeType: auto` 时由调用方传入解析结果）。 */
  readonly maxSegments?: number
}

export interface TranscriptSegment {
  readonly start: number
  readonly end: number
  readonly text: string
}

export interface TranscriptResult {
  readonly text: string
  readonly language: string
  readonly durationSec: number
  readonly segments: readonly TranscriptSegment[]
  readonly truncated: boolean
}

export interface TranscribeOutcome {
  readonly result?: TranscriptResult
  readonly error?: ClassifiedError
  readonly stderrTail: string
}

/**
 * 调 Python worker 转录一个 16k 单声道 WAV。
 *
 * worker 把 JSON 写到 `--out` 文件而不是 stdout：长转录的 JSON 会被 collect
 * 上限截断（stdout 1 MiB），落文件才安全。
 */
export async function transcribeWithWorker(
  ctx: Context,
  config: WhisperConfig,
  workerDir: string,
  options: TranscribeOptions,
  signal?: AbortSignal,
  onProgress?: (line: string) => void,
): Promise<TranscribeOutcome> {
  const workDir = await mkdtempQuiet()
  const outPath = join(workDir, 'result.json')
  const workerScript = transcribeScriptPath(workerDir)
  assertWorkerScript(workerScript)
  const argv = [
    workerScript,
    '--audio', options.audioPath,
    '--out', outPath,
    '--model', options.model,
    '--device', options.device,
    '--compute-type', options.computeType,
  ]
  if (options.language) argv.push('--language', options.language)
  if (options.translateToEnglish) argv.push('--translate-to-english')
  if (options.localFilesOnly) argv.push('--local-files-only')
  if (options.modelCacheDir) argv.push('--model-cache-dir', options.modelCacheDir)
  if (options.beamSize !== undefined) argv.push('--beam-size', String(options.beamSize))
  if (options.maxSegments !== undefined) argv.push('--max-segments', String(options.maxSegments))

  onProgress?.('loading model and transcribing')

  const result = await runCommand(ctx, {
    command: config.pythonPath ?? 'python',
    argv,
    signal,
    timeoutMs: config.timeoutMs ?? 60 * 60_000,
    missingKind: config.pythonPath ? undefined : 'python',
    env: { PYTHONIOENCODING: 'utf-8' },
  })

  try {
    if (!result.ok) {
      return {
        error:
          result.error ??
          classifyFailure({ stderr: result.stderr, exitCode: result.exitCode ?? undefined }),
        stderrTail: tail(result.stderr, 4000),
      }
    }
    const { readFile } = await import('node:fs/promises')
    const parsed = JSON.parse(await readFile(outPath, 'utf8')) as TranscriptResult & {
      error?: string
    }
    if (parsed.error) {
      return {
        error: classifyFailure({ stderr: parsed.error }),
        stderrTail: tail(parsed.error, 4000),
      }
    }
    return { result: parsed, stderrTail: tail(result.stderr, 4000) }
  } catch (error) {
    return {
      error: classifyFailure({ stderr: String(error) }),
      stderrTail: tail(result.stderr, 4000),
    }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function mkdtempQuiet(): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises')
  return mkdtemp(join(tmpdir(), 'dsh-media-transcribe-'))
}

function tail(text: string, max: number): string {
  return text.length <= max ? text : text.slice(text.length - max)
}

/** 保证目录存在（模型缓存目录等）。 */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true }).catch(() => undefined)
}

/** 写一个临时文本文件（诊断用）。 */
export async function writeTempText(name: string, text: string): Promise<string> {
  const dir = await mkdtempQuiet()
  const path = join(dir, name)
  await writeFile(path, text, 'utf8')
  return path
}
