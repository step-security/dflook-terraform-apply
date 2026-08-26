import { spawn } from 'child_process'

/**
 * Stand-in for `@actions/exec`.
 *
 * That package is ESM-only from v3, and these tests run as CommonJS, so it
 * cannot be imported directly. This exists to bridge that boundary — not to fake
 * anything: it really runs the command, so a test that exercises a command
 * runner is testing the runner rather than a mock of it.
 *
 * Only the subset the core uses is implemented.
 */

export interface ExecListeners {
  stdout?: (data: Buffer) => void
  stderr?: (data: Buffer) => void
}

export interface ExecOptions {
  cwd?: string
  env?: Record<string, string>
  /** Returns the exit code instead of throwing on a non-zero one. */
  ignoreReturnCode?: boolean
  silent?: boolean
  listeners?: ExecListeners
}

export const exec = async (
  command: string,
  args: string[] = [],
  options: ExecOptions = {}
): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? (process.env as Record<string, string>),
    })

    child.stdout.on('data', (data: Buffer) => options.listeners?.stdout?.(data))
    child.stderr.on('data', (data: Buffer) => options.listeners?.stderr?.(data))

    child.on('error', reject)
    child.on('close', (code) => {
      const exitCode = code ?? 0
      // Matching the real package: a non-zero exit is an error unless the caller
      // has said it reads the code itself.
      if (exitCode !== 0 && !options.ignoreReturnCode) {
        reject(new Error(`The process '${command}' failed with exit code ${exitCode}`))
        return
      }
      resolve(exitCode)
    })
  })
