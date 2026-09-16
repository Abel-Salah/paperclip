import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  runSecretRedactions,
} from "@paperclipai/db";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import {
  createRunSecretRedactionRegistry,
  farFutureRedactionExpiry,
  redactRegisteredSecretValues,
} from "../services/run-secret-redaction.js";
import { createRunSecretRedactionReaper } from "../services/run-secret-redaction-reaper.js";
import { mintAndRegisterRunBearer } from "../services/run-bearer.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// The registry moved off `heartbeat_runs.context_snapshot` and onto the
// company-scoped `run_secret_redactions` table (see
// packages/db/src/schema/run_secret_redactions.ts). These tests exercise the
// real table and the real Postgres query planner, because the acceptance bar
// for this move is index-backed lookups and a real `EXPLAIN` plan, not a
// mocked query builder.
describeEmbeddedPostgres("run secret redaction registry (company-scoped table)", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: Db;
  const previousAgentJwtSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;

  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "run-secret-redaction-test-secret";
    const started = await startEmbeddedPostgresTestDatabase("run-secret-redaction-");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousAgentJwtSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = previousAgentJwtSecret;
  });

  async function seedRun() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Run secret redaction",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Redaction agent",
      role: "engineer",
      adapterType: "claude_local",
      status: "idle",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      contextSnapshot: {},
    });
    return { companyId, agentId, runId };
  }

  async function rowsForRun(companyId: string, runId: string) {
    return db.select().from(runSecretRedactions)
      .where(and(eq(runSecretRedactions.companyId, companyId), eq(runSecretRedactions.runId, runId)));
  }

  it("registers a value and masks it on a later read of that run", async () => {
    const { companyId, runId } = await seedRun();
    const registry = createRunSecretRedactionRegistry(db);

    await registry.register(companyId, runId, secret, farFutureRedactionExpiry());

    const rows = await rowsForRun(companyId, runId);
    expect(rows).toHaveLength(1);
    expect(rows[0].fingerprintSha256).toBe(createHash("sha256").update(secret).digest("hex"));
    expect(JSON.stringify(rows[0].material)).not.toContain(secret);
    expect(await registry.redactForRun(companyId, runId, `token ${secret} in output`))
      .toBe(`token ${REDACTED_EVENT_VALUE} in output`);
  });

  it("is idempotent for the same run and value", async () => {
    const { companyId, runId } = await seedRun();
    const registry = createRunSecretRedactionRegistry(db);

    await Promise.all([
      registry.register(companyId, runId, "duplicate-secret", farFutureRedactionExpiry()),
      registry.register(companyId, runId, "duplicate-secret", farFutureRedactionExpiry()),
    ]);

    expect(await rowsForRun(companyId, runId)).toHaveLength(1);
  });

  it("keeps a separate row so a second run can mask the identical value too", async () => {
    const { companyId, runId: firstRunId } = await seedRun();
    const secondRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: secondRunId, companyId, agentId: (await db.select().from(agents).where(eq(agents.companyId, companyId)))[0]!.id,
      status: "running", contextSnapshot: {},
    });
    const registry = createRunSecretRedactionRegistry(db);

    await registry.register(companyId, firstRunId, "shared-secret", farFutureRedactionExpiry());
    await registry.register(companyId, secondRunId, "shared-secret", farFutureRedactionExpiry());

    expect(await rowsForRun(companyId, firstRunId)).toHaveLength(1);
    expect(await rowsForRun(companyId, secondRunId)).toHaveLength(1);
    expect(await registry.redactForRun(companyId, secondRunId, "shared-secret")).toBe(REDACTED_EVENT_VALUE);
  });

  it("fails closed when the run row does not exist and registers nothing", async () => {
    const { companyId } = await seedRun();
    await expect(
      createRunSecretRedactionRegistry(db).register(companyId, randomUUID(), "must-not-return", farFutureRedactionExpiry()),
    ).rejects.toThrow("Heartbeat run redaction registration failed");
  });

  it("redacts batched runs from their own registrations and enforces company scope", async () => {
    const first = await seedRun();
    const foreign = await seedRun();
    const registry = createRunSecretRedactionRegistry(db);
    await registry.register(first.companyId, first.runId, "first-secret-value", farFutureRedactionExpiry());
    await registry.register(foreign.companyId, foreign.runId, "foreign-secret-value", farFutureRedactionExpiry());

    const runs = [
      { id: first.runId, text: "first-secret-value foreign-secret-value" },
      { id: foreign.runId, text: "foreign-secret-value" },
    ];
    const redacted = await registry.redactForRuns(first.companyId, runs);
    expect(redacted[0].text).toBe(`${REDACTED_EVENT_VALUE} foreign-secret-value`);
    expect(redacted[1].text).toBe("foreign-secret-value");
  });

  it("masks a value registered under the legacy context_snapshot key for the deprecation window", async () => {
    const { companyId, runId } = await seedRun();
    const legacyFingerprint = createHash("sha256").update("legacy-secret").digest("hex");
    const provider = (await import("../secrets/provider-registry.js")).getSecretProvider("local_encrypted");
    const prepared = await provider.createSecret({ value: "legacy-secret" });
    await db.update(heartbeatRuns).set({
      contextSnapshot: {
        paperclipSecretRedactions: [{ fingerprintSha256: legacyFingerprint, material: prepared.material }],
      },
    }).where(eq(heartbeatRuns.id, runId));

    const registry = createRunSecretRedactionRegistry(db);
    expect(await registry.redactForRun(companyId, runId, "seen legacy-secret here"))
      .toBe(`seen ${REDACTED_EVENT_VALUE} here`);
    // A new registration on the same run writes only to the table.
    await registry.register(companyId, runId, "new-secret", farFutureRedactionExpiry());
    expect(await rowsForRun(companyId, runId)).toHaveLength(1);
    expect(await registry.redactForRun(companyId, runId, "legacy-secret and new-secret"))
      .toBe(`${REDACTED_EVENT_VALUE} and ${REDACTED_EVENT_VALUE}`);
  });

  it("returns no plaintext for a fingerprint-only row and does not throw", async () => {
    const { companyId, runId } = await seedRun();
    const registry = createRunSecretRedactionRegistry(db);
    await registry.register(companyId, runId, secret, new Date(0));

    await createRunSecretRedactionReaper(db).sweep();

    const [row] = await rowsForRun(companyId, runId);
    expect(row.material).toBeNull();
    await expect(registry.redactForRun(companyId, runId, `still has ${secret}`)).resolves.toBe(`still has ${secret}`);
  });

  describe("mintAndRegisterRunBearer", () => {
    it("registers the minted bearer with its real JWT expiry", async () => {
      const { companyId, agentId, runId } = await seedRun();
      const before = Date.now();

      const token = await mintAndRegisterRunBearer(db, agentId, companyId, "claude_local", runId, "user-1");

      expect(token).not.toBeNull();
      const [row] = await rowsForRun(companyId, runId);
      expect(row.fingerprintSha256).toBe(createHash("sha256").update(token!).digest("hex"));
      // Default TTL is 48h (server/src/agent-auth-jwt.ts). Assert it lands in
      // that neighbourhood rather than hardcoding an exact millisecond.
      const ttlMs = row.expiresAt.getTime() - before;
      expect(ttlMs).toBeGreaterThan(47 * 60 * 60 * 1000);
      expect(ttlMs).toBeLessThan(49 * 60 * 60 * 1000);
    });

    it("never surfaces the minted token text in the registration failure", async () => {
      const { companyId, agentId } = await seedRun();
      await expect(
        mintAndRegisterRunBearer(db, agentId, companyId, "claude_local", randomUUID(), "user-1"),
      ).rejects.toSatisfy((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        return !message.includes("token");
      });
    });
  });

  describe("expiry sweep", () => {
    it("clears expired material in a bounded, ordered batch and keeps the fingerprint", async () => {
      const { companyId, runId } = await seedRun();
      const registry = createRunSecretRedactionRegistry(db);
      await registry.register(companyId, runId, "expired-secret", new Date(Date.now() - 1000));
      await registry.register(companyId, runId, "still-live-secret", farFutureRedactionExpiry());

      const result = await createRunSecretRedactionReaper(db).sweep();

      expect(result.cleared).toBe(1);
      const rows = await rowsForRun(companyId, runId);
      const expired = rows.find((row) => row.fingerprintSha256 === createHash("sha256").update("expired-secret").digest("hex"));
      const stillLive = rows.find((row) => row.fingerprintSha256 === createHash("sha256").update("still-live-secret").digest("hex"));
      expect(expired?.material).toBeNull();
      expect(stillLive?.material).not.toBeNull();
    });

    it("orders a bounded batch by expiry so the oldest expired row clears first", async () => {
      const { companyId, runId } = await seedRun();
      const registry = createRunSecretRedactionRegistry(db);
      await registry.register(companyId, runId, "expired-later", new Date(Date.now() - 1000));
      await registry.register(companyId, runId, "expired-earlier", new Date(Date.now() - 60_000));

      const reaper = createRunSecretRedactionReaper(db, { batchSize: 1 });
      const result = await reaper.sweep();

      expect(result.cleared).toBe(1);
      const rows = await rowsForRun(companyId, runId);
      const earlier = rows.find((row) => row.fingerprintSha256 === createHash("sha256").update("expired-earlier").digest("hex"));
      const later = rows.find((row) => row.fingerprintSha256 === createHash("sha256").update("expired-later").digest("hex"));
      expect(earlier?.material).toBeNull();
      expect(later?.material).not.toBeNull();
    });

    it("leaves an unexpired row untouched", async () => {
      const { companyId, runId } = await seedRun();
      await createRunSecretRedactionRegistry(db).register(companyId, runId, secret, farFutureRedactionExpiry());

      const result = await createRunSecretRedactionReaper(db).sweep();

      expect(result.cleared).toBe(0);
      const [row] = await rowsForRun(companyId, runId);
      expect(row.material).not.toBeNull();
    });
  });
});
