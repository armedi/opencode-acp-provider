import { spawn, type ChildProcess } from "node:child_process"
import { homedir } from "node:os"
import type { LogFn } from "./server-manager.ts"

const DEFAULT_TIMEOUT_MS = 300_000
const FAILURE_TAIL_LINES = 20

/**
 * One run per exact script string. A setup command installs or updates an
 * agent, so an identical command must not run again while it is in flight or
 * after it finished; different commands are independent and start in parallel.
 * The map lives for the plugin module, so an OpenCode server start or an
 * `opencode reload` starts a fresh one.
 */
const runs = new Map<string, Promise<void>>()

/**
 * Run an agent's setup command once per plugin-module lifetime. Never rejects:
 * a failed or timed-out command resolves too, so the agent still starts with
 * whatever is already installed.
 */
export function runSetup(script: string, log: LogFn, options: { timeoutMs?: number } = {}): Promise<void> {
  const existing = runs.get(script)
  if (existing) return existing
  const run = execute(script, log, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  runs.set(script, run)
  return run
}

function execute(script: string, log: LogFn, timeoutMs: number): Promise<void> {
  const startedAt = Date.now()
  log("info", `ACP setup: running ${script}`)
  return new Promise<void>((resolve) => {
    let child: ChildProcess
    let output = ""
    let settled = false
    let timedOut = false

    const finish = (failure?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (output.trim()) log("debug", `ACP setup output:\n${output.trimEnd()}`)
      if (failure) log("warn", `ACP setup failed: ${failure}${outputTail(output)}`)
      else log("info", `ACP setup finished in ${Date.now() - startedAt}ms: ${script}`)
      resolve()
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
      finish(`timed out after ${timeoutMs}ms`)
    }, timeoutMs)
    timer.unref?.()

    try {
      child = spawn("sh", ["-c", script], {
        cwd: homedir(),
        // stdin is ignored so a command that prompts cannot hang until the timeout.
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      })
    } catch (error) {
      finish(error instanceof Error ? error.message : String(error))
      return
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.on("error", (error) => finish(error.message))
    child.on("close", (code, signal) => {
      if (timedOut) return
      if (signal) finish(`killed by ${signal}`)
      else if (code !== 0) finish(`exit code ${code}`)
      else finish()
    })
  })
}

/** The last few lines of a failed command's combined output, for the warn log. */
function outputTail(output: string) {
  const lines = output.trimEnd().split("\n").filter((line) => line.trim())
  if (!lines.length) return ""
  return `\n${lines.slice(-FAILURE_TAIL_LINES).join("\n")}`
}
