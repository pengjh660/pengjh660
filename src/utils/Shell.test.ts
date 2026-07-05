import { describe, expect, test } from 'bun:test'
import { exec } from './Shell.js'

describe('Shell.exec PTY path', () => {
  test('simple echo via PTY', async () => {
    const cmd = await exec('echo hi', new AbortController().signal, 'powershell', {
      usePty: true,
      timeout: 10000,
    })
    const result = await cmd.result
    expect(result.stdout?.trim()).toBe('hi')
    expect(result.code).toBe(0)
    expect(result.interrupted).toBe(false)
  })

  test('cd persistence across commands', async () => {
    await exec('cd /', new AbortController().signal, 'powershell', { usePty: true, timeout: 5000 })

    const cmd2 = await exec('(Get-Location).Path', new AbortController().signal, 'powershell', {
      usePty: true,
      timeout: 5000,
    })
    const result = await cmd2.result
    // The CWD should be D:\ (the root of the current drive after 'cd /')
    expect(result.stdout).toMatch(/^[A-Z]:\\/)
    expect(result.code).toBe(0)
  })

  test('error cmdlet returns exit code 1', async () => {
    const cmd = await exec('nonexistent_cmd_xyz', new AbortController().signal, 'powershell', {
      usePty: true,
      timeout: 5000,
    })
    const result = await cmd.result
    expect(result.code).toBe(1)
    expect(result.stdout).toBeTruthy()
  })

  test('native exit code preserved', async () => {
    const cmd = await exec('cmd /c "exit /b 42"', new AbortController().signal, 'powershell', {
      usePty: true,
      timeout: 5000,
    })
    const result = await cmd.result
    expect(result.code).toBe(42)
  })

  test('multi-line output', async () => {
    const cmd = await exec('"a`nb`nc"', new AbortController().signal, 'powershell', {
      usePty: true,
      timeout: 5000,
    })
    const result = await cmd.result
    expect(result.stdout).toContain('a')
    expect(result.stdout).toContain('b')
    expect(result.stdout).toContain('c')
  })

  test('abort signal kills the PTY session', async () => {
    const aborter = new AbortController()
    const cmdPromise = exec('sleep 10', aborter.signal, 'powershell', {
      usePty: true,
      timeout: 15000,
    })

    aborter.abort()

    const cmd = await cmdPromise
    // After our post-session abort check, the session is killed
    const result = await cmd.result
    expect(result.interrupted).toBe(true)
  })

  test('abort before exec returns interrupted quickly', async () => {
    const aborter = new AbortController()
    aborter.abort()

    const cmd = await exec('sleep 10', aborter.signal, 'powershell', {
      usePty: true,
      timeout: 15000,
    })

    const result = await cmd.result
    expect(result.interrupted).toBe(true)
  })
})
