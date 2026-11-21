import { expect, test } from "bun:test"
import { Schema } from "effect"
import { errorMessage } from "../src/util.ts"

const WorktreeError = Schema.TaggedError()("WorktreeError", {
  name: Schema.Literal("WorktreeError"),
  data: Schema.Struct({ message: Schema.String, forceRequired: Schema.optional(Schema.Boolean) }),
})

const circular: any = {}
circular.cause = circular

const cases: Array<[string, unknown, string]> = [
  ["plain Error", new Error("boom"), "boom"],
  [
    "tagged error data.message",
    new WorktreeError({
      name: "WorktreeError",
      data: { message: "Worktree directory unavailable: sha" },
    }),
    "Worktree directory unavailable: sha",
  ],
  [
    "tagged error with empty data.message falls back to _tag",
    new WorktreeError({ name: "WorktreeError", data: { message: "" } }),
    "WorktreeError",
  ],
  ["Error cause", new Error("", { cause: new Error("root cause") }), "root cause"],
  [
    "AggregateError",
    new AggregateError([new Error("first"), new Error("second")], ""),
    "first; second",
  ],
  ["empty Error", new Error(""), "Error"],
  ["nested plain object", { data: { message: "nested plain" } }, "nested plain"],
  ["plain object JSON", { code: 400 }, '{"code":400}'],
  ["empty string", "", "Unknown error"],
  ["whitespace string", "   ", "Unknown error"],
  ["null", null, "Unknown error"],
  ["undefined", undefined, "Unknown error"],
  ["empty object", {}, "Unknown error"],
  ["circular object", circular, "Unknown error"],
  ["null-prototype object", Object.create(null), "Unknown error"],
  ["empty cause falls through to name", new TypeError("", { cause: {} }), "TypeError"],
]

test("errorMessage returns a non-empty description for anything thrown", () => {
  for (const [label, value, expected] of cases) {
    expect({ label, message: errorMessage(value) }).toEqual({ label, message: expected })
  }
})
