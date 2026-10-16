/**
 * 错误分类测试（coding-plan C4b / R3d / R3e）。
 *
 * 两条判据直接来自本机踩过的坑，测试样本就是当时的真实输出形状：
 * - MSVCP140 过旧 → `0xC0000005` **无输出**硬崩溃；
 * - 内存不足 → `mkl_malloc: failed to allocate memory`。
 * 还有一条来自上游：`av>=19` 的 `metadata_errors` TypeError。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { loadPure } from './helpers.mjs'

const { classifyFailure, describeError } = await loadPure('errors')

test('0xC0000005 且无输出 → 识别为 MSVC 运行时缺失（而不是笼统失败）', () => {
  const negative = classifyFailure({ stderr: '', stdout: '', exitCode: -1073741819 })
  assert.equal(negative.kind, 'missing-msvc-runtime')
  assert.equal(negative.infrastructure, true)
  assert.match(negative.remedy ?? '', /VC\+\+ 2015-2022/)
})

test('0xC0000005 的无符号形式同样识别', () => {
  assert.equal(classifyFailure({ stderr: '  ', exitCode: 0xc0000005 }).kind, 'missing-msvc-runtime')
})

test('退出码是 0xC0000005 但有输出时不当成硬崩溃（贴错标签比不贴更坏）', () => {
  const result = classifyFailure({ stderr: 'some real error text', exitCode: 0xc0000005 })
  assert.notEqual(result.kind, 'missing-msvc-runtime')
})

test('mkl_malloc → 内存不足，且不算基础设施故障（可以换小模型重试）', () => {
  const result = classifyFailure({
    stderr: 'RuntimeError: mkl_malloc: failed to allocate memory',
    exitCode: 1,
  })
  assert.equal(result.kind, 'out-of-memory')
  assert.equal(result.infrastructure, false)
})

test('缺 faster_whisper 的两种 ModuleNotFoundError 写法都能识别', () => {
  assert.equal(
    classifyFailure({ stderr: "ModuleNotFoundError: No module named 'faster_whisper'", exitCode: 1 })
      .kind,
    'missing-faster-whisper',
  )
  assert.equal(
    classifyFailure({ stderr: 'No module named faster_whisper', exitCode: 1 }).kind,
    'missing-faster-whisper',
  )
})

test('av>=19 的 metadata_errors TypeError → 指出要钉 av<19', () => {
  const result = classifyFailure({
    stderr: "TypeError: open() got an unexpected keyword argument 'metadata_errors'",
    exitCode: 1,
  })
  assert.equal(result.kind, 'unsupported-av-version')
  assert.match(result.remedy ?? '', /av<19/)
})

test('CUDA 不可用与 CUDA 显存不足分开', () => {
  assert.equal(
    classifyFailure({ stderr: 'RuntimeError: CUDA failed with error no CUDA-capable device is detected', exitCode: 1 })
      .kind,
    'cuda-unavailable',
  )
  assert.equal(
    classifyFailure({ stderr: 'CUDA out of memory. Tried to allocate 2.00 GiB', exitCode: 1 }).kind,
    'cuda-oom',
  )
})

test('可执行文件解析失败优先于文本匹配（此时 stderr 往往是空的）', () => {
  assert.equal(classifyFailure({ stderr: '', executableMissing: 'ffmpeg' }).kind, 'missing-ffmpeg')
  assert.equal(classifyFailure({ stderr: '', executableMissing: 'ffprobe' }).kind, 'missing-ffprobe')
  assert.equal(classifyFailure({ stderr: '', executableMissing: 'python' }).kind, 'missing-python')
})

test('yt-dlp 缺失与下载失败分开（前者要装依赖，后者是链接的问题）', () => {
  assert.equal(
    classifyFailure({ stderr: "ModuleNotFoundError: No module named 'yt_dlp'", exitCode: 1 }).kind,
    'download-tool-missing',
  )
  assert.equal(
    classifyFailure({ stderr: 'ERROR: Unable to download webpage: HTTP Error 404', exitCode: 1 }).kind,
    'download-failed',
  )
})

test('下载失败用本机实测的真实 stderr 识别（死链不该落 unknown）', () => {
  // ffmpeg 拉死链的两种真实形态
  assert.equal(
    classifyFailure({
      stderr: '[https @ 00000214079db700] HTTP error 404 Not Found',
      exitCode: 1,
    }).kind,
    'download-failed',
  )
  assert.equal(
    classifyFailure({
      stderr:
        'https://example.com/gone.mp4: Server returned 404 Not Found\nConversion failed!',
      exitCode: 1,
    }).kind,
    'download-failed',
  )
  // yt-dlp 的完整形态（含 caused by 后缀）
  assert.equal(
    classifyFailure({
      stderr:
        'ERROR: [generic] clip: Unable to download webpage: HTTP Error 404: Not Found (caused by <HTTP Error 404: Not Found>)',
      exitCode: 1,
    }).kind,
    'download-failed',
  )
  // 域名解析/连接类也归到下载失败
  assert.equal(
    classifyFailure({ stderr: 'getaddrinfo: No such host is known', exitCode: 1 }).kind,
    'download-failed',
  )
  assert.equal(
    classifyFailure({ stderr: 'Connection refused', exitCode: 1 }).kind,
    'download-failed',
  )
})

test('下载失败属业务失败：应返回 canonical 值 + reason，而不是 throw', () => {
  const result = classifyFailure({ stderr: 'HTTP error 404 Not Found', exitCode: 1 })
  assert.equal(result.infrastructure, false)
})

test('认不出的失败落 unknown，且按基础设施故障处理（宁可抛错也不静默）', () => {
  const result = classifyFailure({ stderr: 'something entirely new', exitCode: 3 })
  assert.equal(result.kind, 'unknown')
  assert.equal(result.infrastructure, true)
})

test('每个 kind 都有完整的描述（summary 永远非空）', () => {
  for (const kind of [
    'missing-ffmpeg',
    'missing-ffprobe',
    'missing-python',
    'missing-faster-whisper',
    'missing-msvc-runtime',
    'out-of-memory',
    'no-audio-track',
    'download-failed',
    'cancelled',
  ]) {
    const described = describeError(kind)
    assert.equal(described.kind, kind)
    assert.ok(described.summary.length > 0, `${kind} 缺少 summary`)
  }
})
