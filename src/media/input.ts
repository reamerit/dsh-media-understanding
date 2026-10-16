/**
 * 输入归一化：把"本地路径或链接"变成"一个确实存在的本地文件"。
 *
 * 三种输入形式（用户已确认的需求）走同一条出口：
 * - 本地绝对路径（含 GUI 上传落到 `~/.dsh/attachments/v1/files/…` 的路径）→ 直接用；
 * - http(s) 直链 / 平台页面链接 → 下载到临时目录（见 `download.ts`）；
 * - 其它 scheme → 明确拒绝。
 *
 * 为什么所有工具都先过这里：抽音轨与抽帧都只认本地文件，把判断集中在一处，
 * 三个工具的错误语义才不会各说各话。
 */
import { stat } from 'node:fs/promises'

import type { Context } from '@deepseek-ai/cordis'

import { describeError, type ClassifiedError } from '../pure/errors.js'
import { classifyMediaInput } from '../pure/resolve-input.js'
import { cleanupDownload, downloadMedia, type DownloaderConfig } from './download.js'

export interface ResolvedInput {
  /** 本地文件路径；`kind === 'local'` 时直接用，`kind === 'downloaded'` 时要清理。 */
  readonly path: string
  readonly kind: 'local' | 'downloaded'
  /** 原始输入（用于回报与诊断）。 */
  readonly raw: string
  /** 下载通路（`yt-dlp` / `ffmpeg`），本地输入为 null。 */
  readonly via: 'yt-dlp' | 'ffmpeg' | null
  readonly downloadDir?: string
  readonly sizeBytes: number
}

export interface InputOutcome {
  readonly resolved?: ResolvedInput
  readonly error?: ClassifiedError
  /** 给模型看的一句话说明（例如下载用了哪条通路）。 */
  readonly note?: string
}

/**
 * 解析并（必要时）下载输入。
 *
 * 语义分工（coding-plan Phase 4 的硬约束）：
 * - **基础设施故障**（路径不存在、ffmpeg/yt-dlp 缺失）→ 返回 error 且
 *   `infrastructure: true`，调用方应当 throw；
 * - **业务失败**（链接下不动、scheme 不支持）→ 返回 error 但
 *   `infrastructure: false`，调用方返回 canonical 值 + reason。
 */
export async function resolveInput(
  ctx: Context,
  raw: string,
  config: DownloaderConfig & { ffmpegPath?: string },
  signal?: AbortSignal,
  onProgress?: (line: string) => void,
): Promise<InputOutcome> {
  const classified = classifyMediaInput(raw)

  if (classified.kind === 'empty') {
    return { error: describeError('input-not-found') }
  }

  if (classified.kind === 'unsupported-scheme') {
    const base = describeError('unsupported-url')
    return { error: { ...base, summary: `${base.summary} (got "${classified.scheme}://")` } }
  }

  if (classified.kind === 'local') {
    try {
      const info = await stat(classified.path)
      if (!info.isFile()) {
        const base = describeError('input-not-found')
        return { error: { ...base, summary: `${base.summary} (not a regular file: ${classified.path})` } }
      }
      return {
        resolved: {
          path: classified.path,
          kind: 'local',
          raw,
          via: null,
          sizeBytes: info.size,
        },
      }
    } catch {
      const base = describeError('input-not-found')
      return { error: { ...base, summary: `${base.summary} (${classified.path})` } }
    }
  }

  // remote
  const download = await downloadMedia(ctx, classified.url, config, signal, onProgress)
  if (!download.path) {
    await cleanupDownload(download.workDir)
    return {
      error: download.error ?? describeError('download-failed'),
    }
  }

  let sizeBytes = 0
  try {
    sizeBytes = (await stat(download.path)).size
  } catch {
    sizeBytes = 0
  }

  return {
    resolved: {
      path: download.path,
      kind: 'downloaded',
      raw,
      via: download.via ?? null,
      downloadDir: download.workDir,
      sizeBytes,
    },
    note: `downloaded via ${download.via ?? 'unknown'}`,
  }
}

/** 清理下载产物（本地输入时是 no-op）。 */
export async function releaseInput(resolved: ResolvedInput | undefined): Promise<void> {
  if (!resolved || resolved.kind !== 'downloaded') return
  await cleanupDownload(resolved.downloadDir)
}
