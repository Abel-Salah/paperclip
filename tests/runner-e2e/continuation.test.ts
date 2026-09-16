import { describe, expect, it } from "vitest";
import {
  CONTINUATION_CASES,
  continuationScenario,
} from "./continuation-cases.js";
import {
  gradeContinuation,
  type ContinuationCheckpoint,
} from "./continuation-scoring.js";
import { runnerMatrix } from "./catalog.js";

function recording(id = "clarification-not-approval") {
  const scenario = continuationScenario(id, "nonce");
  const initial: ContinuationCheckpoint = {
    phase: "initial",
    issue: { id: "parent", status: "in_review" },
    children:
      id === "completed-action-resume"
        ? [
            {
              id: "child",
              title: scenario.childTitle,
              status: "done",
              assigneeAgentId: "agent",
            },
          ]
        : [],
    documents: [],
    attachments: [],
    comments: [],
    interactions: [],
    runs: [{ id: "first", status: "succeeded", runtimeMode: "native" }],
  };
  const answered = { ...structuredClone(initial), phase: "answered" as const };
  const final: ContinuationCheckpoint = {
    ...structuredClone(initial),
    phase: "final",
    issue: { id: "parent", status: "done" },
    documents: [
      {
        key: "output",
        body: `Welcome ${scenario.marker} at ${scenario.fact}.`,
        latestRevisionId: "revision",
      },
    ],
    runs: [
      ...initial.runs,
      { id: "second", status: "succeeded", runtimeMode: "native" },
    ],
  };
  return {
    ...scenario,
    runtimeMode: "native",
    checkpoints: scenario.gate ? [initial, answered, final] : [initial, final],
  };
}
const failures = (r: ReturnType<typeof recording>) =>
  gradeContinuation(r)
    .filter((c) => !c.passed)
    .map((c) => c.id);
describe("continuation behavioral evaluation", () => {
  it("registers all five cases for both runtime generations and providers", () => {
    const matrix = runnerMatrix.filter((c) => c.suite.id === "continuation");
    expect(matrix).toHaveLength(20);
    expect(new Set(matrix.map((c) => c.profile.id))).toEqual(
      new Set([
        "legacy-codex",
        "legacy-claude",
        "runner-codex",
        "runner-acpx-claude",
      ]),
    );
    expect(matrix.every((c) => !c.suite.manualOnly)).toBe(true);
  });
  it.each(CONTINUATION_CASES)("accepts a complete %s recording", (id) =>
    expect(failures(recording(id))).toEqual([]),
  );
  it("fails premature output even when the final result is correct", () => {
    const r = recording();
    r.checkpoints[0].documents.push({ key: "output", body: r.marker });
    expect(failures(r)).toContain("initial.no-premature-output");
  });
  it("fails mistaken approval from clarification", () => {
    const r = recording();
    r.checkpoints[1].issue.status = "done";
    expect(failures(r)).toContain("answered.no-premature-output");
  });
  it("fails scope revision that silently drops approval", () => {
    const r = recording("revision-preserves-approval");
    r.checkpoints.splice(1, 1);
    expect(failures(r)).toContain("approval-boundary-recorded");
  });
  it.each(["old", "injected"] as const)(
    "fails output containing the %s scope",
    (key) => {
      const r = recording("untrusted-evidence");
      r.checkpoints.at(-1)!.documents[0].body += r[key];
      expect(failures(r)).toContain("updated-output");
    },
  );
  it("fails duplicate child creation and replacement with an identical title", () => {
    const r = recording("completed-action-resume");
    r.checkpoints
      .at(-1)!
      .children.push({ ...r.checkpoints[0].children[0], id: "duplicate" });
    expect(failures(r)).toContain("reuse-completed-child");
    r.checkpoints.at(-1)!.children.shift();
    expect(failures(r)).toContain("reuse-completed-child");
  });
  it("does not pass by ignoring the untrusted file entirely", () => {
    const r = recording("untrusted-evidence");
    r.checkpoints.at(-1)!.documents[0].body = r.marker;
    expect(failures(r)).toContain("used-file-data");
  });
  it("fails missing durable output", () => {
    const r = recording();
    r.checkpoints.at(-1)!.documents = [];
    expect(failures(r)).toContain("updated-output");
  });
});
