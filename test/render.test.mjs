/**
 * 工具结果渲染（`output.render`）的回归测试。
 *
 * `render` 是**模型唯一能看到的那一面**（canonical 值模型看不到），所以这里盯的是
 * "模型能不能拿到判断所需的事实"。两个用例都直接来自宿主里暴露过的真实缺陷：
 *
 * 1. 取消/失败时结构化字段没进 render ⇒ 模型把 `reason` 猜成了 `note` 的内容；
 * 2. "无音轨"分支渲成 `job  (model small, …)`（空 jobId + 双空格），
 *    因为值本身自相矛盾（`status: 'running'` 配空 jobId）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { loadPure } from './helpers.mjs'

const { renderTranscribe, renderFrames, formatTime } = await loadPure('render')

const textOf = (blocks) =>
  blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')

test('转录：起了作业时给出 status/jobId/model/device/source 事实行', () => {
  const text = renderTranscribe({
    jobId: 'transcribe-1',
    status: 'running',
    backend: 'whisper-local',
    model: 'small',
    device: 'cuda',
    source: 'local',
    note: 'read it with job_output',
  })
  assert.match(text, /transcription started as job transcribe-1/)
  assert.match(text, /status: running/)
  assert.match(text, /jobId: transcribe-1/)
  assert.match(text, /device: cuda/)
  assert.match(text, /read it with job_output/)
})

test('转录：没起作业时不得出现空 jobId，且必须带 reason', () => {
  const text = renderTranscribe({
    jobId: '',
    status: 'not-started',
    backend: 'whisper-local',
    model: 'small',
    device: 'n/a',
    source: 'local',
    note: 'the input has no audio track',
    reason: 'no-audio-track',
  })
  assert.match(text, /no transcription job was started/)
  assert.match(text, /status: not-started/)
  assert.match(text, /reason: no-audio-track/)
  // 回归：曾经渲成 "job  (model small, …)"——空 id 加双空格
  assert.doesNotMatch(text, /job {2}\(/)
  assert.doesNotMatch(text, /jobId:/, '未起作业时不应出现 jobId 字段')
})

test('转录：render 是纯函数（同输入两次结果一致）', () => {
  const value = {
    jobId: 'transcribe-9',
    status: 'running',
    backend: 'whisper-local',
    model: 'large-v3',
    device: 'cuda',
    source: 'url',
    note: 'n',
    reason: 'r',
  }
  assert.equal(renderTranscribe(value), renderTranscribe(value))
})

const frame = (index, timestampSec, extra = {}) => ({ index, timestampSec, ...extra })

test('抽帧：images 模式投影出文字时间戳 + image 块', () => {
  const blocks = renderFrames(
    {
      frames: [frame(0, 4.2, { attachmentId: 'sha256:aa', mediaType: 'image/jpeg' })],
      strategy: 'scene',
      timestampSource: 'exact',
      mode: 'images',
      durationSec: 8,
    },
    () => ({ type: 'image', attachment: { attachmentId: 'sha256:aa' } }),
  )
  assert.equal(blocks.filter((b) => b.type === 'image').length, 1)
  assert.match(textOf(blocks), /\[00:04\.2\]/)
  assert.match(textOf(blocks), /mode: images \| strategy: scene \| timestampSource: exact/)
})

test('抽帧：text-only 模式绝不产出 image 块，只给路径 + 时间戳', () => {
  const blocks = renderFrames(
    {
      frames: [frame(0, 1.5, { path: 'C:\\tmp\\f_0001.jpg' })],
      strategy: 'scene',
      timestampSource: 'exact',
      mode: 'text-only',
      reason: 'model-lacks-image-input',
      durationSec: 8,
      note: 'switch to an image-capable model',
    },
    () => undefined,
  )
  assert.equal(blocks.filter((b) => b.type === 'image').length, 0)
  const text = textOf(blocks)
  assert.match(text, /reason: model-lacks-image-input/)
  assert.match(text, /C:\\tmp\\f_0001\.jpg/)
})

test('抽帧：零帧时不得出现"时间戳是估算"的提醒（回归：误导模型去谈不存在的时间轴）', () => {
  const blocks = renderFrames(
    {
      frames: [],
      strategy: 'scene',
      timestampSource: 'estimated',
      mode: 'text-only',
      reason: 'no-scene-change',
      durationSec: 10,
      note: 'no scene change was detected; retry with strategy "fps"',
    },
    () => undefined,
  )
  const text = textOf(blocks)
  assert.doesNotMatch(text, /ESTIMATED/)
  assert.match(text, /reason: no-scene-change/)
})

test('抽帧：有帧且时间戳估算时必须显式提醒', () => {
  const blocks = renderFrames(
    {
      frames: [frame(0, 0, { path: 'p.jpg' })],
      strategy: 'fps',
      timestampSource: 'estimated',
      mode: 'text-only',
      durationSec: 5,
    },
    () => undefined,
  )
  assert.match(textOf(blocks), /ESTIMATED/)
})

test('时间格式化：分秒与小时两种形态', () => {
  assert.equal(formatTime(4.2), '00:04.2')
  assert.equal(formatTime(65), '01:05.0')
  assert.equal(formatTime(3661.5), '1:01:01.5')
  assert.equal(formatTime(-5), '00:00.0')
})

test('时间格式化：秒值四舍五入到 60 时写作 60.0（已知显示行为，非错误）', () => {
  // `toFixed(1)` 会把 59.95 进位成 "60.0"，于是秒位出现 60 而不是进位到分。
  // 这是**显示**层面的既有行为（模型仍能正确读出这是 60 秒），这里把它固定下来，
  // 避免以后有人"顺手改格式"时不知道影响面。
  assert.equal(formatTime(59.95), '00:60.0')
  assert.equal(formatTime(119.98), '01:60.0')
})
