import chalk from 'chalk'
import { writeSync } from 'fs'
import memoize from 'lodash-es/memoize.js'
import { onExit } from 'signal-exit'
import type { ExitReason } from 'src/entrypoints/agentSdkTypes.js'
import {
  getIsInteractive,
  getIsScrollDraining,
  getLastMainRequestId,
  getSessionId,
  isSessionPersistenceDisabled,
} from '../bootstrap/state.js'
import type Ink from '../ink/ink.js'
import instances from '../ink/instances.js'
import { exitAltScreen as win32ExitAltScreen } from './win32ScreenBuffer.js'
import {
  DISABLE_KITTY_KEYBOARD,
  DISABLE_MODIFY_OTHER_KEYS,
} from '../ink/termio/csi.js'
import {
  DBP,
  DFE,
  DISABLE_MOUSE_TRACKING,
  EXIT_ALT_SCREEN,
  SHOW_CURSOR,
} from '../ink/termio/dec.js'
import {
  CLEAR_ITERM2_PROGRESS,
  CLEAR_TAB_STATUS,
  CLEAR_TERMINAL_TITLE,
  supportsTabStatus,
  wrapForMultiplexer,
} from '../ink/termio/osc.js'
import { shutdownDatadog } from '../services/analytics/datadog.js'
import { shutdown1PEventLogging } from '../services/analytics/firstPartyEventLogger.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import type { AppState } from '../state/AppState.js'
import { runCleanupFunctions } from './cleanupRegistry.js'
import { logForDebugging } from './debug.js'
import { logForDiagnosticsNoPII } from './diagLogs.js'
import { isEnvTruthy } from './envUtils.js'
import { getCurrentSessionTitle, sessionIdExists } from './sessionStorage.js'
import { sleep } from './sleep.js'
import { profileReport } from './startupProfiler.js'

/**
 * Clean up terminal modes synchronously before process exit.
 * This ensures terminal escape sequences (Kitty keyboard, focus reporting, etc.)
 * are properly disabled even if React's componentWillUnmount doesn't run in time.
 * Uses writeSync to ensure writes complete before exit.
 *
 * We unconditionally send all disable sequences because:
 * 1. Terminal detection may not always work correctly (e.g., in tmux, screen)
 * 2. These sequences are no-ops on terminals that don't support them
 * 3. Failing to disable leaves the terminal in a broken state
 */
/* eslint-disable custom-rules/no-sync-fs -- must be sync to flush before process.exit */
/**
 * Write a string to stdout via the Bun process.stdout.write() path, then
 * wait for the callback. This ensures the data goes through the same I/O
 * buffer as frame content from Ink's onRender, preserving write ordering.
 *
 * On Windows/Bun, writeSync(1, ...) bypasses Bun's internal stdout buffer
 * and can arrive at ConPTY before buffered frame content. This causes
 * frame data to be rendered on the main screen after EXIT_ALT_SCREEN
 * switches back. Using process.stdout.write() for the alt screen exit
 * avoids the race.
 */
function writeThroughStdout(data: string): Promise<void> {
  return new Promise<void>(resolve => {
    process.stdout.write(data, () => resolve())
  })
}

/**
 * Synchronous version — writes via writeSync(1, ...). Used in places
 * where the caller cannot await (failsafe timer, sync error handler).
 */
function writeThroughStdoutSync(data: string): void {
  try { writeSync(1, data) } catch { /* best effort */ }
}

/**
 * Exit the alternate screen buffer and reset terminal state.
 *
 * Always detaches first to prevent buffer pollution, then drains all
 * pending async writes before sending the VT exit sequence. This ensures
 * EXIT_ALT_SCREEN arrives at ConPTY AFTER all frame content, preventing
 * the garbled output caused by frame data rendering on the main screen.
 *
 * On Windows, uses writeSync for the VT exit (after drain) to bypass
 * Bun's internal stdout buffer — the drain already flushed everything.
 *
 * On other platforms, uses VT escape sequences synchronously.
 *
 * Returns a Promise that resolves when the drain and writes complete.
 */
function exitAltScreen(inst: Ink | undefined): Promise<void> {
  // Detach immediately: prevent new renders from polling the buffer.
  inst?.detachForShutdown()
  writeThroughStdoutSync(DISABLE_MOUSE_TRACKING)

  if (process.platform === 'win32') {
    // Drain all pending async writes BEFORE sending EXIT_ALT_SCREEN.
    // Frame content from onRender goes through process.stdout.write()
    // which may still be in Bun's internal buffer. The drain ensures
    // everything is flushed to ConPTY before we send the VT exit.
    // Use process.stdout.write() for the exit too — writeSync(1, ...)
    // on Windows may bypass the ConPTY pipe and write directly to the
    // console, causing the VT sequence to be ignored.
    return writeThroughStdout('\r\n' + EXIT_ALT_SCREEN)
  }

  writeThroughStdoutSync(DISABLE_MOUSE_TRACKING)
  const data = '\r\n\x1b[2J\x1b[H' + EXIT_ALT_SCREEN + '\x1b[2J\x1b[H' + '\r\n'.repeat(60) + '\x1b[2J\x1b[H\r\n'
  return writeThroughStdout(data)
}

/**
 * Common terminal cleanup after alt screen exit (steps 2-11 in the cleanup
 * sequence: drain stdin, detach, restore modes, disable key reporting, show
 * cursor, clear tab/title). Shared between async and sync cleanup paths.
 */
function finishTerminalCleanup(inst: Ink | undefined): void {
  inst?.drainStdin()
  // detachForShutdown() was already called inside exitAltScreen (or inline
  // in cleanupTerminalModesSync) — skipped here to avoid redundant calls.
  // The sync path (cleanupTerminalModesSync) handles detach explicitly.
  // Belt-and-suspenders: force restore stdin raw mode directly on
  // process.stdin. detachForShutdown() does this on options.stdin (which
  // may differ when stdin is piped), but on Windows/Bun the isRaw check
  // was the guard and isRaw can be undefined, leaving stdin in raw mode
  // after exit and causing garbled echo in the shell.
  try {
    if (process.stdin.isTTY && (process.stdin as NodeJS.ReadStream & { setRawMode?: (m: boolean) => void }).setRawMode) {
      ;(process.stdin as NodeJS.ReadStream & { setRawMode?: (m: boolean) => void }).setRawMode!(false)
    }
  } catch {
    // TTY may be closed
  }
  // Disable extended key reporting — always send both since terminals
  // silently ignore whichever they don't implement
  writeSync(1, DISABLE_MODIFY_OTHER_KEYS)
  writeSync(1, DISABLE_KITTY_KEYBOARD)
  // Disable focus events (DECSET 1004)
  writeSync(1, DFE)
  // Disable bracketed paste mode
  writeSync(1, DBP)
  // Show cursor
  writeSync(1, SHOW_CURSOR)
  // Clear iTerm2 progress bar - prevents lingering progress indicator
  // that can cause bell sounds when returning to the terminal tab
  writeSync(1, CLEAR_ITERM2_PROGRESS)
  // Clear tab status (OSC 21337) so a stale dot doesn't linger
  if (supportsTabStatus()) writeSync(1, wrapForMultiplexer(CLEAR_TAB_STATUS))
  // Clear terminal title so the tab doesn't show stale session info.
  // Respect CLAUDE_CODE_DISABLE_TERMINAL_TITLE — if the user opted out of
  // title changes, don't clear their existing title on exit either.
  if (!isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE)) {
    if (process.platform === 'win32') {
      process.title = ''
    } else {
      writeSync(1, CLEAR_TERMINAL_TITLE)
    }
  }
  // Windows nuclear option: restore console mode via Win32 API so \n→\r\n
  // translation and VT processing survive after process exit.
  restoreWindowsConsoleMode()
}

/**
 * Async terminal cleanup — uses process.stdout.write() for EXIT_ALT_SCREEN
 * so the sequence goes through the same I/O buffer as frame content.
 * Prevents buffered frame data from arriving at ConPTY after the switch.
 */
async function cleanupTerminalModes(): Promise<void> {
  if (!process.stdout.isTTY) return
  try {
    const inst = instances.get(process.stdout)
    await exitAltScreen(inst)
    finishTerminalCleanup(inst)
  } catch {
    // Terminal may already be gone (e.g., SIGHUP after terminal close).
  }
}

/**
 * Sync terminal cleanup fallback — uses writeSync(1, ...) for everything.
 * Used in places that cannot await (failsafe timer, sync error handler).
 */
function cleanupTerminalModesSync(): void {
  if (!process.stdout.isTTY) return
  try {
    const inst = instances.get(process.stdout)
    if (inst?.isAltScreenActive) {
      // On Windows, use Win32 API directly (not VT sequences).
      if (process.platform === 'win32') {
        win32ExitAltScreen()
      } else {
        writeSync(1, '\r\n\x1b[2J\x1b[H' + EXIT_ALT_SCREEN + '\x1b[2J\x1b[H\r\n')
      }
    }
    inst?.detachForShutdown()
    finishTerminalCleanup(inst)
  } catch {
    // Terminal may already be gone
  }
}

let resumeHintPrinted = false

/**
 * Print a hint about how to resume the session.
 * Only shown for interactive sessions with persistence enabled.
 */
function printResumeHint(): void {
  // Only print once (failsafe timer may call this again after normal shutdown)
  if (resumeHintPrinted) {
    return
  }
  // Only show with TTY, interactive sessions, and persistence
  if (
    process.stdout.isTTY &&
    getIsInteractive() &&
    !isSessionPersistenceDisabled()
  ) {
    try {
      const sessionId = getSessionId()
      // Don't show resume hint if no session file exists (e.g., subcommands like `claude update`)
      if (!sessionIdExists(sessionId)) {
        return
      }
      const customTitle = getCurrentSessionTitle(sessionId)

      // Use custom title if available, otherwise fall back to session ID
      let resumeArg: string
      if (customTitle) {
        // Wrap in double quotes, escape backslashes first then quotes
        const escaped = customTitle.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
        resumeArg = `"${escaped}"`
      } else {
        resumeArg = sessionId
      }

      writeSync(
        1,
        chalk.dim(
          `\nResume this session with:\nclaude --resume ${resumeArg}\n`,
        ),
      )
      resumeHintPrinted = true
    } catch {
      // Ignore write errors
    }
  }
}
/* eslint-enable custom-rules/no-sync-fs */

/**
 * Restore the Windows console output handle's mode flags to their standard
 * values via Win32 API (SetConsoleMode). This is the nuclear option: if
 * Bun's process.stdout.write buffer, writeSync, or VT escape sequences race
 * and corrupt the console mode (ENABLE_PROCESSED_OUTPUT, ENABLE_VIRTUAL_TERMINAL_PROCESSING),
 * only SetConsoleMode can reliably undo it. Escape sequences are processed
 * BY the VT parser, which stops working when its mode flag is cleared.
 *
 * Standard output mode: ENABLE_PROCESSED_OUTPUT(0x1) | ENABLE_WRAP_AT_EOL_OUTPUT(0x2)
 * | ENABLE_VIRTUAL_TERMINAL_PROCESSING(0x4) = 0x7.
 */
export function restoreWindowsConsoleMode(): void {
  if (process.platform !== 'win32' || !process.stdout.isTTY) return
  try {
    // Dynamic require to avoid errors on non-Windows or Bun versions without FFI
    const { dlopen, ptr } = require('bun:ffi') as {
      dlopen: (name: string, symbols: Record<string, {args: string[], returns: string}>) => {
        symbols: Record<string, (...args: unknown[]) => unknown>
      }
      ptr: (buf: ArrayBufferLike) => number
    }
    const kernel32 = dlopen('kernel32.dll', {
      GetStdHandle: { args: ['u32'], returns: 'i64' },
      GetConsoleMode: { args: ['i64', 'ptr'], returns: 'i32' },
      SetConsoleMode: { args: ['i64', 'u32'], returns: 'i32' },
    })
    const STD_OUTPUT_HANDLE = 0xFFFFFFF5
    const h = kernel32.symbols.GetStdHandle(STD_OUTPUT_HANDLE) as bigint
    if (!h || h === -1n) return
    const modeBuf = new Uint32Array(1)
    const p = ptr(modeBuf.buffer)
    const ok = kernel32.symbols.GetConsoleMode(h, p) as number
    if (!ok) return
    // Restore standard flags: ENABLE_PROCESSED_OUTPUT(0x1) | ENABLE_WRAP_AT_EOL_OUTPUT(0x2)
    // | ENABLE_VIRTUAL_TERMINAL_PROCESSING(0x4) = 0x7
    const newMode = modeBuf[0] | 0x0007
    kernel32.symbols.SetConsoleMode(h, newMode as number)
  } catch {
    // Bun FFI may not be available on all versions
  }
}

/**
 * Force process exit, handling the case where the terminal is gone.
 * When the terminal/PTY is closed (e.g., SIGHUP), process.exit() can throw
 * EIO errors because Bun tries to flush stdout to a dead file descriptor.
 * In that case, fall back to SIGKILL which always works.
 */
function forceExit(exitCode: number): never {
  // Clear failsafe timer since we're exiting now
  if (failsafeTimer !== undefined) {
    clearTimeout(failsafeTimer)
    failsafeTimer = undefined
  }
  // Drain stdin LAST, right before exit. cleanupTerminalModes() sent
  // DISABLE_MOUSE_TRACKING early, but the terminal round-trip plus any
  // events already in flight means bytes can arrive during the seconds
  // of async cleanup between then and now. Draining here catches them.
  // Use the Ink class method (not the standalone drainStdin()) so we
  // drain the instance's stdin — when process.stdin is piped,
  // getStdinOverride() opens /dev/tty as the real input stream and the
  // class method knows about it; the standalone function defaults to
  // process.stdin which would early-return on isTTY=false.
  try {
    instances.get(process.stdout)?.drainStdin()
  } catch {
    // Terminal may be gone (SIGHUP). Ignore — we are about to exit.
  }
  // On Windows, Bun's setRawMode may not fully restore console line
  // discipline. Force-restore via direct console.log (which goes through
  // CRT text-mode translation) and ensure stdin is fully back to
  // cooked mode before exit.
  if (process.platform === 'win32' && process.stdin.isTTY) {
    try {
      // Force stdin to cooked mode + unpause so the shell inherits
      // a clean console. Multiple approaches because Bun may have
      // subtle bugs in any one of them.
      ;(process.stdin as NodeJS.ReadStream & { setRawMode?: (m: boolean) => void }).setRawMode?.(false)
      process.stdin.pause()
      process.stdin.setEncoding('utf-8')
      // Write CRLF through the CRT-aware stream (not raw writeSync) so
      // the console's output processing is properly reset.
      writeSync(1, '\r\n')
    } catch {
      // Best effort
    }
  }
  try {
    process.exit(exitCode)
  } catch (e) {
    // process.exit() threw. In tests, it's mocked to throw - re-throw so test sees it.
    // In production, it's likely EIO from dead terminal - use SIGKILL.
    if ((process.env.NODE_ENV as string) === 'test') {
      throw e
    }
    // Fall back to SIGKILL which doesn't try to flush anything.
    process.kill(process.pid, 'SIGKILL')
  }
  // In tests, process.exit may be mocked to return instead of exiting.
  // In production, we should never reach here.
  if ((process.env.NODE_ENV as string) !== 'test') {
    throw new Error('unreachable')
  }
  // TypeScript trick: cast to never since we know this only happens in tests
  // where the mock returns instead of exiting
  return undefined as never
}

/**
 * Set up global signal handlers for graceful shutdown
 */
export const setupGracefulShutdown = memoize(() => {
  // Work around a Bun bug where process.removeListener(sig, fn) resets the
  // kernel sigaction for that signal even when other JS listeners remain —
  // the signal then falls back to its default action (terminate) and our
  // process.on('SIGTERM') handler never runs.
  //
  // Trigger: any short-lived signal-exit v4 subscriber (e.g. execa per child
  // process, or an Ink instance that unmounts). When its unsubscribe runs and
  // it was the last v4 subscriber, v4.unload() calls removeListener on every
  // signal in its list (SIGTERM, SIGINT, SIGHUP, …), tripping the Bun bug and
  // nuking our handlers at the kernel level.
  //
  // Fix: pin signal-exit v4 loaded by registering a no-op onExit callback that
  // is never unsubscribed. This keeps v4's internal emitter count > 0 so
  // unload() never runs and removeListener is never called. Harmless under
  // Node.js — the pin also ensures signal-exit's process.exit hook stays
  // active for Ink cleanup.
  onExit(() => {})

  process.on('SIGINT', () => {
    // In print mode, print.ts registers its own SIGINT handler that aborts
    // the in-flight query and calls gracefulShutdown(0); skip here to
    // avoid racing with it. Only check print mode — other non-interactive
    // sessions (--sdk-url, --init-only, non-TTY) don't register their own
    // SIGINT handler and need gracefulShutdown to run.
    if (process.argv.includes('-p') || process.argv.includes('--print')) {
      return
    }
    logForDiagnosticsNoPII('info', 'shutdown_signal', { signal: 'SIGINT' })
    void gracefulShutdown(0)
  })
  process.on('SIGTERM', () => {
    logForDiagnosticsNoPII('info', 'shutdown_signal', { signal: 'SIGTERM' })
    void gracefulShutdown(143) // Exit code 143 (128 + 15) for SIGTERM
  })
  if (process.platform !== 'win32') {
    process.on('SIGHUP', () => {
      logForDiagnosticsNoPII('info', 'shutdown_signal', { signal: 'SIGHUP' })
      void gracefulShutdown(129) // Exit code 129 (128 + 1) for SIGHUP
    })

    // Detect orphaned process when terminal closes without delivering SIGHUP.
    // macOS revokes TTY file descriptors instead of signaling, leaving the
    // process alive but unable to read/write. Periodically check stdin validity.
    if (process.stdin.isTTY) {
      orphanCheckInterval = setInterval(() => {
        // Skip during scroll drain — even a cheap check consumes an event
        // loop tick that scroll frames need. 30s interval → missing one is fine.
        if (getIsScrollDraining()) return
        // process.stdout.writable becomes false when the TTY is revoked
        if (!process.stdout.writable || !process.stdin.readable) {
          clearInterval(orphanCheckInterval)
          logForDiagnosticsNoPII('info', 'shutdown_signal', {
            signal: 'orphan_detected',
          })
          void gracefulShutdown(129)
        }
      }, 30_000) // Check every 30 seconds
      orphanCheckInterval.unref() // Don't keep process alive just for this check
    }
  }

  // Log uncaught exceptions for container observability and analytics
  // Error names (e.g., "TypeError") are not sensitive - safe to log
  process.on('uncaughtException', error => {
    logForDiagnosticsNoPII('error', 'uncaught_exception', {
      error_name: error.name,
      error_message: error.message.slice(0, 2000),
    })
    logEvent('tengu_uncaught_exception', {
      error_name:
        error.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  })

  // Log unhandled promise rejections for container observability and analytics
  process.on('unhandledRejection', reason => {
    const errorName =
      reason instanceof Error
        ? reason.name
        : typeof reason === 'string'
          ? 'string'
          : 'unknown'
    const errorInfo =
      reason instanceof Error
        ? {
            error_name: reason.name,
            error_message: reason.message.slice(0, 2000),
            error_stack: reason.stack?.slice(0, 4000),
          }
        : { error_message: String(reason).slice(0, 2000) }
    logForDiagnosticsNoPII('error', 'unhandled_rejection', errorInfo)
    logEvent('tengu_unhandled_rejection', {
      error_name:
        errorName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  })
})

export function gracefulShutdownSync(
  exitCode = 0,
  reason: ExitReason = 'other',
  options?: {
    getAppState?: () => AppState
    setAppState?: (f: (prev: AppState) => AppState) => void
  },
): void {
  // Set the exit code that will be used when process naturally exits. Note that we do it
  // here inside the sync version too so that it is possible to determine if
  // gracefulShutdownSync was called by checking process.exitCode.
  process.exitCode = exitCode

  pendingShutdown = gracefulShutdown(exitCode, reason, options)
    .catch(error => {
      logForDebugging(`Graceful shutdown failed: ${error}`, { level: 'error' })
      cleanupTerminalModesSync()
      printResumeHint()
      forceExit(exitCode)
    })
    // Prevent unhandled rejection: forceExit re-throws in test mode,
    // which would escape the .catch() handler above as a new rejection.
    .catch(() => {})
}

let shutdownInProgress = false
let failsafeTimer: ReturnType<typeof setTimeout> | undefined
let orphanCheckInterval: ReturnType<typeof setInterval> | undefined
let pendingShutdown: Promise<void> | undefined

/** Check if graceful shutdown is in progress */
export function isShuttingDown(): boolean {
  return shutdownInProgress
}

/** Reset shutdown state - only for use in tests */
export function resetShutdownState(): void {
  shutdownInProgress = false
  resumeHintPrinted = false
  if (failsafeTimer !== undefined) {
    clearTimeout(failsafeTimer)
    failsafeTimer = undefined
  }
  pendingShutdown = undefined
}

/**
 * Returns the in-flight shutdown promise, if any. Only for use in tests
 * to await completion before restoring mocks.
 */
export function getPendingShutdownForTesting(): Promise<void> | undefined {
  return pendingShutdown
}

// Graceful shutdown function that drains the event loop
export async function gracefulShutdown(
  exitCode = 0,
  reason: ExitReason = 'other',
  options?: {
    getAppState?: () => AppState
    setAppState?: (f: (prev: AppState) => AppState) => void
    /** Printed to stderr after alt-screen exit, before forceExit. */
    finalMessage?: string
  },
): Promise<void> {
  if (shutdownInProgress) {
    return
  }
  shutdownInProgress = true

  // Resolve the SessionEnd hook budget before arming the failsafe so the
  // failsafe can scale with it. Without this, a user-configured 10s hook
  // budget is silently truncated by the 5s failsafe (gh-32712 follow-up).
  const { executeSessionEndHooks, getSessionEndHookTimeoutMs } = await import(
    './hooks.js'
  )
  const sessionEndTimeoutMs = getSessionEndHookTimeoutMs()

  // Failsafe: guarantee process exits even if cleanup hangs (e.g., MCP connections).
  // Runs cleanupTerminalModes first so a hung cleanup doesn't leave the terminal dirty.
  // Budget = max(5s, hook budget + 3.5s headroom for cleanup + analytics flush).
  failsafeTimer = setTimeout(
    code => {
      cleanupTerminalModesSync()
      printResumeHint()
      forceExit(code)
    },
    Math.max(5000, sessionEndTimeoutMs + 3500),
    exitCode,
  )
  failsafeTimer.unref()

  // Set the exit code that will be used when process naturally exits
  process.exitCode = exitCode

  // Exit alt screen and print resume hint FIRST, before any async operations.
  // This ensures the hint is visible even if the process is killed during
  // cleanup (e.g., SIGKILL during macOS reboot). Without this, the resume
  // hint would only appear after cleanup functions, hooks, and analytics
  // flush — which can take several seconds.
  await cleanupTerminalModes()
  printResumeHint()

  // Flush session data first — this is the most critical cleanup. If the
  // terminal is dead (SIGHUP, SSH disconnect), hooks and analytics may hang
  // on I/O to a dead TTY or unreachable network, eating into the
  // failsafe budget. Session persistence must complete before anything else.
  let cleanupTimeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    const cleanupPromise = (async () => {
      try {
        await runCleanupFunctions()
      } catch {
        // Silently ignore cleanup errors
      }
    })()

    await Promise.race([
      cleanupPromise,
      new Promise((_, reject) => {
        cleanupTimeoutId = setTimeout(
          rej => rej(new CleanupTimeoutError()),
          2000,
          reject,
        )
      }),
    ])
    clearTimeout(cleanupTimeoutId)
  } catch {
    // Silently handle timeout and other errors
    clearTimeout(cleanupTimeoutId)
  }

  // Execute SessionEnd hooks. Bound both the per-hook default timeout and the
  // overall execution via a single budget (CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS,
  // default 1.5s). hook.timeout in settings is respected up to this cap.
  try {
    await executeSessionEndHooks(reason, {
      ...options,
      signal: AbortSignal.timeout(sessionEndTimeoutMs),
      timeoutMs: sessionEndTimeoutMs,
    })
  } catch {
    // Ignore SessionEnd hook exceptions (including AbortError on timeout)
  }

  // Log startup perf before analytics shutdown flushes/cancels timers
  try {
    profileReport()
  } catch {
    // Ignore profiling errors during shutdown
  }

  // Signal to inference that this session's cache can be evicted.
  // Fires before analytics flush so the event makes it to the pipeline.
  const lastRequestId = getLastMainRequestId()
  if (lastRequestId) {
    logEvent('tengu_cache_eviction_hint', {
      scope:
        'session_end' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      last_request_id:
        lastRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  }

  // Flush analytics — capped at 500ms. Previously unbounded: the 1P exporter
  // awaits all pending axios POSTs (10s each), eating the full failsafe budget.
  // Lost analytics on slow networks are acceptable; a hanging exit is not.
  try {
    await Promise.race([
      Promise.all([shutdown1PEventLogging(), shutdownDatadog()]),
      sleep(500),
    ])
  } catch {
    // Ignore analytics shutdown errors
  }

  if (options?.finalMessage) {
    try {
      // eslint-disable-next-line custom-rules/no-sync-fs -- must flush before forceExit
      writeSync(2, options.finalMessage + '\n')
    } catch {
      // stderr may be closed (e.g., SSH disconnect). Ignore write errors.
    }
  }

  // Give pending process.stdout.write from the last frame a chance to
  // flush to fd 1 before process.exit() kills the process. On Bun, async
  // writes may buffer and arrive after our writeSync EXIT_ALT_SCREEN,
  // painting frame content onto the main screen (garbled PowerShell).
  await new Promise(resolve => setTimeout(resolve, 100))

  forceExit(exitCode)
}

class CleanupTimeoutError extends Error {
  constructor() {
    super('Cleanup timeout')
  }
}
