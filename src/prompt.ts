export interface ChatMessage {
  role: string
  content?: string | ReadonlyArray<{ type?: string; text?: unknown }>
}

interface HistoryLimits {
  turns: number
  chars: number
}

export function historyLimits(options: { historyTurns?: number; historyChars?: number }): HistoryLimits {
  const count = (value: number | undefined, fallback: number) =>
    value !== undefined && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback
  return { turns: count(options.historyTurns, 16), chars: count(options.historyChars, 8_192) }
}

export function isAuxiliaryRequest(kind: unknown) {
  return kind === "title" || kind === "generate" || kind === "compaction"
}

export function textOf(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content
  if (!Array.isArray(message.content)) return ""
  return message.content
    .flatMap((part) => part?.type === "text" && typeof part.text === "string" && part.text ? [part.text] : [])
    .join("\n")
}

const conversational = (message: ChatMessage) => message.role === "user" || message.role === "assistant"
const speaker = (message: ChatMessage) => message.role === "assistant" ? "Assistant: " : "User: "

/**
 * Keep the current turn intact, plus the suffix needed to reconstruct bounded
 * replay. One extra history character lets the shim detect truncation without
 * losing the original clipping or sending the whole oldest retained message.
 */
export function boundedMessages<T extends ChatMessage>(
  messages: readonly T[],
  limits: HistoryLimits,
  includeSystem: boolean,
): Array<{ message: T; text: string }> {
  const kept: Array<{ message: T; text: string }> = []
  let latest = false
  let turns = 0
  let budget = limits.chars > 0 ? limits.chars + 1 : 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message) continue
    const historyFull = turns >= limits.turns || budget <= 0
    if (latest && historyFull && !includeSystem) break
    if (message.role === "system") {
      if (includeSystem) {
        const text = textOf(message)
        if (text.trim()) kept.push({ message, text })
      }
      continue
    }
    if (!conversational(message) || (latest && historyFull)) continue
    const text = textOf(message)
    if (!text.trim()) continue
    if (!latest) {
      kept.push({ message, text })
      latest = true
      continue
    }
    const tail = text.length > budget ? text.slice(-budget) : text
    // The visible prefix is clipped away; it keeps a whitespace-only tail
    // from being mistaken for an originally empty turn by the shim.
    kept.push({ message, text: tail.trim() ? tail : `…${tail}` })
    budget -= text.length + speaker(message).length + (turns > 0 ? 2 : 0)
    turns++
  }
  return kept.reverse()
}

function historyText(turns: Array<{ message: ChatMessage; text: string }>, chars: number) {
  const text = turns.map(({ message, text }) => `${speaker(message)}${text}`).join("\n\n")
  return text.length > chars ? `[...earlier history omitted...]\n\n${text.slice(-chars)}` : text
}

/** Recent visible turns for an OpenCode compaction summary. */
export function recentConversation(messages: ChatMessage[], limits: HistoryLimits) {
  if (!limits.turns || !limits.chars) return ""
  const turns = boundedMessages(messages, { ...limits, turns: limits.turns - 1 }, false)
  return historyText(turns, limits.chars)
}

/** Render both forms: only the manager knows whether the ACP session retained context. */
export function buildPrompts(messages: ChatMessage[], limits: HistoryLimits, includeSystem: boolean) {
  const turns = boundedMessages(messages, limits, includeSystem)
  const conversation = turns.filter(({ message }) => conversational(message))
  const latest = conversation.pop()?.text ?? ""
  const history = historyText(conversation, limits.chars)
  const system = turns.filter(({ message }) => message.role === "system").map(({ text }) => text).join("\n\n")
  return {
    fresh: [system && `System instructions:\n${system}`, history && `Conversation so far:\n\n${history}`, latest]
      .filter(Boolean).join("\n\n---\n\n"),
    reused: [system && `System instructions:\n${system}`, latest].filter(Boolean).join("\n\n---\n\n"),
  }
}
