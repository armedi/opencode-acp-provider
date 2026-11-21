import type { ResolvedTool, ToolContext } from "./shared.ts"
import {
  booleanOf,
  editInput,
  finiteNumber,
  isOpencodeQuestionName,
  literal,
  patchInput,
  questionInput,
  readInput,
  record,
  shellInput,
  text,
  websearchInput,
  writeInput,
} from "./shared.ts"

export function resolveAntigravity(ctx: ToolContext): ResolvedTool | undefined {
  const name = ctx.topName ?? (ctx.priorAgent === "antigravity" ? ctx.priorRawName : undefined)
  if (!name) return undefined

  const raw = ctx.raw
  const resolved = (resolvedName: string, input: Record<string, unknown>): ResolvedTool => ({
    agent: "antigravity",
    rawName: name,
    name: resolvedName,
    input,
  })

  switch (name) {
    case "run_command":
      return resolved(
        "shell",
        shellInput({
          command: text(raw?.CommandLine),
          workdir: text(raw?.Cwd),
          timeout: finiteNumber(raw?.WaitMsBeforeAsync),
        }),
      )
    case "read_file":
      return resolved("read", readInput({ path: text(raw?.Path) ?? ctx.locationPath }))
    case "write_file": {
      if (raw?.Append === true) {
        const diff = ctx.diffs[0]
        return resolved(
          "edit",
          editInput({
            path: diff?.path ?? text(raw?.Path) ?? ctx.locationPath,
            oldString: diff ? (diff.oldText === null ? "" : diff.oldText) : undefined,
            newString: diff?.newText,
          }),
        )
      }
      return resolved("write", writeInput({ path: text(raw?.Path) ?? ctx.locationPath, content: literal(raw?.Content) }))
    }
    case "edit_file": {
      const path = text(raw?.Path) ?? ctx.locationPath
      const rawEdits = raw?.Edits
      if (Array.isArray(rawEdits)) {
        const valid = rawEdits
          .map((item) => record(item))
          .filter(
            (item): item is Record<string, unknown> =>
              item !== undefined &&
              (typeof item.TargetContent === "string" || typeof item.ReplacementContent === "string"),
          )
        if (valid.length > 1) {
          return resolved(
            "patch",
            path
              ? patchInput([
                  {
                    kind: "update",
                    path,
                    chunks: valid.map((edit) => ({
                      oldText: literal(edit.TargetContent) ?? "",
                      newText: literal(edit.ReplacementContent) ?? "",
                    })),
                  },
                ])
              : {},
          )
        }
        if (valid.length === 1) {
          return resolved(
            "edit",
            editInput({
              path,
              oldString: literal(valid[0].TargetContent),
              newString: literal(valid[0].ReplacementContent),
              replaceAll: booleanOf(raw?.AllowMultiple),
            }),
          )
        }
        return resolved("edit", editInput({ path }))
      }
      return resolved(
        "edit",
        editInput({
          path,
          oldString: literal(raw?.Target),
          newString: literal(raw?.Replacement),
          replaceAll: booleanOf(raw?.AllowMultiple),
        }),
      )
    }
    case "search_web":
      return resolved("websearch", websearchInput({ query: text(raw?.query) }))
    default:
      if (isOpencodeQuestionName(name)) return resolved("question", questionInput(raw))
      return resolved(name, raw ? { ...raw } : {})
  }
}
