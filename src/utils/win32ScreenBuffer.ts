/**
 * Windows screen buffer manager using Win32 FFI.
 *
 * Replaces VT escape sequences (\x1b[?1049h / \x1b[?1049l) with direct
 * Win32 API calls (CreateConsoleScreenBuffer / SetConsoleActiveScreenBuffer)
 * to manage the alternate screen buffer. This bypasses the ConPTY VT parser,
 * avoiding the write-ordering bug that causes garbled output after /exit
 * on Windows/Bun.
 *
 * On non-Windows platforms, all functions are no-ops.
 */

let _ffi: ReturnType<typeof loadKernel32> | null = null
let _mainHandle: bigint | null = null
let _altHandle: bigint | null = null
let _active = false

function loadKernel32() {
  try {
    const { dlopen } = require('bun:ffi') as {
      dlopen: (name: string, symbols: Record<string, {args: unknown[], returns: string}>) => {
        symbols: Record<string, (...args: unknown[]) => unknown>
      }
    }
    return dlopen('kernel32.dll', {
      CreateFileW: { args: ['ptr', 'u32', 'u32', 'ptr', 'u32', 'u32', 'i64'], returns: 'i64' },
      CreateConsoleScreenBuffer: { args: ['u32', 'u32', 'ptr', 'u32', 'ptr'], returns: 'i64' },
      SetConsoleActiveScreenBuffer: { args: ['i64'], returns: 'i32' },
      CloseHandle: { args: ['i64'], returns: 'i32' },
      GetLastError: { args: [], returns: 'i32' },
    })
  } catch {
    return null
  }
}

/**
 * Open a handle to the current active console screen buffer via CONOUT$.
 * Must be called BEFORE entering the alternate screen buffer.
 * Returns null on failure (e.g., not on Windows, or not a TTY).
 */
function openConOut(): bigint | null {
  if (process.platform !== 'win32' || !process.stdout.isTTY) return null
  if (!_ffi) _ffi = loadKernel32()
  if (!_ffi) return null

  try {
    const GENERIC_WRITE = 0x40000000
    const FILE_SHARE_READ = 1
    const FILE_SHARE_WRITE = 2
    const OPEN_EXISTING = 3

    const { ptr } = require('bun:ffi') as { ptr: (buf: ArrayBufferLike) => number }
    const str = 'CONOUT$\x00'
    const buf = Buffer.from(str, 'utf16le').buffer as ArrayBuffer
    const pName = ptr(buf)
    const h = _ffi.symbols.CreateFileW(
      pName as number,
      GENERIC_WRITE,
      FILE_SHARE_READ | FILE_SHARE_WRITE,
      null,
      OPEN_EXISTING,
      0,
      0n,
    ) as bigint
    if (h === -1n) return null
    return h
  } catch {
    return null
  }
}

function createScreenBuffer(): bigint | null {
  if (!_ffi) return null
  try {
    const GENERIC_WRITE = 0x40000000
    const FILE_SHARE_READ = 1
    const FILE_SHARE_WRITE = 2
    const CONSOLE_TEXTMODE_BUFFER = 1
    const h = _ffi.symbols.CreateConsoleScreenBuffer(
      GENERIC_WRITE,
      FILE_SHARE_READ | FILE_SHARE_WRITE,
      null,
      CONSOLE_TEXTMODE_BUFFER,
      null,
    ) as bigint
    if (h === -1n) return null
    return h
  } catch {
    return null
  }
}

function activateBuffer(h: bigint): boolean {
  if (!_ffi) return false
  try {
    const ok = _ffi.symbols.SetConsoleActiveScreenBuffer(h) as number
    return ok !== 0
  } catch {
    return false
  }
}

function closeHandle(h: bigint): void {
  if (!_ffi) return
  try {
    _ffi.symbols.CloseHandle(h)
  } catch {
    // best effort
  }
}

/**
 * Initialize the screen buffer manager. Must be called once at startup,
 * BEFORE any alt screen entry, to capture the main screen buffer handle.
 * Safe to call multiple times (only first call does work).
 */
export function initScreenBuffer(): void {
  if (_mainHandle !== null) return
  _mainHandle = openConOut()
}

/**
 * Enter the alternate screen buffer via Win32 API.
 * Returns true if successful, false if fallback to VT sequences is needed.
 */
export function enterAltScreen(): boolean {
  if (process.platform !== 'win32' || !process.stdout.isTTY) return false

  // Ensure we have the main handle
  if (_mainHandle === null) {
    _mainHandle = openConOut()
  }
  // If we can't get the main handle, fall back to VT sequences
  if (_mainHandle === null) return false

  // Create new buffer for alt screen
  const h = createScreenBuffer()
  if (h === null) return false
  _altHandle = h

  // Activate the new buffer
  if (!activateBuffer(h)) {
    closeHandle(h)
    _altHandle = null
    return false
  }

  _active = true
  return true
}

/**
 * Exit the alternate screen buffer via Win32 API.
 * Restores the main screen buffer that was captured at init time.
 * Returns true if successful.
 */
export function exitAltScreen(): boolean {
  if (process.platform !== 'win32') return false
  if (!_active) return false
  if (!_mainHandle) return false

  // Restore main screen buffer
  let ok = false
  if (_mainHandle) {
    ok = activateBuffer(_mainHandle)
  }

  // Close alt screen buffer handle
  if (_altHandle) {
    closeHandle(_altHandle)
    _altHandle = null
  }

  _active = false
  return ok
}

/**
 * Check if the alternate screen buffer is currently active.
 */
export function isAltScreenActive(): boolean {
  return _active
}

/**
 * Clean up all handles. Safe to call at any time.
 */
export function cleanup(): void {
  if (_altHandle) {
    // Try to restore main buffer before cleanup
    if (_mainHandle) activateBuffer(_mainHandle)
    closeHandle(_altHandle)
    _altHandle = null
  }
  if (_mainHandle) {
    closeHandle(_mainHandle)
    _mainHandle = null
  }
  _active = false
}
