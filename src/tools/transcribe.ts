/**
 * `transcribe_audio` —— 音视频 → 带时间戳转录。**走后台作业**（coding-plan §5.1，B3 决策）。
 *
 * 为什么是后台作业而不是同步等待：本机实测 `small` 在 CPU 上 3.2× 实时、GPU 上 25×，
 * 但 1 小时录音在 CPU 上仍要 ~20 分钟。同步等待会白占一次工具调用，而 DSH 已经有
 * 现成的作业设施（模型用 `job_output` 读正文、`job_kill` 终止）。
 *
 * 契约要点：
 * - `execute` 只做**前置校验**（输入存在、有音轨、依赖可用），然后**立即**返回句柄；
 * - 转写正文经 `job.append` 写入 ring，模型用 `job_output` 读；
 * - `exec.signal` 与作业的 `cancel()` 都透传到 `ctx.subprocess`（取消即杀进程组）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

import type { Config } from '../index.js'
import { cleanupWorkDir, extractAudio, probeMedia } from '../media/ffmpeg.js'
import { releaseInput, resolveInput, type ResolvedInput } from '../media/input.js'
import {
  runPythonProbe,
  toDeviceProbe,
  transcribeWithWorker,
  type TranscriptResult,
} from '../media/whisper.js'
import { resolveDevice, type DeviceRequest } from '../pure/device.js'
import { describeError } from '../pure/errors.js'
import { pruneUndefined } from '../pure/json.js'
import { formatTime, renderTranscribe } from '../pure/render.js'
import { INPUT_PARAM_HINT } from '../pure/resolve-input.js'

export interface TranscribeToolDeps {
  readonly config: Config
  /** workers 目录（`<pkg>/src/workers`），由 `index.ts` 的 `workersDir()` 定位。 */
  readonly workerDir: string
}

/** 作业句柄（canonical 值，永远有值）。 */
interface TranscribeValue {
  /** 空串表示**没有起作业**（业务非理想结果），此时 `status` 为 `not-started`。 */
  readonly jobId: string
  /** `running` = 作业已起；`not-started` = 前置判定已给出结论，没有作业可读。 */
  readonly status: 'running' | 'not-started'
  readonly backend: 'whisper-local'
  readonly model: string
  /** 未解析出设备时给 `n/a`（例如没走到设备解析就返回了结论）。 */
  readonly device: string
  readonly source: 'local' | 'url' | 'none'
  readonly note: string
  readonly reason?: string
}

export function registerTranscribeTool(ctx: Context, deps: TranscribeToolDeps): () => void {
  const whisper = deps.config.whisper ?? {}
  const maxSegments = deps.config.transcribe?.maxSegments ?? 5000
  const jobOutputLimitBytes = deps.config.transcribe?.jobOutputLimitBytes ?? 262_144

  const definition = defineTool({
    name: 'transcribe_audio',
    description:
      'Transcribe an audio/video file or an http(s) link (direct media URL, or a platform page ' +
      'such as YouTube/Bilibili, which is downloaded with yt-dlp first) into timestamped text, ' +
      'using a local faster-whisper model (no API key, works offline). Long recordings run as a ' +
      'background job: this returns a jobId immediately, and you read the transcript with ' +
      'job_output (stop it with job_kill). Transcription runs on the GPU when one is available ' +
      'and silently falls back to CPU otherwise. Call media_probe first if you need to know which.',
    parameters: {
      file_path: {
        type: 'string',
        required: true,
        description: `${INPUT_PARAM_HINT} The link is downloaded to a temporary file before transcription.`,
      },
      language: {
        type: 'string',
        description: 'Source language code such as "zh" or "en"; omit to auto-detect.',
      },
      translate_to_english: {
        type: 'boolean',
        description: 'Translate the speech into English instead of transcribing it verbatim.',
      },
      backend: {
        type: 'string',
        enum: ['whisper-local'],
        description: 'Transcription backend. Only the local whisper model is available.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          jobId: { type: 'string', required: true },
          status: { type: 'string', required: true, enum: ['running', 'not-started'] },
          backend: { type: 'string', required: true, const: 'whisper-local' },
          model: { type: 'string', required: true },
          device: { type: 'string', required: true },
          source: { type: 'string', required: true },
          note: { type: 'string', required: true },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: renderTranscribe(value as TranscribeValue) },
      ],
      presentationMeta: (_args, value) => pruneUndefined(value) as unknown as never,
    },
    timeoutMs: 120_000,
    isConcurrencySafe: () => true,
    execute: async (args, exec): Promise<TranscribeValue> => {
      const input = String(args.file_path ?? '').trim()
      const model = whisper.model ?? 'small'

      // 前置 0：解析输入（必要时下载）。基础设施故障 throw，业务失败返回 canonical+reason。
      const outcome = await resolveInput(
        ctx,
        input,
        {
          pythonPath: whisper.pythonPath,
          ...deps.config.download,
          ffmpegPath: deps.config.ffmpeg?.path,
        },
        exec.signal,
      )
      if (!outcome.resolved) {
        const error = outcome.error ?? describeError('unknown')
        if (error.infrastructure) throw new Error(error.summary)
        return pruneUndefined({
          jobId: '',
          status: 'not-started',
          backend: 'whisper-local',
          model,
          device: 'n/a',
          source: 'url',
          note: error.summary,
          reason: error.kind,
        }) as TranscribeValue
      }
      const resolved: ResolvedInput = outcome.resolved

      // 前置 1：探流。有音轨才起作业；基础设施故障 throw。
      const probe = await probeMedia(
        ctx,
        resolved.path,
        { ffprobePath: deps.config.ffprobe?.path, ffmpegPath: deps.config.ffmpeg?.path },
        exec.signal,
      )
      if (!probe.streams) {
        await releaseInput(resolved)
        const error = probe.error ?? describeError('ffmpeg-failed')
        throw new Error(error.summary)
      }
      if (!probe.streams.hasAudio) {
        await releaseInput(resolved)
        return pruneUndefined({
          jobId: '',
          status: 'not-started',
          backend: 'whisper-local',
          model,
          device: 'n/a',
          source: resolved.kind === 'downloaded' ? 'url' : 'local',
          note: 'the input has no audio track, so there is nothing to transcribe',
          reason: 'no-audio-track',
        }) as TranscribeValue
      }

      // 前置 2：依赖可用性（实测 import，不认路径）。
      const probeOutcome = await runPythonProbe(ctx, whisper, deps.workerDir, exec.signal)
      if (!probeOutcome.probe) {
        await releaseInput(resolved)
        const error = probeOutcome.error ?? describeError('missing-python')
        throw new Error(error.summary)
      }
      const fasterWhisper = probeOutcome.probe.modules?.['faster_whisper']
      if (fasterWhisper?.imported !== true) {
        await releaseInput(resolved)
        throw new Error(describeError('missing-faster-whisper').summary)
      }

      // 设备解析：有卡用卡、无卡落 CPU（§5.1.0）。显式 cuda 而不可用才报错。
      const requested: DeviceRequest =
        whisper.device === 'cuda' || whisper.device === 'cpu' ? whisper.device : 'auto'
      const resolution = resolveDevice(requested, toDeviceProbe(probeOutcome.probe))
      const computeType =
        whisper.computeType && whisper.computeType !== 'auto'
          ? whisper.computeType
          : resolution.computeType
      if (requested === 'cuda' && resolution.device !== 'cuda') {
        await releaseInput(resolved)
        throw new Error(describeError('cuda-unavailable').summary)
      }

      const owner = exec.agent?.id
      const jobId = ctx.jobs.start({
        kind: 'transcribe',
        label: `transcribe ${basename(resolved.path)} (${model} on ${resolution.device})`,
        ...(owner ? { owner } : {}),
        outputLimitBytes: jobOutputLimitBytes,
        run: (job) => {
          const controller = new AbortController()
          // 外层取消（工具超时 / 会话中断）同样要杀掉 worker 与其 ffmpeg 子进程。
          const onOuterAbort = () => controller.abort()
          if (exec.signal.aborted) controller.abort()
          else exec.signal.addEventListener('abort', onOuterAbort, { once: true })

          const done = (async () => {
            let workDir: string | undefined
            try {
              job.updateProgress('extracting audio')
              job.append(`extracting audio track with ffmpeg\n`, { channel: 'log' })

              const extracted = await extractAudio(
                ctx,
                resolved.path,
                { ffmpegPath: deps.config.ffmpeg?.path, timeoutMs: whisper.timeoutMs },
                controller.signal,
              )
              workDir = extracted.workDir
              if (extracted.error) {
                // 取消不是失败：abort 触发的"抽轨失败"要如实报成 killed，
                // 否则用户看到的是一条与真实故障无法区分的 failed。
                if (controller.signal.aborted) {
                  job.append(`\nffmpeg stopped: job cancelled\n`, { channel: 'log' })
                  return { status: 'killed' as const, detail: 'cancelled during audio extraction' }
                }
                job.append(`\nffmpeg failed: ${extracted.error.summary}\n`, { channel: 'stderr' })
                return { status: 'failed' as const, detail: extracted.error.summary }
              }

              job.updateProgress(`transcribing with ${model}`)
              job.append(`transcribing with ${model} on ${resolution.device}/${computeType}\n`, {
                channel: 'log',
              })

              const transcribed = await transcribeWithWorker(
                ctx,
                { ...whisper, timeoutMs: whisper.timeoutMs },
                deps.workerDir,
                {
                  audioPath: extracted.wavPath,
                  model,
                  device: resolution.device,
                  computeType,
                  ...(args.language ? { language: String(args.language) } : {}),
                  ...(args.translate_to_english === true ? { translateToEnglish: true } : {}),
                  ...(whisper.localFilesOnly ? { localFilesOnly: true } : {}),
                  ...(whisper.modelCacheDir ? { modelCacheDir: whisper.modelCacheDir } : {}),
                  maxSegments,
                },
                controller.signal,
                (line) => job.updateProgress(line),
              )

              if (!transcribed.result) {
                // ⚠️ 取消语义：作业被 job_kill / 会话中断打断时，必须报 killed 而不是 failed。
                // 否则"我按了取消"与"转录真的炸了"在 job_list 里长得一模一样，
                // 用户无法判断该不该重试。这里优先看 abort 状态，而不是去看错误文本。
                if (controller.signal.aborted) {
                  job.append(`\ntranscription cancelled\n`, { channel: 'log' })
                  return { status: 'killed' as const, detail: 'cancelled' }
                }
                const error = transcribed.error ?? describeError('unknown')
                job.append(`\ntranscription failed: ${error.summary}\n`, { channel: 'stderr' })
                if (error.remedy) {
                  job.append(`fix: ${error.remedy}\n`, { channel: 'stderr' })
                }
                if (transcribed.stderrTail) {
                  job.append(`${transcribed.stderrTail}\n`, { channel: 'stderr' })
                }
                return { status: 'failed' as const, detail: error.summary }
              }

              job.append(
                renderTranscript(transcribed.result, resolved, resolution.device, computeType),
              )
              job.updateProgress('done')
              return {
                status: 'completed' as const,
                detail: `${transcribed.result.segments.length} segments`,
              }
            } catch (error) {
              job.append(`\ntranscription crashed: ${String(error)}\n`, { channel: 'stderr' })
              return { status: 'failed' as const, detail: String(error) }
            } finally {
              exec.signal.removeEventListener('abort', onOuterAbort)
              await cleanupWorkDir(workDir)
              await releaseInput(resolved)
            }
          })()

          return {
            cancel: (reason) => {
              controller.abort(reason ?? 'transcribe job cancelled')
            },
            done,
          }
        },
      })

      return pruneUndefined({
        jobId,
        status: 'running',
        backend: 'whisper-local',
        model,
        device: resolution.device,
        source: resolved.kind === 'downloaded' ? 'url' : 'local',
        note:
          'the transcript is streamed into the job output; read it with job_output using this ' +
          'jobId, or stop the job with job_kill.',
      }) as TranscribeValue
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `transcribe: ${basename(String(args.file_path ?? ''))}`,
      kind: 'other',
      rawInput: {
        // 如实说明"这是提交后台作业"：内容不会立刻回来，要用 job_output 取。
        note: 'starts a background transcription job (returns immediately)',
      },
    }),
    presentResult: (_args, result) => {
      // 回放时也从结果里把 jobId 读回来，避免只有一张没有下文的卡片。
      const meta = result.meta as { jobId?: string; device?: string } | undefined
      return {
        card: 'generic',
        title: meta?.jobId
          ? `transcription job ${meta.jobId} started${meta.device ? ` on ${meta.device}` : ''}`
          : 'transcription job started',
      }
    },
  })

  return ctx.tools.register(definition)
}

/** 转录正文：首行一句概述，随后是 `[start → end] text` 的分段时间轴。 */
function renderTranscript(
  result: TranscriptResult,
  resolved: ResolvedInput,
  device: string,
  computeType: string,
): string {
  const lines: string[] = []
  lines.push(
    `# transcript (${result.language}, ${result.durationSec.toFixed(1)}s, ` +
      `${result.segments.length} segments, ${device}/${computeType})`,
  )
  if (result.truncated) {
    lines.push(`# TRUNCATED: segment limit reached; later audio was not transcribed`)
  }
  lines.push('')
  for (const segment of result.segments) {
    lines.push(`[${formatTime(segment.start)} → ${formatTime(segment.end)}] ${segment.text.trim()}`)
  }
  if (result.segments.length === 0) {
    lines.push(result.text || '(no speech detected)')
  }
  lines.push('')
  lines.push(`source: ${resolved.kind === 'downloaded' ? resolved.raw : resolved.path}`)
  return lines.join('\n')
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}
