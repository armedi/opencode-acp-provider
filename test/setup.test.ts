import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runSetup } from "../src/setup.ts"
import type { LogFn } from "../src/server-manager.ts"

const dirs: string[] = []

async function temp() {
  const dir = await mkdtemp(join(tmpdir(), "acp-setup-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function recorder() {
  const entries: Array<{ level: string; message: string }> = []
  const log: LogFn = (level, message) => {
    entries.push({ level, message })
  }
  return { entries, log, warnings: () => entries.filter((entry) => entry.level === "warn") }
}

test("runs an identical script once for concurrent callers", async () => {
  const dir = await temp()
  const counter = join(dir, "count")
  const script = `printf x >> '${counter}'`
  const { entries, log } = recorder()
  await Promise.all([runSetup(script, log), runSetup(script, log)])
  expect(await readFile(counter, "utf8")).toBe("x")
  expect(entries.filter((entry) => entry.message.startsWith("ACP setup: running"))).toHaveLength(1)
  expect(entries.some((entry) => entry.level === "info" && entry.message.includes("ACP setup finished"))).toBe(true)
})

test("runs different scripts in parallel", async () => {
  const dir = await temp()
  // Each script raises its own marker, then waits for the other's. A queue
  // between them means the first never sees the second and reports "queued".
  const script = (own: string, other: string, result: string) =>
    `touch '${own}'; i=0; while [ $i -lt 100 ] && [ ! -e '${other}' ]; do sleep 0.02; i=$((i+1)); done; ` +
    `if [ -e '${other}' ]; then printf ok > '${result}'; else printf queued > '${result}'; fi`
  const left = { ready: join(dir, "left.ready"), result: join(dir, "left.result") }
  const right = { ready: join(dir, "right.ready"), result: join(dir, "right.result") }
  await Promise.all([
    runSetup(script(left.ready, right.ready, left.result), recorder().log),
    runSetup(script(right.ready, left.ready, right.result), recorder().log),
  ])
  expect(await readFile(left.result, "utf8")).toBe("ok")
  expect(await readFile(right.result, "utf8")).toBe("ok")
})

test("logs a failing script and resolves anyway", async () => {
  const dir = await temp()
  const { log, warnings } = recorder()
  await runSetup(`cd '${dir}' && echo boom && exit 3`, log)
  const warn = warnings()
  expect(warn).toHaveLength(1)
  expect(warn[0].message).toContain("exit code 3")
  expect(warn[0].message).toContain("boom")
})

test("gives up on a script that runs past its timeout", async () => {
  const dir = await temp()
  const { log, warnings } = recorder()
  const startedAt = Date.now()
  await runSetup(`cd '${dir}' && sleep 5`, log, { timeoutMs: 200 })
  expect(Date.now() - startedAt).toBeLessThan(2_000)
  const warn = warnings()
  expect(warn).toHaveLength(1)
  expect(warn[0].message).toContain("timed out after 200ms")
})
