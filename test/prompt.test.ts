import { expect, test } from "bun:test"
import { boundedMessages, buildPrompts, historyLimits } from "../src/prompt.ts"

const limits = historyLimits({})

test("drops OpenCode system blocks from user text sent to the agent", () => {
  const prompts = buildPrompts([
    {
      role: "user",
      content: [
        { type: "text", text: "Fix the login bug" },
        { type: "text", text: "<system-reminder>\nYou are in Plan mode.\n</system-reminder>" },
        { type: "text", text: '<system-reminder>Note: The user opened the file "a.ts".</system-reminder>' },
      ],
    },
    { role: "assistant", content: "Done." },
    { role: "user", content: "<system-update>\nAgent changed\n</system-update>\n\nNow add a test" },
  ], limits, false)
  expect(prompts.reused).toBe("Now add a test")
  expect(prompts.fresh).toBe("Conversation so far:\n\nUser: Fix the login bug\n\nAssistant: Done.\n\n---\n\nNow add a test")
})

test("never replays a mid-conversation OpenCode notice into a fresh ACP session", () => {
  // OpenCode's AI SDK adapter turns mid-conversation system messages into
  // separate user messages wrapped in <system-update>.
  const prompts = buildPrompts([
    { role: "user", content: "First task" },
    { role: "assistant", content: "Done." },
    {
      role: "user",
      content: [{
        type: "text",
        text: "<system-update>\nThe Code Mode tool catalog has changed. This catalog supersedes the previous Code Mode tool catalog.\n&lt;namespace name=\"browser\"&gt;\n</system-update>",
      }],
    },
    { role: "user", content: "Open the docs" },
  ], limits, false)
  expect(prompts.fresh).toBe("Conversation so far:\n\nUser: First task\n\nAssistant: Done.\n\n---\n\nOpen the docs")
  expect(prompts.reused).toBe("Open the docs")
})

test("keeps tags the user mentions inline", () => {
  const text = "Why does `<system-reminder>x</system-reminder>` show up in my logs?"
  expect(buildPrompts([{ role: "user", content: text }], limits, false).reused).toBe(text)
})

test("keeps every trailing user wake intact in one current turn", () => {
  const firstWake = `<subagent>\n${"Background finding. ".repeat(8)}\n</subagent>`
  const secondWake = "<subagent>\nThe docs build passed.\n</subagent>"
  const messages = [
    { role: "user", content: "Audit tools" },
    { role: "assistant", content: "Done." },
    { role: "user", content: firstWake },
    { role: "user", content: secondWake },
  ]
  const prompts = buildPrompts(messages, historyLimits({ historyChars: 40 }), false)
  expect(prompts.reused).toBe(`${firstWake}\n\n${secondWake}`)
  expect(prompts.fresh).toBe(
    `Conversation so far:\n\nUser: Audit tools\n\nAssistant: Done.\n\n---\n\n${firstWake}\n\n${secondWake}`,
  )

  const noHistory = buildPrompts(messages, historyLimits({ historyTurns: 0 }), false)
  expect(noHistory.reused).toBe(`${firstWake}\n\n${secondWake}`)
  expect(noHistory.fresh).toBe(`${firstWake}\n\n${secondWake}`)
})

test("a tool-only assistant turn keeps the earlier prompt out of the wake turn across both hops", () => {
  const firstWake = "<subagent>\nFirst wake.\n</subagent>"
  const secondWake = "<subagent>\nSecond wake.\n</subagent>"
  const messages = [
    { role: "user", content: "Earlier prompt" },
    { role: "assistant", content: "" },
    { role: "tool", content: "tool output" },
    { role: "user", content: firstWake },
    { role: "user", content: secondWake },
  ]
  // language-model.ts bounds the messages on their way to the shim, then the
  // shim builds the prompts. The boundary must survive both hops.
  const forwarded = boundedMessages(messages, limits, false).map(({ message, text }) => ({
    role: message.role,
    content: text,
  }))
  const prompts = buildPrompts(forwarded, limits, false)
  expect(prompts.reused).toBe(`${firstWake}\n\n${secondWake}`)
  expect(prompts.fresh).toBe(
    `Conversation so far:\n\nUser: Earlier prompt\n\n---\n\n${firstWake}\n\n${secondWake}`,
  )
})
