import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import type { Db } from "@paperclipai/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { createRunSecretRedactionRegistry, redactRegisteredSecretValues } from "../services/run-secret-redaction.js";
import { mintAndRegisterRunBearer } from "../services/run-bearer.js";

const secret = "q2a-exact-secret-value";

describe("registered run secret redaction", () => {
  it("redacts exact values across comment and heartbeat/wake projections", () => {
    const result = redactRegisteredSecretValues({
      comment: { body: `agent pasted ${secret} in a comment` },
      heartbeatContext: {
        issue: { description: `do not expose ${secret}` },
        wakeComment: { body: secret },
      },
      wakePayload: {
        comments: [{ body: `prefix-${secret}-suffix` }],
        continuationSummary: { body: secret },
      },
    }, [secret]);

    expect(result).toEqual({
      comment: { body: `agent pasted ${REDACTED_EVENT_VALUE} in a comment` },
      heartbeatContext: {
        issue: { description: `do not expose ${REDACTED_EVENT_VALUE}` },
        wakeComment: { body: REDACTED_EVENT_VALUE },
      },
      wakePayload: {
        comments: [{ body: `prefix-${REDACTED_EVENT_VALUE}-suffix` }],
        continuationSummary: { body: REDACTED_EVENT_VALUE },
      },
    });
  });

  it("redacts run detail, event, and transcript fields and strips registry material", () => {
    const result = redactRegisteredSecretValues({
      contextSnapshot: {
        issueId: "issue-1",
        paperclipSecretRedactions: [{ material: { ciphertext: "encrypted" } }],
      },
      stdoutExcerpt: `stdout ${secret}`,
      events: [{ message: secret, payload: { output: secret } }],
      log: { content: `tool returned ${secret}` },
    }, [secret]);

    expect(result).toEqual({
      contextSnapshot: { issueId: "issue-1" },
      stdoutExcerpt: `stdout ${REDACTED_EVENT_VALUE}`,
      events: [{ message: REDACTED_EVENT_VALUE, payload: { output: REDACTED_EVENT_VALUE } }],
      log: { content: `tool returned ${REDACTED_EVENT_VALUE}` },
    });
  });

  it("replaces longer registered values before overlapping shorter values", () => {
    expect(redactRegisteredSecretValues("token-extended token", ["token-extended", "token"]))
      .toBe(`${REDACTED_EVENT_VALUE} ${REDACTED_EVENT_VALUE}`);
  });

  it("preserves Date instances instead of collapsing them to empty objects (PAP-16607)", () => {
    const createdAt = new Date("2026-08-06T12:00:00.000Z");
    const result = redactRegisteredSecretValues({
      comment: { body: `agent pasted ${secret}`, createdAt, updatedAt: createdAt },
      nested: [{ finishedAt: createdAt }],
    }, [secret]);

    expect(result.comment.createdAt).toBeInstanceOf(Date);
    expect(result.comment.createdAt.toISOString()).toBe("2026-08-06T12:00:00.000Z");
    expect(result.comment.updatedAt).toBeInstanceOf(Date);
    expect(result.nested[0]?.finishedAt).toBeInstanceOf(Date);
    expect(result.comment.body).toBe(`agent pasted ${REDACTED_EVENT_VALUE}`);
  });

  it("preserves Date instances when no secret values are registered", () => {
    const createdAt = new Date("2026-08-06T12:00:00.000Z");
    const result = redactRegisteredSecretValues({ createdAt }, []);
    expect(result.createdAt).toBeInstanceOf(Date);
    expect(result.createdAt.toISOString()).toBe("2026-08-06T12:00:00.000Z");
  });
});

const { resolveVersion, createSecret } = vi.hoisted(() => ({
  resolveVersion: vi.fn(async ({ material }) => material.value as string),
  createSecret: vi.fn(async ({ value }: { value: string }) => ({
    material: { value },
    valueSha256: createHash("sha256").update(value).digest("hex"),
    externalRef: null,
  })),
}));
vi.mock("../secrets/provider-registry.js", () => ({ getSecretProvider: () => ({ resolveVersion, createSecret }) }));

const { mintLocalAgentJwt } = vi.hoisted(() => ({ mintLocalAgentJwt: vi.fn() }));
vi.mock("../agent-auth-jwt.js", () => ({ createLocalAgentJwt: mintLocalAgentJwt }));

describe("batched run secret redaction", () => {
  beforeEach(() => { resolveVersion.mockClear(); });

  function fixture(rows: unknown[]) {
    const where = vi.fn(async (_predicate: import("drizzle-orm").SQL | undefined) => rows);
    const select = vi.fn((_columns: { contextSnapshot: import("drizzle-orm").SQL }) => ({ from: () => ({ where }) }));
    return { registry: createRunSecretRedactionRegistry({ select } as unknown as Db), select, where };
  }

  it("reads only registry JSON once for 200 runs and resolves shared secrets once", async () => {
    const contextSnapshot = { paperclipSecretRedactions: [{ fingerprintSha256: "shared", material: { value: secret } }] };
    const rows = Array.from({ length: 200 }, (_, i) => ({ id: `run-${i}`, contextSnapshot }));
    const { registry, select, where } = fixture(rows);
    const result = await registry.redactForRuns("company-1", rows.map(row => ({ ...row, stdoutExcerpt: secret })));
    expect(select).toHaveBeenCalledTimes(1);
    expect(resolveVersion).toHaveBeenCalledTimes(1);
    expect(result.every(run => run.stdoutExcerpt === REDACTED_EVENT_VALUE)).toBe(true);
    expect(result[0].contextSnapshot).toEqual({});
    const dialect = new PgDialect();
    const predicate = dialect.sqlToQuery(where.mock.calls[0][0]);
    expect(predicate.params).toContain("company-1");
    expect(predicate.sql).toContain('"company_id"');
    expect(dialect.sqlToQuery(select.mock.calls[0][0].contextSnapshot).sql).toContain("-> 'paperclipSecretRedactions'");
  });

  it("keeps each run's registry separate and observes new registrations on the next request", async () => {
    const rows = [{ id: "a", contextSnapshot: { paperclipSecretRedactions: [{ fingerprintSha256: "one", material: { value: secret } }] } }];
    const { registry } = fixture(rows);
    expect(await registry.redactForRuns("company", [{ id: "a", text: secret }, { id: "b", text: secret }]))
      .toEqual([{ id: "a", text: REDACTED_EVENT_VALUE }, { id: "b", text: secret }]);
    rows[0].contextSnapshot.paperclipSecretRedactions.push({ fingerprintSha256: "two", material: { value: "new-secret" } });
    expect(await registry.redactForRuns("company", [{ id: "a", text: "new-secret" }]))
      .toEqual([{ id: "a", text: REDACTED_EVENT_VALUE }]);
  });

  it("does not query for an empty list and fails closed on decryption failure", async () => {
    const { registry, select } = fixture([{ id: "a", contextSnapshot: { paperclipSecretRedactions: [{ fingerprintSha256: "one", material: {} }] } }]);
    expect(await registry.redactForRuns("company", [])).toEqual([]);
    expect(select).not.toHaveBeenCalled();
    resolveVersion.mockRejectedValueOnce(new Error("unavailable"));
    await expect(registry.redactForRuns("company", [{ id: "a", text: secret }])).rejects.toThrow("unavailable");
  });
});

// D8.1 — mint and register. `mintAndRegisterRunBearer` (server/src/services/run-bearer.js)
// is the wrapper every mint site must call instead of `createLocalAgentJwt`
// directly, so a minted bearer always reaches the redaction registry before a
// caller can use it.
describe("mintAndRegisterRunBearer", () => {
  const companyId = "company-1";
  const runId = "run-1";

  beforeEach(() => {
    mintLocalAgentJwt.mockReset();
    createSecret.mockClear();
  });

  // A fake `Db` that only implements the `transaction` shape `register()`
  // needs: a locked select of the run row, then an update of its
  // `contextSnapshot`. `row` is the current row seen inside the transaction,
  // or `null` to exercise the missing-run failure path.
  function fakeDb(row: { contextSnapshot: unknown } | null) {
    const selectWhere = vi.fn(() => ({ for: () => Promise.resolve(row ? [row] : []) }));
    const updateWhere = vi.fn(async () => {});
    const tx = {
      select: () => ({ from: () => ({ where: selectWhere }) }),
      update: () => ({ set: (values: unknown) => ({ where: (predicate: unknown) => updateWhere(values, predicate) }) }),
    };
    const db = { transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(tx) };
    return { db: db as unknown as Db, selectWhere, updateWhere };
  }

  it("registers the minted bearer against the given company and run, then returns it", async () => {
    const token = "minted-run-bearer-token";
    mintLocalAgentJwt.mockReturnValue(token);
    const { db, selectWhere, updateWhere } = fakeDb({ contextSnapshot: {} });

    const result = await mintAndRegisterRunBearer(db, "agent-1", companyId, "claude_local", runId, "user-1");

    expect(result).toBe(token);
    expect(selectWhere).toHaveBeenCalledTimes(1);
    const dialect = new PgDialect();
    const selectPredicate = dialect.sqlToQuery(selectWhere.mock.calls[0][0] as Parameters<typeof dialect.sqlToQuery>[0]);
    expect(selectPredicate.params).toContain(companyId);
    expect(selectPredicate.params).toContain(runId);

    expect(updateWhere).toHaveBeenCalledTimes(1);
    const [values] = updateWhere.mock.calls[0] as [{ contextSnapshot: { paperclipSecretRedactions: Array<{ fingerprintSha256: string }> } }, unknown];
    expect(values.contextSnapshot.paperclipSecretRedactions).toHaveLength(1);
    expect(values.contextSnapshot.paperclipSecretRedactions[0].fingerprintSha256)
      .toBe(createHash("sha256").update(token).digest("hex"));
    expect(createSecret).toHaveBeenCalledWith({ value: token });
  });

  it("passes the sixth scope argument through to the mint call", async () => {
    mintLocalAgentJwt.mockReturnValue("token-with-scope");
    const { db } = fakeDb({ contextSnapshot: {} });
    const scope = { kind: "skill_test" as const, issueId: "issue-1" };

    await mintAndRegisterRunBearer(db, "agent-1", companyId, "claude_local", runId, "user-1", scope);

    expect(mintLocalAgentJwt).toHaveBeenCalledWith("agent-1", companyId, "claude_local", runId, "user-1", scope);
  });

  it("returns null and registers nothing on the null-mint configuration path", async () => {
    mintLocalAgentJwt.mockReturnValue(null);
    const { db, selectWhere, updateWhere } = fakeDb({ contextSnapshot: {} });

    const result = await mintAndRegisterRunBearer(db, "agent-1", companyId, "claude_local", runId, "user-1");

    expect(result).toBeNull();
    expect(selectWhere).not.toHaveBeenCalled();
    expect(updateWhere).not.toHaveBeenCalled();
  });

  it("propagates a registration failure and returns no token", async () => {
    mintLocalAgentJwt.mockReturnValue("token-that-cannot-register");
    // `row: null` reproduces the registry's own missing-run failure
    // (server/src/services/run-secret-redaction.ts:103).
    const { db, updateWhere } = fakeDb(null);

    await expect(
      mintAndRegisterRunBearer(db, "agent-1", companyId, "claude_local", runId, "user-1"),
    ).rejects.toThrow("Heartbeat run redaction registration failed");
    expect(updateWhere).not.toHaveBeenCalled();
  });

  it("never surfaces the minted token text in the registration failure", async () => {
    mintLocalAgentJwt.mockReturnValue("must-not-leak-in-error-token");
    const { db } = fakeDb(null);

    await expect(
      mintAndRegisterRunBearer(db, "agent-1", companyId, "claude_local", runId, "user-1"),
    ).rejects.toSatisfy((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return !message.includes("must-not-leak-in-error-token");
    });
  });
});
