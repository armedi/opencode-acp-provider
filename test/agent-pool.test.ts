import { afterEach, expect, test } from "bun:test"
import { existsSync, realpathSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { AgentPool, type AgentLaunch, type AgentSubscriber } from "../src/agent-pool.ts"

const agentPath = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url))
const dirs: string[] = []
const pools: AgentPool[] = []

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.stop()))
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function temp(prefix = "acp-pool-") {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function pool(options?: ConstructorParameters<typeof AgentPool>[0]) {
  const instance = new AgentPool(options)
  pools.push(instance)
  return instance
}

function launch(pidFile: string, extra: Partial<AgentLaunch> = {}): AgentLaunch {
  return {
    command: process.execPath,
    args: [agentPath, "--pid-log", pidFile],
    cwd: tmpdir(),
    env: {},
    ...extra,
  }
}

async function pids(file: string) {
  const text = await readFile(file, "utf8").catch(() => "")
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) throw new Error("condition was not met in time")
    await wait(25)
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function recorder() {
  const logs: Array<{ level: string; message: string }> = []
  const exits: Error[] = []
  const subscriber: AgentSubscriber = {
    onLog: (level, message) => logs.push({ level, message }),
    onExit: (error) => exits.push(error),
  }
  return { logs, exits, subscriber }
}

test("equal launches share a client, different env or scope do not", () => {
  const pidFile = join(tmpdir(), "unused-pids")
  const agent = pool()
  const first = agent.acquire(launch(pidFile), {})
  const second = agent.acquire(launch(pidFile), {})
  expect(second.client).toBe(first.client)

  const otherEnv = agent.acquire(launch(pidFile, { env: { ACP_POOL_TEST: "different" } }), {})
  expect(otherEnv.client).not.toBe(first.client)

  const otherScope = agent.acquire(launch(pidFile, { scope: "scope" }), {})
  expect(otherScope.client).not.toBe(first.client)
})

test("with no linger, the last release ends the process and the next acquire starts over", async () => {
  const dir = await temp()
  const pidFile = join(dir, "pids")
  const agent = pool({ lingerMs: 0 })
  const lease = agent.acquire(launch(pidFile), {})
  await lease.client.start()
  const [pid] = await pids(pidFile)
  expect(pid).toBeDefined()
  expect(alive(Number(pid))).toBe(true)

  lease.release()
  await until(() => !alive(Number(pid)))

  const next = agent.acquire(launch(pidFile), {})
  expect(next.client).not.toBe(lease.client)
})

test("linger keeps the client for a re-acquire and drops it afterwards", async () => {
  const dir = await temp()
  const pidFile = join(dir, "pids")
  const agent = pool({ lingerMs: 500 })
  const lease = agent.acquire(launch(pidFile), {})
  await lease.client.start()
  lease.release()

  await wait(100)
  const again = agent.acquire(launch(pidFile), {})
  expect(again.client).toBe(lease.client)
  expect(await pids(pidFile)).toHaveLength(1)

  again.release()
  await wait(800)
  const fresh = agent.acquire(launch(pidFile), {})
  expect(fresh.client).not.toBe(lease.client)
})

test("onExit reaches every subscriber and onLog only the first", async () => {
  const dir = await temp()
  const pidFile = join(dir, "pids")
  const agent = pool()
  const first = recorder()
  const second = recorder()
  const leaseOne = agent.acquire(launch(pidFile), first.subscriber)
  const leaseTwo = agent.acquire(launch(pidFile), second.subscriber)
  expect(leaseTwo.client).toBe(leaseOne.client)
  await leaseOne.client.start()
  const [pid] = await pids(pidFile)

  process.kill(Number(pid), "SIGKILL")
  await until(() => first.exits.length > 0 && second.exits.length > 0, 2_000)
  expect(first.logs.length).toBeGreaterThan(0)
  expect(second.logs).toHaveLength(0)
})

test("a dedicated lease adopts the warm spare and links its skills directory", async () => {
  const dir = await temp()
  const pidFile = join(dir, "pids")
  const skillsA = await temp("acp-skills-a-")
  const skillsB = await temp("acp-skills-b-")
  const launchDirs: Array<string | undefined> = []
  const template = (skillDir: string) => ({
    skillDir,
    launch: (dirArgument: string | undefined) => {
      launchDirs.push(dirArgument)
      return launch(pidFile)
    },
  })
  const agent = pool({ spares: true, tmpDir: dir })

  const leaseOne = agent.dedicated(template(skillsA), {})
  await leaseOne.client.start()
  await until(async () => (await pids(pidFile)).length === 2)
  const [, sparePid] = await pids(pidFile)
  expect(alive(Number(sparePid))).toBe(true)

  const leaseTwo = agent.dedicated(template(skillsB), {})
  expect(leaseTwo.client).not.toBe(leaseOne.client)
  expect(leaseTwo.client.alive).toBe(true)
  expect(leaseTwo.readRoots).toHaveLength(1)
  expect(launchDirs).toContain(join(leaseTwo.readRoots[0], "skills"))
  expect(realpathSync(join(leaseTwo.readRoots[0], "skills"))).toBe(realpathSync(skillsB))

  leaseTwo.release()
  await until(() => !existsSync(leaseTwo.readRoots[0]))
  expect(existsSync(skillsB)).toBe(true)
})

test("an idle spare that dies is forgotten", async () => {
  const dir = await temp()
  const pidFile = join(dir, "pids")
  const skillsA = await temp("acp-skills-a-")
  const skillsB = await temp("acp-skills-b-")
  const launchDirs: Array<string | undefined> = []
  const template = (skillDir: string) => ({
    skillDir,
    launch: (dirArgument: string | undefined) => {
      launchDirs.push(dirArgument)
      return launch(pidFile)
    },
  })
  const agent = pool({ spares: true, tmpDir: dir })

  const lease = agent.dedicated(template(skillsA), {})
  await lease.client.start()
  await until(async () => (await pids(pidFile)).length === 2)
  const sparePid = Number((await pids(pidFile))[1])
  const spareLink = launchDirs.find((entry) => entry?.endsWith("skills"))!
  const spareDir = dirname(spareLink)

  process.kill(sparePid, "SIGKILL")
  await until(() => !existsSync(spareDir))

  const cold = agent.dedicated(template(skillsB), {})
  expect(cold.readRoots).toHaveLength(0)
})

test("a failed skill link falls back to a cold client and stops the spare", async () => {
  const dir = await temp()
  const pidFile = join(dir, "pids")
  const skillsA = await temp("acp-skills-a-")
  const skillsB = await temp("acp-skills-b-")
  const launchDirs: Array<string | undefined> = []
  const template = (skillDir: string) => ({
    skillDir,
    launch: (dirArgument: string | undefined) => {
      launchDirs.push(dirArgument)
      return launch(pidFile)
    },
  })
  const agent = pool({ spares: true, tmpDir: dir })

  const lease = agent.dedicated(template(skillsA), {})
  await lease.client.start()
  await until(async () => (await pids(pidFile)).length === 2)
  const sparePid = Number((await pids(pidFile))[1])
  const spareLink = launchDirs.find((entry) => entry?.endsWith("skills"))!
  await writeFile(spareLink, "not a directory")

  const warnings: string[] = []
  const cold = agent.dedicated(template(skillsB), {
    onLog: (level, message) => {
      if (level === "warn") warnings.push(message)
    },
  })
  expect(cold.readRoots).toHaveLength(0)
  expect(warnings.some((message) => message.includes("could not adopt"))).toBe(true)
  await until(() => !alive(sparePid))
})

test("without spares, two dedicated leases are independent processes", async () => {
  const dir = await temp()
  const pidFile = join(dir, "pids")
  const skills = await temp("acp-skills-")
  const template = {
    skillDir: skills,
    launch: () => launch(pidFile),
  }
  const agent = pool({ spares: false })
  const first = agent.dedicated(template, {})
  const second = agent.dedicated(template, {})
  expect(second.client).not.toBe(first.client)
  await first.client.start()
  await second.client.start()
  const [firstPid, secondPid] = await pids(pidFile)

  first.release()
  await until(() => !alive(Number(firstPid)))
  expect(alive(Number(secondPid))).toBe(true)
})

test("stop() rejects new leases and removes the process exit listener", async () => {
  const dir = await temp()
  const before = process.listenerCount("exit")
  const agent = pool()
  agent.acquire(launch(join(dir, "pids")), {})
  expect(process.listenerCount("exit")).toBe(before + 1)

  await agent.stop()
  expect(agent.stopped).toBe(true)
  expect(() => agent.acquire(launch(join(dir, "pids")), {})).toThrow("ACP agent pool is stopped")
  expect(() =>
    agent.dedicated({ launch: () => launch(join(dir, "pids")) }, {}),
  ).toThrow("ACP agent pool is stopped")
  expect(process.listenerCount("exit")).toBe(before)
})

test("module copies share one pool", async () => {
  const a = await import("../src/agent-pool.ts?copy=a")
  const b = await import("../src/agent-pool.ts?copy=b")
  expect(a.AgentPool).not.toBe(b.AgentPool)
  const first = a.sharedAgentPool()
  expect(b.sharedAgentPool()).toBe(first)
  await first.stop()
  const second = a.sharedAgentPool()
  expect(second).not.toBe(first)
  expect(second.stopped).toBe(false)
  await second.stop()
})
