/**
 * `ctx.subprocess` 的薄封装：解析可执行文件 + 有界收集输出 + 取消联动 + 超时。
 *
 * 为什么走 `ctx.subprocess` 而不是裸 `child_process.spawn`（coding-plan C3）：
 * 可执行文件解析（含 Windows `.exe`）、**进程组终止**（Windows 上裸 spawn 的
 * `signal` 杀不掉 ffmpeg 子进程树）、输出有界收集与溢出落盘、取消联动，
 * 这些都由宿主那一层提供。
 *
 * ⚠️ 契约要点（已核实 0.2.0-rc.2）：
 * - `spawn()` **同步**返回 handle；
 * - `handle.done` 只给 `{ exitCode, signal }`，**没有** stdout/stderr；
 * - 输出要自己读：`handle.collected.stderr?.readFrom(0)` → `{ text, nextOffset, lossy, spillPath? }`；
 * - `SubprocessSpawnSpec` **没有** `timeoutMs`：超时要用 `AbortSignal` 自己实现；
 * - 宿主会**擦除**凭据形状的环境变量与全部 `DSH_*`，需要什么必须显式在 `env` 里传。
 */
import { rm } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'

import { classifyFailure, describeError, type ClassifiedError } from '../pure/errors.js'

/** 输出缓冲上限：stdout 1 MiB；stderr 1 MiB + 8 MiB 溢出落盘（帧时间戳要完整解析）。 */
const STDOUT_MAX_BYTES = 1 << 20
const STDERR_MAX_BYTES = 1 << 20
const STDERR_SPILL_BYTES = 8 << 20
/** 取消后给进程组的宽限期（宿主校验为正有限数）。 */
const GRACE_MS = 5000

export interface RunSpec {
  /** 可执行文件名（走宿主解析，含 Windows 的 `.exe`）或绝对路径。 */
  readonly command: string
  readonly argv: readonly string[]
  /** 工作目录；必须是绝对路径。缺省用 `exec.agent` 的会话 cwd，再退 `process.cwd()`。 */
  readonly cwd?: string
  /** 超时（毫秒）。到点用 AbortSignal 终止；不设则只受外层 signal 约束。 */
  readonly timeoutMs?: number
  /** 外层取消信号（`exec.signal`）。 */
  readonly signal?: AbortSignal
  /** 额外环境变量，例如 `PYTHONIOENCODING`、`HF_HOME`。 */
  readonly env?: Readonly<Record<string, string>>
  /** 解析不到可执行文件时映射成哪个 kind。 */
  readonly missingKind?: 'ffmpeg' | 'ffprobe' | 'python'
}

export interface RunResult {
  readonly ok: boolean
  readonly exitCode: number | null
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
  /** stderr 溢出时的落盘路径（调用方要在 finally 里自行清理）。 */
  readonly spillPath?: string
  /** 宿主是否因超出内存上限而丢了 stdout/stderr 的头部。 */
  readonly stdoutLossy: boolean
  readonly stderrLossy: boolean
  readonly timedOut: boolean
  readonly aborted: boolean
  /** 非 ok 时的分类结论。 */
  readonly error?: ClassifiedError
}

/** 解析可执行文件；解析失败返回原因而不是抛错，交给分类器。 */
async function resolveExecutable(
  ctx: Context,
  command: string,
  signal?: AbortSignal,
): Promise<{ path: string } | { failure: ClassifiedError }> {
  try {
    const resolved = await ctx.subprocess.resolveExecutable(command, undefined, signal)
    return { path: resolved }
  } catch (error) {
    return {
      failure: classifyFailure({
        stderr: String(error),
        executableMissing: command === 'ffmpeg' || command === 'ffprobe' ? command : 'python',
      }),
    }
  }
}

interface TimeoutBox {
  readonly signal: AbortSignal
  readonly state: { timedOut: boolean; aborted: boolean }
  dispose(): void
}

/** 把外层 signal 与超时合成一个 signal，并记录是哪种触发。 */
function combineAbort(outer: AbortSignal | undefined, timeoutMs: number | undefined): TimeoutBox {
  const controller = new AbortController()
  const state = { timedOut: false, aborted: false }

  const onAbort = () => {
    state.aborted = true
    controller.abort()
  }

  if (outer) {
    if (outer.aborted) onAbort()
    else outer.addEventListener('abort', onAbort, { once: true })
  }

  const timer =
    timeoutMs !== undefined && timeoutMs > 0
      ? setTimeout(() => {
          state.timedOut = true
          controller.abort()
        }, timeoutMs)
      : undefined
  timer?.unref?.()

  return {
    signal: controller.signal,
    state,
    dispose: () => {
      if (timer) clearTimeout(timer)
      outer?.removeEventListener('abort', onAbort)
    },
  }
}

/** 读 collected 缓冲；`lossy` 表示内存尾部丢过头部，要如实带到结果里。 */
function readCollected(
  handle: SubprocessHandle,
  which: 'stdout' | 'stderr',
): { text: string; spillPath?: string; lossy: boolean } {
  const reader = which === 'stdout' ? handle.collected.stdout : handle.collected.stderr
  if (!reader) return { text: '', lossy: false }
  const chunk = reader.readFrom(0)
  return { text: chunk.text, spillPath: chunk.spillPath, lossy: chunk.lossy }
}

/** 取一个绝对工作目录：显式给的优先，否则会话 cwd，最后进程 cwd。 */
export function resolveCwd(explicit: string | undefined, sessionCwd: string | undefined): string {
  if (explicit && isAbsolute(explicit)) return explicit
  if (sessionCwd && isAbsolute(sessionCwd)) return sessionCwd
  return process.cwd()
}

/**
 * 跑一个子进程并收集输出。
 *
 * **不抛错**：所有失败都变成 `RunResult.error`（分类结论），由调用方决定
 * 是 throw（基础设施故障）还是返回 canonical 值（业务非理想结果）。
 */
export async function runCommand(ctx: Context, spec: RunSpec): Promise<RunResult> {
  const resolved = await resolveExecutable(ctx, spec.command, spec.signal)
  if ('failure' in resolved) {
    return {
      ok: false,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      stdoutLossy: false,
      stderrLossy: false,
      timedOut: false,
      aborted: false,
      error: spec.missingKind
        ? classifyFailure({ stderr: '', executableMissing: spec.missingKind })
        : resolved.failure,
    }
  }

  const box = combineAbort(spec.signal, spec.timeoutMs)

  let handle: SubprocessHandle
  try {
    handle = ctx.subprocess.spawn({
      argv: [resolved.path, ...spec.argv],
      cwd: resolveCwd(spec.cwd, undefined),
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: STDOUT_MAX_BYTES },
        stderr: { maxBytes: STDERR_MAX_BYTES, spill: { maxBytes: STDERR_SPILL_BYTES } },
      },
      graceMs: GRACE_MS,
      signal: box.signal,
      ...(spec.env ? { env: { ...spec.env } } : {}),
    })
  } catch (error) {
    box.dispose()
    return {
      ok: false,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: String(error),
      stdoutLossy: false,
      stderrLossy: false,
      timedOut: box.state.timedOut,
      aborted: box.state.aborted,
      error: classifyFailure({ stderr: String(error) }),
    }
  }

  let outcome: { exitCode: number | null; signal: NodeJS.Signals | null }
  try {
    outcome = await handle.done
  } catch (error) {
    box.dispose()
    return {
      ok: false,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: String(error),
      stdoutLossy: false,
      stderrLossy: false,
      timedOut: box.state.timedOut,
      aborted: box.state.aborted,
      error: classifyFailure({ stderr: String(error) }),
    }
  }
  box.dispose()

  const out = readCollected(handle, 'stdout')
  const err = readCollected(handle, 'stderr')
  const ok = outcome.exitCode === 0 && !box.state.timedOut && !box.state.aborted

  let error: ClassifiedError | undefined
  if (!ok) {
    if (box.state.aborted && !box.state.timedOut) {
      // ⚠️ 取消必须能与"真失败"区分：否则 job_list 里"我按了取消"和"它炸了"长得一样，
      // 用户无法判断该不该重试。
      error = describeError('cancelled')
    } else if (box.state.timedOut) {
      error = classifyFailure({ stderr: 'timed out' })
    } else {
      error = classifyFailure({
        stderr: err.text,
        stdout: out.text,
        exitCode: outcome.exitCode ?? undefined,
      })
    }
  }

  return {
    ok,
    exitCode: outcome.exitCode,
    signal: outcome.signal ?? null,
    stdout: out.text,
    stderr: err.text,
    ...(err.spillPath ? { spillPath: err.spillPath } : {}),
    stdoutLossy: out.lossy,
    stderrLossy: err.lossy,
    timedOut: box.state.timedOut,
    aborted: box.state.aborted && !box.state.timedOut,
    ...(error ? { error } : {}),
  }
}

/** 清理 spill 文件（subprocess 层故意保留，不自动删，必须自己清）。 */
export async function cleanupSpill(path: string | undefined): Promise<void> {
  if (!path) return
  try {
    await rm(path, { force: true })
  } catch {
    /* 清理失败不影响主流程 */
  }
}
