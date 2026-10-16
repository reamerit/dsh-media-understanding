/**
 * `media_probe` —— 环境探测工具（完全只读，Phase 1 的装载闭环验证）。
 *
 * 它存在的意义不是"给用户看信息"，而是让**模型与人**在调用出错前就能看出：
 * 这台机器能不能转录、用的是哪个设备、为什么是这个设备。coding-plan §5.1.0
 * 明确要求解析结果可见（`device` / `deviceSource` / `reason` / `gpu`）。
 *
 * 探测的纪律：**"看得到设备"不算数**——真的会去构造一次原生对象（见
 * `src/workers/probe.py`），因为本机真实发生过"import 能过、一推理就崩"。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

import type { Config } from '../index.js'
import { probeYtDlp } from '../media/download.js'
import { inspectEnvironment, type GpuSummary } from '../media/whisper.js'
import { pruneUndefined } from '../pure/json.js'

export interface ProbeToolDeps {
  readonly config: Config
  /** workers 目录（`<pkg>/src/workers`），由 `index.ts` 的 `workersDir()` 定位。 */
  readonly workerDir: string
}

/** 输出契约：可选字段一律 `undefined`（schema 的 optional 语义），不用 null。 */
interface ProbeValue {
  readonly ok: boolean
  readonly device: string
  readonly deviceSource: string
  readonly computeType: string
  readonly reason?: string
  readonly configured: { device: string; computeType: string; model: string }
  readonly python?: { version: string; executable: string }
  readonly ffmpeg: { ready: boolean }
  readonly ffprobe: { ready: boolean }
  readonly fasterWhisper: { ready: boolean; version?: string }
  readonly pyav: { version?: string; compatible?: boolean }
  readonly ctranslate2: { version?: string; exercised?: boolean }
  readonly onnxruntime: { version?: string }
  readonly gpu?: GpuSummary
  /** ⚠️ 数组字段不能用 readonly：`output.schema` 推出的是可变数组类型。 */
  cachedModels: string[]
  readonly modelCached: boolean
  readonly ytDlp: { available: boolean; version?: string }
  problems: string[]
}

export function registerProbeTool(ctx: Context, deps: ProbeToolDeps): () => void {
  const definition = defineTool({
    name: 'media_probe',
    description:
      'Report whether this machine can transcribe audio and extract video frames, and which ' +
      'execution device would be used (GPU when available, CPU otherwise). Read-only check for ' +
      'ffmpeg/ffprobe, Python, faster-whisper, PyAV version compatibility, cached Whisper models, ' +
      'CUDA availability, and the yt-dlp link downloader. Call this first when a media tool ' +
      'misbehaves or before transcribing a long recording.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          device: { type: 'string', required: true },
          deviceSource: { type: 'string', required: true },
          computeType: { type: 'string', required: true },
          reason: { type: 'string' },
          configured: {
            type: 'object',
            additionalProperties: false,
            properties: {
              device: { type: 'string', required: true },
              computeType: { type: 'string', required: true },
              model: { type: 'string', required: true },
            },
          },
          python: {
            type: 'object',
            additionalProperties: false,
            properties: {
              version: { type: 'string', required: true },
              executable: { type: 'string', required: true },
            },
          },
          ffmpeg: {
            type: 'object',
            additionalProperties: false,
            properties: { ready: { type: 'boolean', required: true } },
          },
          ffprobe: {
            type: 'object',
            additionalProperties: false,
            properties: { ready: { type: 'boolean', required: true } },
          },
          fasterWhisper: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ready: { type: 'boolean', required: true },
              version: { type: 'string' },
            },
          },
          pyav: {
            type: 'object',
            additionalProperties: false,
            properties: {
              version: { type: 'string' },
              compatible: { type: 'boolean' },
            },
          },
          ctranslate2: {
            type: 'object',
            additionalProperties: false,
            properties: {
              version: { type: 'string' },
              exercised: { type: 'boolean' },
            },
          },
          onnxruntime: {
            type: 'object',
            additionalProperties: false,
            properties: { version: { type: 'string' } },
          },
          gpu: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', required: true },
              memoryMiB: { type: 'number' },
              driverVersion: { type: 'string' },
              computeCapability: { type: 'string' },
            },
          },
          cachedModels: { type: 'array', items: { type: 'string' } },
          modelCached: { type: 'boolean', required: true },
          ytDlp: {
            type: 'object',
            additionalProperties: false,
            properties: {
              available: { type: 'boolean', required: true },
              version: { type: 'string' },
            },
          },
          problems: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderProbe(value as ProbeValue) }],
      presentationMeta: (_args, value) => pruneUndefined(value) as unknown as never,
    },
    timeoutMs: 180_000,
    isConcurrencySafe: () => true,
    execute: async (_args, exec): Promise<ProbeValue> => {
      const whisper = deps.config.whisper ?? {}
      const model = whisper.model ?? 'small'
      const wantDevice = whisper.device ?? 'auto'
      const wantCompute = whisper.computeType ?? 'auto'

      const [report, ytDlp] = await Promise.all([
        inspectEnvironment(ctx, whisper, deps.workerDir, exec.signal, {
          ffmpegPath: deps.config.ffmpeg?.path,
          ffprobePath: deps.config.ffprobe?.path,
        }),
        probeYtDlp(ctx, { pythonPath: whisper.pythonPath, ...deps.config.download }, exec.signal),
      ])

      const modules = report.probe?.modules ?? {}
      const versionOf = (key: string): string | undefined => modules[key]?.version ?? undefined

      const problems: string[] = []
      if (!report.ffmpegReady) problems.push('ffmpeg not found on PATH (or config.ffmpeg.path)')
      if (!report.ffprobeReady) problems.push('ffprobe not found on PATH (or config.ffprobe.path)')
      if (!report.fasterWhisperReady) {
        problems.push('python cannot import faster_whisper (local transcription unavailable)')
      }
      if (report.avCompatible === false) {
        problems.push('PyAV >= 19 is installed; faster-whisper 1.2.1 needs av<19')
      }
      if (!report.modelCached) {
        problems.push(
          `whisper model "${model}" is not in the local cache (first run will download it)`,
        )
      }
      if (!ytDlp.available) {
        problems.push(
          'yt-dlp is not installed: platform page links (YouTube/Bilibili) cannot be downloaded',
        )
      }
      if (report.resolution.device === 'cpu' && report.gpu) {
        problems.push('a GPU is present but CUDA is unusable: transcription will run on CPU')
      }

      // ⚠️ 必须在返回边界裁剪 undefined：宿主的值校验器遇到任何 undefined
      // 属性就整体判 "value is not lossless JSON"，且不报字段名。
      return pruneUndefined({
        ok: report.ffmpegReady && report.fasterWhisperReady,
        device: report.resolution.device,
        deviceSource: report.resolution.deviceSource,
        computeType: report.resolution.computeType,
        reason: report.resolution.reason ?? undefined,
        configured: { device: wantDevice, computeType: wantCompute, model },
        python: report.probe?.python ?? undefined,
        ffmpeg: { ready: report.ffmpegReady },
        ffprobe: { ready: report.ffprobeReady },
        fasterWhisper: {
          ready: report.fasterWhisperReady,
          ...(versionOf('faster_whisper') ? { version: versionOf('faster_whisper')! } : {}),
        },
        pyav: {
          ...(versionOf('av') ? { version: versionOf('av')! } : {}),
          ...(report.avCompatible !== null ? { compatible: report.avCompatible } : {}),
        },
        ctranslate2: {
          ...(versionOf('ctranslate2') ? { version: versionOf('ctranslate2')! } : {}),
          ...(modules['ctranslate2']?.exercised != null
            ? { exercised: modules['ctranslate2']!.exercised! }
            : {}),
        },
        onnxruntime: {
          ...(versionOf('onnxruntime') ? { version: versionOf('onnxruntime')! } : {}),
        },
        gpu: report.gpu ?? undefined,
        cachedModels: [...report.cachedModels],
        modelCached: report.modelCached,
        ytDlp: {
          available: ytDlp.available,
          ...(ytDlp.version ? { version: ytDlp.version } : {}),
        },
        problems,
      })
    },
    presentCall: () => ({ card: 'generic', title: 'media_probe' }),
    presentResult: () => ({ card: 'generic', title: 'media environment' }),
  })

  return ctx.tools.register(definition)
}

/** 人读版渲染；模型面同时拿到同一份 JSON（render 是唯一出口，必须自带全部信息）。 */
function renderProbe(value: ProbeValue): string {
  const lines: string[] = []
  lines.push(`device: ${value.device} (${value.deviceSource}) computeType: ${value.computeType}`)
  if (value.reason) lines.push(`reason: ${value.reason}`)
  if (value.gpu) {
    lines.push(
      `gpu: ${value.gpu.name}${value.gpu.memoryMiB ? ` ${value.gpu.memoryMiB} MiB` : ''}` +
        `${value.gpu.driverVersion ? ` driver ${value.gpu.driverVersion}` : ''}` +
        `${value.gpu.computeCapability ? ` cc ${value.gpu.computeCapability}` : ''}`,
    )
  }
  lines.push(
    `ffmpeg: ${value.ffmpeg.ready ? 'ready' : 'MISSING'} | ffprobe: ${value.ffprobe.ready ? 'ready' : 'MISSING'}`,
  )
  if (value.python) lines.push(`python: ${value.python.version} @ ${value.python.executable}`)
  lines.push(
    `faster-whisper: ${value.fasterWhisper.ready ? value.fasterWhisper.version ?? 'ready' : 'MISSING'}` +
      ` | pyav: ${value.pyav.version ?? 'missing'}${value.pyav.compatible === false ? ' (INCOMPATIBLE, needs av<19)' : ''}` +
      ` | ctranslate2: ${value.ctranslate2.version ?? 'missing'}${value.ctranslate2.exercised === false ? ' (IMPORT OK BUT UNUSABLE)' : ''}`,
  )
  lines.push(
    `models cached: ${value.cachedModels.length ? value.cachedModels.join(', ') : 'none'}` +
      `${value.modelCached ? '' : ` (configured "${value.configured.model}" NOT cached)`}`,
  )
  lines.push(
    `yt-dlp: ${value.ytDlp.available ? value.ytDlp.version ?? 'available' : 'MISSING (page links unavailable)'}`,
  )
  if (value.problems.length) lines.push(`problems:\n- ${value.problems.join('\n- ')}`)
  lines.push('---')
  lines.push(JSON.stringify(value, null, 2))
  return lines.join('\n')
}
