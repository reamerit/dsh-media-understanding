/**
 * 输入解析测试：本地路径 vs 链接 vs 不支持的 scheme，以及下载文件名推导。
 *
 * 重点覆盖两个会真出事的边界：
 * - **Windows 盘符**不能被当成 URL scheme（`C:\x.mp4` 不是 `c:` 协议）；
 * - 临时文件名必须保持 ASCII 安全（coding-plan R7：中文文件名与路径都有坑）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { loadPure } from './helpers.mjs'

const { classifyMediaInput, extensionOf, looksLikeMediaFile, sanitizeFileStem, suggestDownloadFileName } =
  await loadPure('resolve-input')

test('Windows 绝对路径识别为本地（不是 scheme）', () => {
  const result = classifyMediaInput('C:\\Users\\me\\video.mp4')
  assert.equal(result.kind, 'local')
  assert.equal(result.path, 'C:\\Users\\me\\video.mp4')
})

test('正斜杠的 Windows 路径同样是本地', () => {
  assert.equal(classifyMediaInput('D:/media/clip.mkv').kind, 'local')
})

test('http / https 链接识别为 remote 并带上 scheme', () => {
  const http = classifyMediaInput('http://example.com/a.mp4')
  assert.equal(http.kind, 'remote')
  assert.equal(http.scheme, 'http')

  const https = classifyMediaInput('https://www.bilibili.com/video/BV1xx411c7mD')
  assert.equal(https.kind, 'remote')
  assert.equal(https.scheme, 'https')
})

test('相对路径按本地处理（由上层去解析）', () => {
  assert.equal(classifyMediaInput('.\\clips\\a.mp4').kind, 'local')
  assert.equal(classifyMediaInput('clips/a.mp4').kind, 'local')
})

test('其它 scheme 明确拒绝，而不是当成路径', () => {
  for (const raw of ['file:///C:/x.mp4', 'ftp://host/x.mp4', 'rtsp://host/stream']) {
    const result = classifyMediaInput(raw)
    assert.equal(result.kind, 'unsupported-scheme', raw)
    assert.ok(result.scheme.length > 0)
  }
})

test('空输入单独成类', () => {
  assert.equal(classifyMediaInput('').kind, 'empty')
  assert.equal(classifyMediaInput('   ').kind, 'empty')
})

test('扩展名与媒体判断', () => {
  assert.equal(extensionOf('a/b/c.MP4'), 'mp4')
  assert.equal(extensionOf('https://x/y/z.m3u8?token=1'), 'm3u8')
  assert.equal(extensionOf('noext'), '')
  assert.equal(extensionOf('trailing.'), '')

  assert.equal(looksLikeMediaFile('a.mp4'), true)
  assert.equal(looksLikeMediaFile('a.FLAC'), true)
  assert.equal(looksLikeMediaFile('page.html'), false)
  assert.equal(looksLikeMediaFile('BV1xx411c7mD'), false)
})

test('直链 URL 的文件名取自路径末段', () => {
  assert.equal(
    suggestDownloadFileName('https://cdn.example.com/media/lecture-01.mp4'),
    'lecture-01.mp4',
  )
})

test('无扩展名的页面链接补 .mp4（ffmpeg 需要扩展名推断容器）', () => {
  const name = suggestDownloadFileName('https://www.bilibili.com/video/BV1xx411c7mD?p=1')
  assert.ok(name.endsWith('.mp4'), name)
  assert.equal(name, 'BV1xx411c7mD.mp4')
})

test('纯主机名 URL 退化为 host + 时间戳', () => {
  const name = suggestDownloadFileName('https://example.com/', new Date('2026-10-16T12:34:56Z'))
  assert.ok(name.startsWith('example.com-20261016123456'), name)
  assert.ok(name.endsWith('.mp4'))
})

test('文件名清洗成 ASCII 安全（中文/空格/控制字符都压掉）', () => {
  assert.equal(sanitizeFileStem('中文 视频 名称'), 'media')
  assert.equal(sanitizeFileStem('a b:c*d?e'), 'a_b_c_d_e')
  assert.equal(sanitizeFileStem(''), 'media')
  assert.equal(sanitizeFileStem('...'), 'media')
})

test('清洗后的名字不以点结尾（Windows 会拒写）且长度有上限', () => {
  const long = suggestDownloadFileName(`https://x.com/${'a'.repeat(200)}.mp4`)
  assert.ok(long.length <= 70, String(long.length))
  assert.ok(!long.endsWith('.'))
  assert.ok(long.endsWith('.mp4'))
})
