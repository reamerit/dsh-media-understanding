/**
 * 链接输入：把一个 URL 变成"确实存在于本地、ffmpeg 读得动"的文件。
 *
 * 两条通路（用户已确认的需求：既支持直链也支持平台页面链接）：
 *
 * 1. **平台页面链接**（YouTube / Bilibili / 抖音…）→ **yt-dlp**（必须，ffmpeg 读不了网页）；
 * 2. **直链媒体**（`.mp4`、HLS `.m3u8`…）→ 仍优先走 **yt-dlp**：它内部用 ffmpeg 下载
 *    并处理分片、重定向、Referer；只有 yt-dlp 缺席或失败时才回退到 ffmpeg 直接拉。
 *
 * 为什么不默认用 ffmpeg 直拉：ffmpeg 对 HLS/分片/防盗链的处理远不如 yt-dlp，
 * 而 yt-dlp 恰好是这次唯一新增的依赖（`python -m pip install yt-dlp`）。
 */
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'

import { describeError, type ClassifiedError } from '../pure/errors.js'
import { suggestDownloadFileName } from '../pure/resolve-input.js'
import { cleanupSpill, runCommand } from './exec.js'

export interface DownloaderConfig {
  /** Python 解释器（yt-dlp 以模块方式调用，复用同一个解释器）。 */
  readonly pythonPath?: string
  /** 覆盖 yt-dlp 可执行文件（默认 `python -m yt_dlp`）。 */
  readonly ytDlpPath?: string
  readonly ffmpegPath?: string
  /** 单个链接的下载预算（毫秒）。 */
  readonly timeoutMs?: number
  /** 并发分片数交给 yt-dlp 自己决定时不用设；这里只限制播放列表项数。 */
  readonly maxPlaylistItems?: number
}

export interface DownloadOutcome {
  /** 落地的本地文件路径；调用方负责在 finally 里删掉 `workDir`。 */
  readonly path?: string
  readonly workDir: string
  /** 实际用的通路，便于如实回报。 */
  readonly via?: 'yt-dlp' | 'ffmpeg'
  readonly error?: ClassifiedError
  /** 供诊断：yt-dlp/ffmpeg 的 stderr 尾巴。 */
  readonly stderrTail: string
}

/** yt-dlp 是否可用（`python -m yt_dlp --version`）。 */
export async function probeYtDlp(
  ctx: Context,
  config: DownloaderConfig,
  signal?: AbortSignal,
): Promise<{ available: boolean; version: string | null }> {
  const result = await runCommand(ctx, {
    command: config.ytDlpPath ?? config.pythonPath ?? 'python',
    argv: config.ytDlpPath ? ['--version'] : ['-m', 'yt_dlp', '--version'],
    signal,
    timeoutMs: 60_000,
    env: { PYTHONIOENCODING: 'utf-8' },
  })
  const version = result.ok ? result.stdout.trim().split(/\r?\n/)[0] || null : null
  return { available: result.ok, version }
}

function isDirectMediaUrl(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase()
    return /\.(mp4|mkv|mov|webm|m4v|flv|ts|m3u8|mpd|mp3|wav|flac|m4a|aac|ogg|opus|wma)$/.test(path)
  } catch {
    return false
  }
}

/**
 * 下载一个链接到临时目录。
 *
 * 顺序：yt-dlp 优先（页面链接必须用它；直链它也更稳）→ 直链再退 ffmpeg。
 * 任何失败都返回分类结论而不是抛错（下载失败属业务失败，不该炸掉工具调用）。
 */
export async function downloadMedia(
  ctx: Context,
  url: string,
  config: DownloaderConfig,
  signal?: AbortSignal,
  onProgress?: (line: string) => void,
): Promise<DownloadOutcome> {
  const workDir = await mkdtemp(join(tmpdir(), 'dsh-media-dl-'))
  const fileName = suggestDownloadFileName(url)
  const target = join(workDir, fileName)

  const ytDlp = await probeYtDlp(ctx, config, signal)
  if (ytDlp.available) {
    onProgress?.('downloading with yt-dlp')
    const args = config.ytDlpPath
      ? [
          '--no-playlist',
          '--no-warnings',
          '--restrict-filenames',
          '--no-progress',
          '-f', 'bv*+ba/b',
          '--merge-output-format', 'mp4',
          '-o', target,
          url,
        ]
      : [
          '-m', 'yt_dlp',
          '--no-playlist',
          '--no-warnings',
          '--restrict-filenames',
          '--no-progress',
          '-f', 'bv*+ba/b',
          '--merge-output-format', 'mp4',
          '-o', target,
          url,
        ]
    const result = await runCommand(ctx, {
      command: config.ytDlpPath ?? config.pythonPath ?? 'python',
      argv: args,
      signal,
      timeoutMs: config.timeoutMs ?? 30 * 60_000,
      env: { PYTHONIOENCODING: 'utf-8' },
    })
    await cleanupSpill(result.spillPath)

    if (result.ok) {
      const produced = await findProduced(workDir)
      if (produced) return { path: produced, workDir, via: 'yt-dlp', stderrTail: tail(result.stderr, 4000) }
      return {
        workDir,
        via: 'yt-dlp',
        error: describeError('download-failed'),
        stderrTail: `yt-dlp reported success but produced no file in ${workDir}`,
      }
    }

    // 页面链接没有 fallback —— ffmpeg 读不了网页，直接把 yt-dlp 的结论带回去。
    if (!isDirectMediaUrl(url)) {
      return {
        workDir,
        via: 'yt-dlp',
        error: result.error ?? describeError('download-failed'),
        stderrTail: tail(result.stderr, 4000),
      }
    }
    onProgress?.('yt-dlp failed, falling back to ffmpeg')
  }

  // 直链回退：ffmpeg 自带 http/https/hls 协议
  if (!isDirectMediaUrl(url) && !ytDlp.available) {
    return {
      workDir,
      error: describeError('download-tool-missing'),
      stderrTail: 'yt-dlp is not installed and the link is not a direct media URL',
    }
  }

  const result = await runCommand(ctx, {
    command: config.ffmpegPath ?? 'ffmpeg',
    argv: [
      '-hide_banner',
      '-nostdin',
      // 网络流要允许重定向与协议白名单
      '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
      '-i', url,
      '-c', 'copy',
      '-y', target,
    ],
    signal,
    timeoutMs: config.timeoutMs ?? 30 * 60_000,
    missingKind: config.ffmpegPath ? undefined : 'ffmpeg',
  })
  await cleanupSpill(result.spillPath)

  if (!result.ok) {
    return {
      workDir,
      via: 'ffmpeg',
      error: result.error ?? describeError('download-failed'),
      stderrTail: tail(result.stderr, 4000),
    }
  }
  const produced = await findProduced(workDir)
  if (!produced) {
    return {
      workDir,
      via: 'ffmpeg',
      error: describeError('download-failed'),
      stderrTail: `ffmpeg reported success but produced no file in ${workDir}`,
    }
  }
  return { path: produced, workDir, via: 'ffmpeg', stderrTail: tail(result.stderr, 4000) }
}

/** 找出目录里最大的那个文件（yt-dlp 可能改扩展名，例如 mp4→mkv）。 */
async function findProduced(workDir: string): Promise<string | null> {
  try {
    const names = await readdir(workDir)
    let best: { path: string; size: number } | null = null
    for (const name of names) {
      const path = join(workDir, name)
      const info = await stat(path)
      if (!info.isFile()) continue
      if (!best || info.size > best.size) best = { path, size: info.size }
    }
    return best && best.size > 0 ? best.path : null
  } catch {
    return null
  }
}

function tail(text: string, max: number): string {
  return text.length <= max ? text : text.slice(text.length - max)
}

/** 清理下载目录（必须在 finally 里调）。 */
export async function cleanupDownload(dir: string | undefined): Promise<void> {
  if (!dir) return
  try {
    await rm(dir, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响主流程 */
  }
}
