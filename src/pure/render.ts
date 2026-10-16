/**
 * 工具结果的**纯投影**（`output.render`）。
 *
 * 为什么单独成文件：`render` 必须是纯函数（coding-plan §5 的硬约束：不读文件、不编码、
 * 不 spawn），而它又是**唯一**能被模型看到的那一面——canonical 值模型看不到。
 * 本轮就栽在这里两次：
 *
 * 1. 取消/失败时结构化字段没进 render，模型只能看到一句英文描述，
 *    于是把 `reason` 猜成了 `note` 的内容；
 * 2. "无音轨"分支渲成 `job  (model small, …)`（空 jobId + 双空格），
 *    因为值本身自相矛盾（`status: 'running'` 配空 jobId）。
 *
 * 抽出来之后，这些文案都能被 `test/render.test.mjs` 断言——纯逻辑、零宿主依赖。
 *
 * ⚠️ 本文件**故意不 import 任何 `@deepseek-ai/*`**（包括类型）：它是被单独打包的纯逻辑
 * 入口，供测试脱离宿主加载。因此 `ContentBlock` 用本地最小结构描述，由调用方
 * （`tools/frames.ts`）在边界上投影成真正的 ContentBlock。
 */

/** 与 `@deepseek-ai/dsh-llm` 的 ContentBlock 结构兼容的最小形状（仅 render 用到的两种）。 */
export type RenderBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly attachment: unknown }

/** 与 `tools/transcribe.ts` 的 TranscribeValue 对应（只声明渲染需要的字段）。 */
export interface TranscribeRenderValue {
  readonly jobId: string
  readonly status: 'running' | 'not-started'
  readonly backend: string
  readonly model: string
  readonly device: string
  readonly source: string
  readonly note: string
  readonly reason?: string
}

/** 与 `tools/frames.ts` 的 FramesValue 对应。 */
export interface FramesRenderValue {
  readonly frames: ReadonlyArray<{
    readonly index: number
    readonly timestampSec: number
    readonly attachmentId?: string
    readonly bytes?: number
    readonly width?: number
    readonly height?: number
    readonly path?: string
  }>
  readonly strategy: string
  readonly timestampSource: 'exact' | 'estimated'
  readonly mode: 'images' | 'text-only'
  readonly reason?: string
  readonly durationSec: number
  readonly note?: string
}

/** `HH:MM:SS.s` / `MM:SS.s`。 */
export function formatTime(seconds: number): string {
  const total = Math.max(0, seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = s.toFixed(1).padStart(4, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/**
 * 转录工具的 render。
 *
 * 两种形态都**必须**把结构化字段写出来：
 * - 起了作业：`status: running | jobId: … | model | device | source`
 * - 没起作业（无音轨/输入问题）：`status: not-started | … | reason: …`
 *   并明确说"没有起作业"，绝不能渲成 `job  (…)`。
 */
export function renderTranscribe(value: TranscribeRenderValue): string {
  const facts = [
    `status: ${value.status}`,
    ...(value.jobId ? [`jobId: ${value.jobId}`] : []),
    `model: ${value.model}`,
    `device: ${value.device}`,
    `source: ${value.source}`,
    ...(value.reason ? [`reason: ${value.reason}`] : []),
  ]
  const head = value.jobId
    ? `transcription started as job ${value.jobId}`
    : 'no transcription job was started'
  return `${head}\n${facts.join(' | ')}\n${value.note}`
}

/**
 * 抽帧工具的 render：事实行 + （仅在真有估算帧时才有的）估算提醒 + 时间戳/图片块。
 *
 * ⚠️ 估算提醒的触发条件是"**有帧**且时间戳是估算"：零帧时谈"时间戳是估算"是无意义的，
 * 会误导模型去讨论一个不存在的时间轴。
 */
export function renderFrames(
  value: FramesRenderValue,
  toImageBlock: (frame: FramesRenderValue['frames'][number]) => RenderBlock | undefined,
): RenderBlock[] {
  const blocks: RenderBlock[] = []

  const header =
    value.mode === 'images'
      ? `${value.frames.length} frame(s) from ${value.strategy} sampling.`
      : `No inline images: ${value.note ?? value.reason ?? 'unavailable'}`
  blocks.push({ type: 'text', text: header })

  const facts = [
    `mode: ${value.mode}`,
    `strategy: ${value.strategy}`,
    `timestampSource: ${value.timestampSource}`,
    `durationSec: ${value.durationSec.toFixed(2)}`,
    ...(value.reason ? [`reason: ${value.reason}`] : []),
  ]
  blocks.push({ type: 'text', text: facts.join(' | ') })

  if (value.frames.length > 0 && value.timestampSource === 'estimated') {
    blocks.push({
      type: 'text',
      text:
        'timestamps are ESTIMATED (ffmpeg did not report pts_time for these frames); ' +
        'do not treat them as exact.',
    })
  }

  if (value.mode === 'text-only' && value.frames.length > 0) {
    blocks.push({
      type: 'text',
      text: value.frames
        .map((frame) => `- ${formatTime(frame.timestampSec)} → ${frame.path ?? '(no path)'}`)
        .join('\n'),
    })
    return blocks
  }

  for (const frame of value.frames) {
    blocks.push({ type: 'text', text: `[${formatTime(frame.timestampSec)}]` })
    const image = toImageBlock(frame)
    if (image) blocks.push(image)
  }
  return blocks
}
