/**
 * 抽帧时间戳解析测试（coding-plan C4a）。
 *
 * 用的是**本机实测的真实 ffmpeg stderr 形状**（`metadata=mode=print` 打到 stderr
 * 的两行一组），而不是编造的格式——这条通路当初就是"看着能解析、其实时间戳全 0"
 * 的重灾区，样本必须是真的。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { loadPure } from './helpers.mjs'

const { parseSceneTimestamps, estimateTimestamps, pairTimestamps } = await loadPure('timestamps')

// 实测样本（本机 ffmpeg 6.0）：showinfo 每个被输出帧一行，n 与 pts_time 同序。
// ⚠️ 这里刻意用 showinfo 而不是 metadata=mode=print——后者在本机**不输出 pts_time**，
// 曾导致所有时间戳静默退化成按 fps 估算。
const REAL_SHOWINFO = [
  "[Parsed_showinfo_1 @ 0000022f24787b80] n:   0 pts:      0 pts_time:0 duration:      1 duration_time:1       pos:   85183 fmt:yuv420p sar:1/1 s:640x360 i:P iskey:0 type:P checksum:0909AF2B",
  "[Parsed_showinfo_1 @ 0000022f24787b80] n:   1 pts:      1 pts_time:1 duration:      1 duration_time:1       pos:  171916 fmt:yuv420p sar:1/1 s:640x360 i:P iskey:0 type:B checksum:83FA89B3",
  'frame=    2 fps=0.0 q=3.0 Lsize=N/A time=00:00:02.00 bitrate=N/A speed=   0x',
].join('\n')

// 场景选择下的实测形态：选中帧在 t=4.2 / t=6.2
const REAL_SCENE = [
  "[Parsed_showinfo_1 @ 000001c9] n:   0 pts:   43008 pts_time:4.2 duration: 1 duration_time:1",
  "[Parsed_showinfo_1 @ 000001c9] n:   1 pts:   63488 pts_time:6.2 duration: 1 duration_time:1",
].join('\n')

test('从真实 showinfo 输出里按顺序抽出 pts_time（并标明来源）', () => {
  const parsed = parseSceneTimestamps(REAL_SHOWINFO)
  assert.deepEqual(parsed.timestamps, [0, 1])
  assert.equal(parsed.source, 'exact')
  assert.equal(parsed.parsedFrom, 'showinfo')
})

test('场景选择的时间戳保持原值（4.2 / 6.2），不被 fps 估算污染', () => {
  const parsed = parseSceneTimestamps(REAL_SCENE)
  assert.deepEqual(parsed.timestamps, [4.2, 6.2])
  assert.equal(parsed.parsedFrom, 'showinfo')
})

test('没有 showinfo 行时退到裸 pts_time 扫描（兼容旧打印器）', () => {
  const parsed = parseSceneTimestamps('pts_time:8.5\npts_time:1.25\n')
  assert.deepEqual(parsed.timestamps, [8.5, 1.25])
  assert.equal(parsed.parsedFrom, 'pts_time')
})

test('showinfo 优先于裸 pts_time（同一条 stderr 里两者都在时）', () => {
  const mixed = `${REAL_SHOWINFO}\npts_time:99\n`
  const parsed = parseSceneTimestamps(mixed)
  assert.deepEqual(parsed.timestamps, [0, 1])
  assert.equal(parsed.parsedFrom, 'showinfo')
})

test('顺序语义：不排序、不去重（第 i 个时间戳配第 i 个文件）', () => {
  const shuffled = 'pts_time:8.5\npts_time:1.25\npts_time:8.5\n'
  const parsed = parseSceneTimestamps(shuffled)
  assert.deepEqual(parsed.timestamps, [8.5, 1.25, 8.5])
})

test('场景分仍能被抽出（lavfi.scene_score）', () => {
  const parsed = parseSceneTimestamps(
    'lavfi.scene_score=0.400000\nlavfi.scene_score=1.000000\n',
  )
  assert.deepEqual(parsed.sceneScores, [0.4, 1])
})

test('空输入与无匹配都返回 none，由调用方去估算（不假装精确）', () => {
  assert.equal(parseSceneTimestamps('').source, 'none')
  assert.deepEqual(parseSceneTimestamps('').timestamps, [])
  assert.equal(parseSceneTimestamps('').parsedFrom, 'none')
  const noMatch = parseSceneTimestamps('frame= 10 fps=0.0 q=3.0\n')
  assert.equal(noMatch.source, 'none')
})

test('整数形式的 pts_time（无小数点）同样能解析', () => {
  assert.deepEqual(parseSceneTimestamps('pts_time:4\npts_time:6\n').timestamps, [4, 6])
})

test('估算按帧率给时间轴', () => {
  assert.deepEqual(estimateTimestamps(3, 1), [0, 1, 2])
  assert.deepEqual(estimateTimestamps(2, 2), [0, 0.5])
  assert.deepEqual(estimateTimestamps(0, 1), [])
  assert.deepEqual(estimateTimestamps(3, 0), [])
})

test('配对：时间戳齐全时全部 exact', () => {
  const paired = pairTimestamps(2, [4.2, 6.2], 1)
  assert.equal(paired.exactCount, 2)
  assert.equal(paired.estimatedCount, 0)
  assert.deepEqual(
    paired.pairs.map((p) => [p.index, p.timestampSec, p.estimated]),
    [
      [0, 4.2, false],
      [1, 6.2, false],
    ],
  )
})

test('配对：解析不足时尾部用估算补齐，并如实标 estimated', () => {
  const paired = pairTimestamps(3, [4.2], 1)
  assert.equal(paired.exactCount, 1)
  assert.equal(paired.estimatedCount, 2)
  assert.equal(paired.pairs[0].estimated, false)
  assert.equal(paired.pairs[1].estimated, true)
  assert.equal(paired.pairs[1].timestampSec, 1) // 按 fps=1 估算
  assert.equal(paired.pairs[2].timestampSec, 2)
})

test('配对：时间戳多于文件数时按文件数截断', () => {
  const paired = pairTimestamps(1, [4.2, 6.2, 9.9], 1)
  assert.equal(paired.pairs.length, 1)
  assert.equal(paired.pairs[0].timestampSec, 4.2)
})
