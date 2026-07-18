import { spawn } from 'bun-pty'
import type { IPty } from 'bun-pty'

let sessionCounter = 0

function makeMarker(): string {
  return `PTYM${++sessionCounter}_${Date.now().toString(36)}`
}

export type PtyExecResult = {
  stdout: string
  exitCode: number
  cwd: string
}

export class PtySession {
  private pty: IPty
  private outputBuf = ''
  private _cwd = ''
  private shellType: 'powershell' | 'bash'
  private running = false

  private constructor(pty: IPty, cwd: string, shellType: 'powershell' | 'bash') {
    this.pty = pty
    this._cwd = cwd
    this.shellType = shellType

    pty.onData((data: string) => {
      this.outputBuf += data
      if (this.outputBuf.length > 2_000_000) {
        this.outputBuf = this.outputBuf.slice(-1_000_000)
      }
    })
  }

  static async create(
    cwd: string,
    shellType: 'powershell' | 'bash' = 'powershell',
  ): Promise<PtySession> {
    let shellPath: string
    let args: string[]

    if (shellType === 'powershell') {
      const { findPowerShell } = await import('./powershellDetection.js')
      shellPath = await findPowerShell() || 'powershell.exe'
      args = ['-NoProfile', '-NonInteractive', '-NoExit']
    } else {
      shellPath = process.env.SHELL || 'bash'
      args = ['--norc', '--noprofile']
    }

    const pty = spawn(shellPath, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 100,
      cwd,
      env: {
        TERM: 'xterm-256color',
        ...process.env as Record<string, string>,
      },
    })

    const session = new PtySession(pty, cwd, shellType)

    // Wait for initial prompt
    await new Promise<void>(resolve => {
      const check = pty.onData(() => {
        if (shellType === 'powershell' && session.outputBuf.includes('> ')) {
          check.dispose()
          resolve()
        } else if (shellType === 'bash' && (session.outputBuf.includes('$ ') || session.outputBuf.includes('# '))) {
          check.dispose()
          resolve()
        }
      })
      setTimeout(() => resolve(), 3000)
    })

    return session
  }

  get cwd(): string {
    return this._cwd
  }

  async exec(
    command: string,
    timeout = 60_000,
  ): Promise<PtyExecResult> {
    if (this.running) throw new Error('PTY session is busy')
    this.running = true

    try {
      const marker = makeMarker()
      const beforeLen = this.outputBuf.length

      // Write command + meta-command as a single batch.
      // Meta-command outputs: __CLAUDE__<exitCode>|<cwd>|<marker>|__
      // We detect the execution output line by searching for "\r\n__CLAUDE__"
      // The echo line contains "__CLAUDE__" but preceded by " (from Write-Output "),
      // NOT \r\n, so the search only matches the actual execution output.
      if (this.shellType === 'powershell') {
        this.pty.write(
          `${command}\r\n$__ok=$?; $__c=(Get-Location).Path; $__e=if ($__ok) { 0 } elseif ($global:LASTEXITCODE -ne $null) { $global:LASTEXITCODE } else { 1 }; Write-Output "__CLAUDE__$__e|$__c|${marker}|__"\r\n`,
        )
      } else {
        this.pty.write(
          `${command}\necho "__CLAUDE__$?|$(pwd)|${marker}|__"\n`,
        )
      }

      const raw = await this.waitForMarker(beforeLen, marker, timeout)

      const { stdout, exitCode, cwd } = this.parseOutput(raw, marker)
      if (cwd) this._cwd = cwd

      return { stdout, exitCode, cwd: this._cwd }
    } finally {
      this.running = false
    }
  }

  private async waitForMarker(
    beforeLen: number,
    marker: string,
    timeout: number,
  ): Promise<string> {
    const markerCheck = `|${marker}|__`
    const startTime = Date.now()

    while (Date.now() - startTime < timeout) {
      const raw = this.outputBuf.slice(beforeLen)

      // Try both search patterns:
      //   \r\n__CLAUDE__  — PowerShell (actual output after echoed command)
      //   \r__CLAUDE__    — Linux/bash (bracketed paste inserts \r before output)
      // Neither matches the echoed command (which has "__CLAUDE__")
      let idx = raw.indexOf('\r\n__CLAUDE__')
      if (idx === -1) {
        idx = raw.indexOf('\r__CLAUDE__')
      }
      if (idx !== -1) {
        const after = raw.slice(idx)
        if (after.includes(markerCheck)) {
          const endOfLine = after.indexOf('\n')
          const metaEnd = endOfLine !== -1 ? idx + endOfLine + 1 : raw.length
          return raw.slice(0, metaEnd)
        }
      }
      await this.sleep(15)
    }

    throw new Error(`PTY command timed out after ${timeout}ms`)
  }

  // Find the __CLAUDE__ marker in the actual output (not the echoed command)
  // Actual output has \r or \n before __CLAUDE__; echoed command has "
  private findActualMarker(raw: string): number {
    const markerEnd = '__CLAUDE__'
    let pos = 0
    while (true) {
      const idx = raw.indexOf(markerEnd, pos)
      if (idx === -1) return -1
      const prev = idx > 0 ? raw[idx - 1] : ''
      if (prev === '\r' || prev === '\n') return idx
      pos = idx + 1
    }
  }

  private parseOutput(
    raw: string,
    marker: string,
  ): { stdout: string; exitCode: number; cwd: string } {
    const metaMatch = raw.match(/__CLAUDE__(\d+)\|(.+?)\|(.+?)\|__/)
    const exitCode = metaMatch ? parseInt(metaMatch[1], 10) : 0
    const cwd = metaMatch?.[2] || ''

    // Find the actual output's __CLAUDE__ (not the echoed command's)
    const metaIdx = this.findActualMarker(raw)
    const cmdSection = metaIdx !== -1 ? raw.slice(0, metaIdx) : raw
    const lines = cmdSection.split(/\r?\n/)
    // Remove echoed command (first line) and trailing empty (last line)
    const stdoutLines = lines.slice(1, -1)
    const stdout = stdoutLines.join('\r\n').trimEnd()

    return { stdout, exitCode, cwd }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms))
  }

  kill(): void {
    try {
      this.pty.kill()
    } catch { /* ignore */ }
  }
}

let globalSession: PtySession | null = null

export async function getPtySession(
  cwd: string,
  shellType: 'powershell' | 'bash' = 'powershell',
): Promise<PtySession> {
  if (globalSession) {
    try {
      await globalSession.exec('$null', 2000)
      return globalSession
    } catch {
      globalSession.kill()
      globalSession = null
    }
  }
  globalSession = await PtySession.create(cwd, shellType)
  return globalSession
}

export async function resetPtySession(): Promise<void> {
  if (globalSession) {
    globalSession.kill()
    globalSession = null
  }
}
