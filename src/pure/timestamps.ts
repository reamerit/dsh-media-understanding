/**
 * ffmpeg 抽帧时间戳解析（coding-plan C4a，本机实测修正版）。
 *
 * 命令形如：
 *
 *     -vf "select='gt(scene,TH)',showinfo,scale=…" -fps_mode vfr -frames:v N -q:v 3 out_%04d.jpg
 *
 * ⚠️ **必须用 `showinfo`，不能用 `metadata=mode=print`**：本机 ffmpeg 6.0 实测
 * `metadata=mode=print` 根本不输出 `pts_time`（只有普通 "Metadata:" 行），于是所有
 * 时间戳静默退化成按 fps 估算——fps 采样下看似正确、场景采样下则完全对不上。
 * `showinfo` 对**每个被输出的帧**打一行：
 *
 *     [Parsed_showinfo_1 @ …] n: 0 pts: 0 pts_time:0 duration: 1 duration_time:1 …
 *     [Parsed_showinfo_1 @ …] n: 1 pts: 1 pts_time:1 duration: 1 duration_time:1 …
 *
 * 行序与输出文件严格 1:1，因此不需要按帧号/帧率反推。解析不到时调用方必须如实标
 * `estimated`，不要假装精确。
 *
 * 纯逻辑，不 import 宿主包 —— 用 `scripts/selftest-timestamps.mjs`/`test/` 拿真实样本断言。
 */

/** showinfo 行：`n: <int> pts: <int> pts_time:<秒>`（最可靠，优先）。 */
const SHOWINFO_LINE = /\bn:\s*\d+\s+pts:\s*-?\d+\s+pts_time:\s*(-?\d+(?:\.\d+)?)/g
/** 兜底：裸 `pts_time:`（旧 metadata 路径或其它打印器）。 */
const PTS_TIME = /pts_time:\s*(-?\d+(?:\.\d+)?)/g
const SCENE_SCORE = /lavfi\.scene_score=([0-9]+(?:\.[0-9]+)?)/g

export interface ParsedTimestamps {
  /** 按 stderr 出现顺序（即与输出文件同序）的时间戳，单位秒。 */
  readonly timestamps: number[]
  /** 诊断用：每次抽帧的场景分（若打印器给出）。 */
  readonly sceneScores: number[]
  /** `exact` = 解析到；`none` = 一个都没解析到，调用方需自行估算。 */
  readonly source: 'exact' | 'none'
  /** 实际命中的打印器，便于现场判断是谁在提供时间戳。 */
  readonly parsedFrom: 'showinfo' | 'pts_time' | 'none'
}

/**
 * 从 ffmpeg stderr（含 spill 文件）里按顺序抽出时间戳。
 *
 * 顺序语义很重要：第 i 个时间戳配第 i 个帧文件。因此这里**只做顺序收集**，
 * 不对时间戳排序、不去重。
 *
 * 优先用 showinfo 行（每帧一行、带帧号，最不容易误配）；若一行都没有，再退到裸
 * `pts_time` 扫描（兼容其它打印器）。
 */
export function parseSceneTimestamps(stderrText: string): ParsedTimestamps {
  if (!stderrText) {
    return { timestamps: [], sceneScores: [], source: 'none', parsedFrom: 'none' }
  }

  const collect = (pattern: RegExp): number[] => {
    const out: number[] = []
    pattern.lastIndex = 0
    for (let m = pattern.exec(stderrText); m !== null; m = pattern.exec(stderrText)) {
      const value = Number(m[1])
      if (Number.isFinite(value)) out.push(value)
    }
    return out
  }

  const fromShowinfo = collect(SHOWINFO_LINE)
  const timestamps = fromShowinfo.length > 0 ? fromShowinfo : collect(PTS_TIME)
  const parsedFrom: ParsedTimestamps['parsedFrom'] =
    fromShowinfo.length > 0 ? 'showinfo' : timestamps.length > 0 ? 'pts_time' : 'none'

  return {
    timestamps,
    sceneScores: collect(SCENE_SCORE),
    source: timestamps.length > 0 ? 'exact' : 'none',
    parsedFrom,
  }
}

/** 按帧号估算时间戳（解析失败时的兜底，调用方须标 `timestampSource: 'estimated'`）。 */
export function estimateTimestamps(count: number, fps: number): number[] {
  if (!Number.isFinite(fps) || fps <= 0 || count <= 0) return []
  return Array.from({ length: count }, (_, i) => Number((i / fps).toFixed(3)))
}

/**
 * 把解析到的时间戳配给实际落盘的帧文件。
 *
 * 数量不一致时按"能配多少配多少"处理，并让调用方知道是否发生了截断/补位：
 * - `timestamps` 少于文件数 → 尾部帧用估算值补齐（`estimatedTail` 非空）；
 * - 多于文件数 → 截断到文件数。
 */
export interface PairingResult {
  readonly pairs: Array<{ index: number; timestampSec: number; estimated: boolean }>
  readonly exactCount: number
  readonly estimatedCount: number
}

export function pairTimestamps(
  fileCount: number,
  parsed: readonly number[],
  fallbackFps: number,
): PairingResult {
  const pairs: PairingResult['pairs'] = []
  const estimates = estimateTimestamps(fileCount, fallbackFps)
  let exactCount = 0
  let estimatedCount = 0

  for (let i = 0; i < fileCount; i += 1) {
    const exact = parsed[i]
    if (typeof exact === 'number' && Number.isFinite(exact)) {
      pairs.push({ index: i, timestampSec: Number(exact.toFixed(3)), estimated: false })
      exactCount += 1
    } else {
      pairs.push({
        index: i,
        timestampSec: estimates[i] ?? 0,
        estimated: true,
      })
      estimatedCount += 1
    }
  }

  return { pairs, exactCount, estimatedCount }
}
