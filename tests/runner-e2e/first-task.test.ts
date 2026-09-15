import { main as judgeCommand } from "./first-task-judge.js";
import {
  firstTaskNativeRuntimePatch,
  provisionFirstTaskFixtures,
} from "./first-task-fixtures.js";
import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runnerMatrix } from "./catalog.js";
import { parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";
import { firstTaskScenario, FIRST_TASK_CASES } from "./first-task-cases.js";
import {
  digestText,
  snapshotInstruction,
  gradeFirstTask,
  type FirstTaskEvidence,
  type FirstTaskCheckpoint,
} from "./first-task-scoring.js";
import {
  FIRST_TASK_JUDGE_CONFIG,
  QUALITY_DIMENSIONS,
  judgeFirstTask,
  pendingQuality,
  validateQualityScores,
} from "./first-task-quality.js";
import { renderFirstTaskDetails } from "./first-task-report.js";
import {
  summarizeExecutionBilling,
  aggregateCampaignBilling,
} from "./billing.js";
import { packageEvidence } from "./evidence.js";
import type { RunnerE2EResult } from "./types.js";

function recording(caseId = "task-reply-accept"): FirstTaskEvidence {
  const scenario = firstTaskScenario(caseId, "test-nonce");
  const task = {
    id: "onboarding",
    status: "in_review",
    title: "Welcome",
    description: "/first-task",
  };
  const opening: FirstTaskCheckpoint = {
    id: "opening-0",
    phase: "opening",
    at: "2026-09-15T00:00:00Z",
    issueId: task.id,
    tasks: [task],
    agents: [{ id: "agent" }],
    comments: [
      { id: "greeting", authorAgentId: "agent", body: "Welcome to Paperclip" },
    ],
    interactions: [
      {
        id: "opening",
        kind: "ask_user_questions",
        status: "pending",
        payload: { questions: [{ id: "first-task-opening" }] },
      },
    ],
    documents: [],
    runs: [],
  };
  const response = structuredClone(opening);
  Object.assign(response, {
    id: "response-1",
    phase: "response",
    at: "2026-09-15T00:01:00Z",
    runs: [{ id: "parent-run", status: "succeeded" }],
  });
  response.comments.push({
    id: "proposal",
    authorAgentId: "agent",
    body: "I propose one subtask to write the garden club welcome note. Shall I proceed?",
  });
  response.interactions[0].status = "answered";
  const accepted = structuredClone(response);
  Object.assign(accepted, {
    id: "accepted-2",
    phase: "accepted",
    at: "2026-09-15T00:02:00Z",
  });
  accepted.comments.push({
    id: "yes",
    body: scenario.acceptance,
    authorUserId: "board",
  });
  const finished = structuredClone(accepted);
  Object.assign(finished, {
    id: "finished-3",
    phase: "finished",
    at: "2026-09-15T00:03:00Z",
  });
  finished.tasks.push({
    id: "child",
    title: "Garden welcome note",
    status: "done",
    description: "",
    parentId: "onboarding",
    assigneeAgentId: "agent",
    createdAt: "2026-09-15T00:02:02Z",
  } as any);
  finished.documents.push({
    id: "note",
    issueId: "child",
    key: "welcome",
    body: `Welcome beginners to our free Saturday meetup. ${scenario.marker}`,
  });
  finished.runs.push({ id: "child-run", status: "succeeded" });
  return {
    caseId,
    nonce: "test-nonce",
    onboardingIssueId: "onboarding",
    agentId: "agent",
    initialTaskIds: ["onboarding"],
    instructions: ["AGENTS.md", "first-task/SKILL.md"].map((p) => ({
      path: p,
      content: `Full ${p}`,
      sha256: digestText(`Full ${p}`),
    })),
    configuredModel: "configured-model",
    observedModels: ["observed-model"],
    checkpoints: [opening, response, accepted, finished],
    checks: [],
  };
}
function result(e = recording()): RunnerE2EResult {
  return {
    schema: "paperclip.runner-e2e.result/v2",
    suiteId: "first-task",
    executionId: `first-task.legacy-codex.local.${e.caseId}`,
    attempt: 1,
    status: "failed",
    profileId: "legacy-codex",
    environmentId: "local",
    caseId: e.caseId,
    provider: "openai",
    model: "observed-model",
    runtimeMode: "legacy",
    runIds: ["parent-run", "child-run"],
    startedAt: "2026-09-15T00:00:00Z",
    finishedAt: "2026-09-15T00:03:00Z",
    durationMs: 180000,
    cleanup: "passed",
    firstTask: e,
    usage: {
      runs: [
        {
          runId: "parent-run",
          usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.01 },
        },
        {
          runId: "child-run",
          usage: { inputTokens: 200, outputTokens: 40, costUsd: 0.02 },
        },
      ],
    },
  };
}
const failed = (e: FirstTaskEvidence) =>
  gradeFirstTask(e)
    .filter((c) => !c.passed)
    .map((c) => c.id);
const scores = () =>
  QUALITY_DIMENSIONS.map((dimension) => ({
    dimension,
    score: 4,
    rationale: "Concrete and relevant",
    evidence: ["response-1"],
  }));

describe("first-task fixtures and state grading", () => {
  it("recognizes a proposed task presented only in a confirmation card", () => {
    const e = recording("clear-task-first-response");
    e.checkpoints = e.checkpoints.slice(0, 2);
    e.checkpoints[1].comments.pop();
    e.checkpoints[1].interactions.push({
      id: "proposal-card",
      kind: "request_confirmation",
      status: "pending",
      payload: {
        prompt:
          "Proposed task: Write a two-sentence welcome note for the neighborhood garden club that invites beginners to the free Saturday meetup. I will save the finished note as a document attached to FIR-1. Approve this task so I can create it.",
      },
    });
    expect(failed(e)).toEqual([]);
  });

  it("does not count a completion update mentioning this task as a proposal", () => {
    const e = recording("clear-task-first-response");
    e.checkpoints = e.checkpoints.slice(0, 2);
    e.checkpoints[1].comments.at(-1)!.body =
      "Your welcome note is written and saved on this task. Is this welcome note good to use?";
    expect(failed(e)).toContain("subtask-proposal");
  });

  it("allows a proposal document before acceptance but never counts it as finished output", () => {
    const e = recording();
    const proposal = {
      id: "proposal-document",
      key: "first-task-proposal",
      title: "Proposed task: Garden club welcome note",
      body: `## Proposed task\n\nCreate a welcome note for Saturday. Include ${firstTaskScenario(e.caseId, e.nonce).marker}.`,
      issueId: "child",
    };
    e.checkpoints[1].documents.push(proposal);
    expect(failed(e)).toEqual([]);
    e.checkpoints[3].documents = [proposal];
    expect(failed(e)).toContain("durable-completion");
    e.checkpoints[1].documents.push({
      id: "finished-note",
      key: "welcome",
      body: "Welcome to our club.",
    });
    expect(failed(e)).toContain("no-premature-work");
  });

  it("provisions secret references without creating or rewriting the production agent", async () => {
    const execution = runnerMatrix.find(
      (e) => e.suite.id === "first-task" && e.profile.id === "legacy-codex",
    )!;
    const get = vi.fn().mockResolvedValue([{ id: "local", driver: "local" }]);
    const postSensitive = vi.fn().mockResolvedValue({ id: "encrypted-secret" });
    const fixtures = await provisionFirstTaskFixtures({
      api: { get, postSensitive },
      execution,
      nonce: "test",
      company: {
        id: "ui-created-company",
        name: "First task test",
        issuePrefix: "FIRST",
      },
      credentials: { OPENAI_API_KEY: "fixture-key" },
    });
    expect(get).toHaveBeenCalledExactlyOnceWith(
      "/api/companies/ui-created-company/environments?driver=local",
    );
    expect(postSensitive).toHaveBeenCalledExactlyOnceWith(
      "/api/companies/ui-created-company/secrets",
      expect.objectContaining({ key: "OPENAI_API_KEY", value: "fixture-key" }),
    );
    expect(fixtures.secretRefs.OPENAI_API_KEY).toEqual({
      type: "secret_ref",
      secretId: "encrypted-secret",
      version: "latest",
    });
    expect(fixtures.agent.id).toBe("");
    expect(JSON.stringify(fixtures)).not.toContain("fixture-key");
    await expect(
      provisionFirstTaskFixtures({
        api: { get, postSensitive },
        execution,
        nonce: "test",
        company: fixtures.company,
        credentials: {},
      }),
    ).rejects.toThrow("Missing credential");
    expect(postSensitive).toHaveBeenCalledTimes(1);
  });

  it.each(["runner-codex", "runner-acpx-claude"])(
    "switches only the runtime for %s, preserving onboarding assets and the default model",
    (id) => {
      const execution = runnerMatrix.find(
        (e) => e.suite.id === "first-task" && e.profile.id === id,
      )!;
      const secret = {
        type: "secret_ref" as const,
        secretId: "saved-key",
        version: "latest" as const,
      };
      const fixtures = {
        company: { id: "company", name: "Garden" },
        environment: { id: "local", driver: "local" },
        agent: { id: "agent", companyId: "company", name: "Lead" },
        secretRefs: { [execution.profile.credential]: secret },
        teardown: async () => {},
      };
      const original = {
        adapterConfig: {
          instructionsFilePath: "/managed/AGENTS.md",
          paperclipSkillSync: { desiredSkills: ["first-task"] },
          model: null,
        },
        permissions: { canCreateAgents: true },
      };
      const patch = firstTaskNativeRuntimePatch(execution, fixtures, original);
      expect(Object.keys(patch).sort()).toEqual([
        "adapterConfig",
        "adapterType",
      ]);
      expect(patch.adapterType).toBe("paperclip_runner");
      expect(patch.adapterConfig).toMatchObject({
        instructionsFilePath: "/managed/AGENTS.md",
        paperclipSkillSync: original.adapterConfig.paperclipSkillSync,
        provider: execution.profile.provider,
      });
      expect(patch.adapterConfig).not.toHaveProperty("model");
      const withOperational = firstTaskNativeRuntimePatch(execution, fixtures, {
        adapterConfig: {
          paperclipSkillSync: {
            desiredSkills: [
              "paperclipai/paperclip/paperclip",
              "paperclipai/paperclip/first-task",
            ],
          },
        },
      });
      expect(
        (
          withOperational.adapterConfig.paperclipSkillSync as {
            desiredSkills: string[];
          }
        ).desiredSkills,
      ).toEqual(["paperclipai/paperclip/first-task"]);
      expect(patch).not.toHaveProperty("instructionsBundle");
      expect(
        (patch.adapterConfig.env as Record<string, unknown>)[
          execution.profile.credential
        ],
      ).toEqual(secret);
      if (id === "runner-codex")
        expect(
          (patch.adapterConfig.env as Record<string, unknown>).CODEX_API_KEY,
        ).toEqual(secret);
      expect(
        firstTaskNativeRuntimePatch(execution, fixtures, {
          adapterConfig: { model: "chosen-by-user" },
        }).adapterConfig.model,
      ).toBe("chosen-by-user");
    },
  );

  it("selects exactly 48 local cells with one worker by default", () => {
    const options = parseRunnerSelectors(["--suite", "first-task"]);
    const cells = selectRunnerExecutions(options);
    expect(cells).toHaveLength(48);
    expect(options.maxParallel).toBe(1);
    expect(new Set(cells.map((c) => c.profile.id))).toEqual(
      new Set([
        "legacy-codex",
        "legacy-claude",
        "runner-codex",
        "runner-acpx-claude",
      ]),
    );
    expect(
      cells.every(
        (c) =>
          c.environment.id === "local" &&
          c.task.flow === "first_task" &&
          c.task.attemptTimeoutMs.local <= 900000,
      ),
    ).toBe(true);
    expect(
      selectRunnerExecutions(
        parseRunnerSelectors([
          "--suite",
          "first-task",
          "--profile",
          "legacy-codex",
          "--case",
          "clear-task-first-response",
        ]),
      ),
    ).toHaveLength(1);
  });
  it("keeps fixed facts and stable case identities for separate campaigns", () => {
    expect(FIRST_TASK_CASES).toHaveLength(12);
    expect(
      FIRST_TASK_CASES.map((c) => firstTaskScenario(c[0], "same")),
    ).toEqual(FIRST_TASK_CASES.map((c) => firstTaskScenario(c[0], "same")));
    const scenario = firstTaskScenario("revise-accept", "same");
    expect(scenario.revision).toContain("have not accepted");
    expect(scenario.facts).not.toContain("accept");
    expect(
      firstTaskScenario("clear-task-first-response", "x").firstResponseOnly,
    ).toBe(true);
    expect(() => firstTaskScenario("missing", "x")).toThrow();
    expect(
      runnerMatrix
        .filter((c) => c.suite.id === "first-task")
        .every((c) => !c.task.buildPrompt("x").includes("QA")),
    ).toBe(true);
  });
  it("passes a recorded accepted journey, including child execution", () =>
    expect(failed(recording())).toEqual([]));
  it("supports persisted card approval, but not merely a resolved question", () => {
    const e = recording("task-card-accept");
    const accepted = e.checkpoints[2];
    accepted.comments.pop();
    accepted.interactions.push({
      id: "confirm",
      kind: "request_confirmation",
      status: "accepted",
      result: { outcome: "accepted" },
    });
    expect(failed(e)).toEqual([]);
    accepted.interactions.at(-1)!.status = "pending";
    expect(failed(e)).toContain("acceptance-recorded");
    accepted.interactions.at(-1)!.status = "accepted";
    accepted.interactions.at(-1)!.kind = "ask_user_questions";
    expect(failed(e)).toContain("acceptance-recorded");
  });
  it("fails premature execution even if later accepted", () => {
    const e = recording();
    e.checkpoints[1].tasks.push(e.checkpoints[3].tasks[1]);
    expect(failed(e)).toContain("no-premature-work");
    e.checkpoints[1].tasks.pop();
    e.checkpoints[3].tasks[1].createdAt = "2026-09-15T00:01:02Z";
    expect(failed(e)).toContain("creation-after-acceptance");
  });
  it("does not mistake clarification answers for acceptance", () => {
    const e = recording("clarify-propose-accept");
    e.checkpoints[2].comments.at(-1)!.body = firstTaskScenario(
      e.caseId,
      e.nonce,
    ).facts;
    expect(failed(e)).toContain("acceptance-recorded");
    e.checkpoints[2].phase = "clarified";
    expect(failed(e)).toContain("no-premature-work");
  });
  it("fails duplicate or incorrectly assigned subtasks and missing output", () => {
    const e = recording();
    e.checkpoints[3].tasks.push({
      ...e.checkpoints[3].tasks[1],
      id: "duplicate",
    });
    expect(failed(e)).toContain("one-scoped-subtask");
    e.checkpoints[3].tasks.pop();
    e.checkpoints[3].tasks[1].assigneeAgentId = "other";
    expect(failed(e)).toContain("one-scoped-subtask");
    e.checkpoints[3].documents = [];
    expect(failed(e)).toContain("durable-completion");
  });
  it("fails rejected or superseded work that executes", () => {
    const e = recording("reject-no-execution");
    e.checkpoints[2].phase = "rejected";
    expect(failed(e)).toContain("rejection-respected");
    const revised = recording("revise-accept");
    expect(failed(revised)).toContain("durable-completion");
    revised.checkpoints[3].documents[0].body = `Welcome Sunday ${firstTaskScenario(revised.caseId, revised.nonce).marker}`;
    expect(failed(revised)).not.toContain("durable-completion");
  });
  it("keeps source and display hashes distinct when instruction examples are redacted", () => {
    const content = 'curl -H "Authorization: Bearer some-example-token"';
    const snapshot = snapshotInstruction("paperclip/SKILL.md", content);
    expect(snapshot.redacted).toBe(true);
    expect(snapshot.sha256).toBe(digestText(content));
    expect(snapshot.contentSha256).toBe(digestText(snapshot.content));
    const e = recording();
    e.instructions.push(snapshot);
    expect(failed(e)).toEqual([]);
  });
  it("grades only the initial response for first-response cases and validates snapshots", () => {
    const e = recording("clear-task-first-response");
    e.checkpoints = e.checkpoints.slice(0, 2);
    expect(failed(e)).toEqual([]);
    e.instructions[0].content = "Changed after capture";
    expect(failed(e)).toEqual(["instruction-snapshot"]);
  });
  it("requires 3–4 interview questions and a requested durable plan", () => {
    const e = recording("interview-first-response");
    e.checkpoints = e.checkpoints.slice(0, 2);
    expect(failed(e)).toContain("interview-questions");
    e.checkpoints[1].interactions.push({
      id: "questions",
      kind: "ask_user_questions",
      payload: { questions: [1, 2, 3] },
    });
    expect(failed(e)).toEqual([]);
    e.caseId = "plan-first-response";
    expect(failed(e)).toContain("durable-plan");
    e.checkpoints[1].documents.push({
      id: "plan",
      key: "plan",
      body: "A concrete plan",
    });
    expect(failed(e)).toEqual([]);
    e.checkpoints[1].documents[0].key = "garden-club-welcome-plan";
    e.checkpoints[1].documents[0].title = "Garden Club Welcome Note Plan";
    expect(failed(e)).toEqual([]);
  });
});
describe("first-task informational judging and reporting", () => {
  it("records spend reservation before the judge call and prevents a second paid attempt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "first-task-judge-"));
    const target = path.join(root, "result.json");
    const priorKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "fixture-judge-key";
    await writeFile(target, JSON.stringify(result()));
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => {
        const pending = JSON.parse(await readFile(target, "utf8"));
        expect(pending.firstTaskQuality.status).toBe("pending");
        expect(pending.billing.judge.reservedCostUsd).toBeGreaterThan(0);
        return new Response(
          JSON.stringify({
            status: "completed",
            model: FIRST_TASK_JUDGE_CONFIG.model,
            usage: { input_tokens: 1000, output_tokens: 200 },
            output: [
              {
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify({ scores: scores() }),
                  },
                ],
              },
            ],
          }),
          { status: 200 },
        );
      });
    try {
      await judgeCommand(["--result", target, "--max-dollars", "1"]);
      const retained = JSON.parse(await readFile(target, "utf8"));
      expect(retained.status).toBe("failed");
      expect(retained.firstTaskQuality.status).toBe("completed");
      expect(retained.billing.judge.estimatedCostUsd).toBe(0.0036);
      await expect(
        judgeCommand(["--result", target, "--max-dollars", "1"]),
      ).rejects.toThrow("already recorded");
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      fetcher.mockRestore();
      if (priorKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = priorKey;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires an explicit sufficient budget and valid checkpoint citations", () => {
    const e = recording();
    expect(() => pendingQuality(e, 0)).toThrow();
    expect(() => pendingQuality(e, 0.000001)).toThrow(/bound/);
    expect(validateQualityScores({ scores: scores() }, e)).toHaveLength(5);
    const bad = scores();
    bad[0].evidence = ["invented"];
    expect(() => validateQualityScores({ scores: bad }, e)).toThrow(/evidence/);
    bad[0].evidence = ["response-1"];
    bad[0].score = 6;
    expect(() => validateQualityScores({ scores: bad }, e)).toThrow();
  });
  it("makes one isolated judge call, includes usage, and preserves behavior failures", async () => {
    const e = recording();
    const response = {
      status: "completed",
      model: FIRST_TASK_JUDGE_CONFIG.model,
      usage: { input_tokens: 1000, output_tokens: 200 },
      output: [
        {
          content: [
            { type: "output_text", text: JSON.stringify({ scores: scores() }) },
          ],
        },
      ],
    };
    const fetcher = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => response });
    const quality = await judgeFirstTask(
      e,
      pendingQuality(e, 1),
      "fixture-key",
      fetcher,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(quality.status).toBe("completed");
    expect(quality.estimatedCostUsd).toBe(0.0036);
    const r = { ...result(e), firstTaskQuality: quality };
    expect(r.status).toBe("failed");
    const bill = summarizeExecutionBilling(r);
    expect(bill.llm.runCount).toBe(2);
    expect(bill.reportedCostUsd).toBe(0.03);
    expect(bill.judge?.inputTokens).toBe(1000);
    expect(bill.observedAndEstimatedCostUsd).toBeCloseTo(0.0336);
    expect(
      aggregateCampaignBilling([r]).observedAndEstimatedCostUsd,
    ).toBeCloseTo(0.0336);
    expect(aggregateCampaignBilling([r]).judge).toMatchObject({
      attempts: 1,
      inputTokens: 1000,
      outputTokens: 200,
      attemptsWithUnknownUsage: 0,
    });
  });
  it("reserves spend on unknown failure, retains usage on invalid scores, never retries", async () => {
    const e = recording();
    const fetcher = vi
      .fn()
      .mockRejectedValue(new Error("sensitive provider failure"));
    const q = await judgeFirstTask(
      e,
      pendingQuality(e, 1),
      "fixture-key",
      fetcher,
    );
    expect(q.status).toBe("failed");
    expect(q.estimatedCostUsd).toBeNull();
    expect(q.reservedCostUsd).toBeGreaterThan(0);
    expect(JSON.stringify(q)).not.toContain("sensitive");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(
      summarizeExecutionBilling({ ...result(e), firstTaskQuality: q }).complete,
    ).toBe(false);
  });
  it("renders full instructions, durable output and citations without calling a provider", () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("No model calls during rendering"));
    try {
      const e = recording();
      e.instructions[0].content = '<script>alert("bad")</script>';
      const q = {
        ...pendingQuality(e, 1),
        status: "completed" as const,
        scores: scores(),
      };
      const rendered = renderFirstTaskDetails({
        ...result(e),
        firstTaskQuality: q,
      });
      expect(rendered).toContain("&lt;script&gt;");
      expect(rendered).not.toContain("<script>alert");
      expect(rendered).toContain("Approval timeline");
      expect(rendered).toContain("GARDENtestnonce");
      expect(rendered).toContain("response-1");
      expect(rendered).toContain("informational");
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      fetcher.mockRestore();
    }
  });
  it("packages instruction evidence and the first-response screenshot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "first-task-evidence-"));
    try {
      const source = path.join(root, "source");
      const destination = path.join(root, "public");
      await mkdir(path.join(source, "snapshots"), { recursive: true });
      await writeFile(
        path.join(source, "snapshots", "first-task.json"),
        JSON.stringify(recording()),
      );
      await writeFile(
        path.join(source, "first-task-response.png"),
        Buffer.from("fixture-image"),
      );
      const packaged = await packageEvidence({
        privateDir: source,
        uploadDir: destination,
        secrets: [],
        expectPassScreenshot: false,
      });
      expect(packaged.leaks).toEqual([]);
      expect(
        await readFile(
          path.join(destination, "snapshots", "first-task.json"),
          "utf8",
        ),
      ).toContain("first-task/SKILL.md");
      expect(packaged.files).toContain("first-task-response.png");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
