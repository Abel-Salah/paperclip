import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
  redactAuthoredRunBearer,
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

  describe("fingerprint match masking", () => {
    // Shapes a JWT-like candidate: three non-empty base64url segments joined
    // by two dots, the same shape a run bearer has.
    function jwtShaped(seed: string): string {
      const segment = (label: string) => Buffer.from(`${label}-${seed}`).toString("base64url");
      return `${segment("header")}.${segment("payload")}.${segment("sig")}`;
    }

    it("masks a bearer registered on one issue's run when it is pasted into a different issue's text", async () => {
      const { companyId, agentId, runId: runOnIssueX } = await seedRun();
      await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: "issue-x" } })
        .where(eq(heartbeatRuns.id, runOnIssueX));
      const runOnIssueY = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runOnIssueY, companyId, agentId, status: "running", contextSnapshot: { issueId: "issue-y" },
      });
      const registry = createRunSecretRedactionRegistry(db);
      const bearer = jwtShaped("cross-issue");
      await registry.register(companyId, runOnIssueX, bearer, farFutureRedactionExpiry());

      const result = await registry.redactForIssue(companyId, "issue-y", `pasted ${bearer} here`);

      expect(result).toBe(`pasted ${REDACTED_EVENT_VALUE} here`);
    });

    it("still masks a bearer after the expiry sweep has cleared its row's material", async () => {
      const { companyId, runId } = await seedRun();
      const registry = createRunSecretRedactionRegistry(db);
      const bearer = jwtShaped("fingerprint-only");
      await registry.register(companyId, runId, bearer, new Date(0));

      await createRunSecretRedactionReaper(db).sweep();

      const [row] = await rowsForRun(companyId, runId);
      expect(row.material).toBeNull();
      expect(await registry.redactForRun(companyId, runId, `still has ${bearer}`))
        .toBe(`still has ${REDACTED_EVENT_VALUE}`);
    });

    it("never matches a fingerprint registered by another company", async () => {
      const companyA = await seedRun();
      const companyB = await seedRun();
      const registry = createRunSecretRedactionRegistry(db);
      const bearer = jwtShaped("cross-company");
      await registry.register(companyA.companyId, companyA.runId, bearer, farFutureRedactionExpiry());

      expect(await registry.redactForRun(companyB.companyId, companyB.runId, `token ${bearer} here`))
        .toBe(`token ${bearer} here`);
    });

    it("masks a bearer whose chain a dotted prefix word joins into a longer run", async () => {
      // Before the fix, the scanner took only the first three dot-joined
      // segments of a chain. "paperclip.local.<bearer>" then offered
      // "paperclip.local.<header>" as the sole candidate, and the real
      // bearer's own three segments were never offered to the digest
      // lookup, so it survived in plain text.
      const { companyId, runId } = await seedRun();
      const registry = createRunSecretRedactionRegistry(db);
      const bearer = jwtShaped("dot-prefix");
      await registry.register(companyId, runId, bearer, farFutureRedactionExpiry());

      const result = await registry.redactForRun(companyId, runId, `paperclip.local.${bearer}`);

      expect(result).toBe(`paperclip.local.${REDACTED_EVENT_VALUE}`);
    });

    it("masks a bearer glued to a preceding word by a hyphen and keeps the word's text before the match", async () => {
      // Before the fix, the scanner found only whole dot-joined segments.
      // The hyphen glued the word "run-" onto the bearer's first segment,
      // so the bearer's own first segment was never a segment of the
      // chain, and the digest lookup never ran on it.
      const { companyId, runId } = await seedRun();
      const registry = createRunSecretRedactionRegistry(db);
      const bearer = jwtShaped("hyphen-glued");
      await registry.register(companyId, runId, bearer, farFutureRedactionExpiry());

      const result = await registry.redactForRun(companyId, runId, `run-${bearer} finished`);

      expect(result).toBe(`run-${REDACTED_EVENT_VALUE} finished`);
    });

    it("masks a bearer glued to a preceding word by an underscore and keeps the word's text before the match", async () => {
      const { companyId, runId } = await seedRun();
      const registry = createRunSecretRedactionRegistry(db);
      const bearer = jwtShaped("underscore-glued");
      await registry.register(companyId, runId, bearer, farFutureRedactionExpiry());

      const result = await registry.redactForRun(companyId, runId, `tok_${bearer} finished`);

      expect(result).toBe(`tok_${REDACTED_EVENT_VALUE} finished`);
    });

    it("leaves an unregistered JWT-shaped string and a literal environment variable reference unchanged", async () => {
      const { companyId, runId } = await seedRun();
      const registry = createRunSecretRedactionRegistry(db);
      const unregistered = jwtShaped("never-registered");

      expect(await registry.redactForRun(companyId, runId, `${unregistered} and $PAPERCLIP_API_KEY`))
        .toBe(`${unregistered} and $PAPERCLIP_API_KEY`);
    });

    it("issues a bounded number of queries for a batch of many runs and still applies each run's own value pass", async () => {
      const { companyId, agentId } = await seedRun();
      const registry = createRunSecretRedactionRegistry(db);
      const runIds = await Promise.all(Array.from({ length: 20 }, async () => {
        const id = randomUUID();
        await db.insert(heartbeatRuns).values({ id, companyId, agentId, status: "running", contextSnapshot: {} });
        return id;
      }));
      const sharedBearer = jwtShaped("batch-shared");
      await registry.register(companyId, runIds[0]!, sharedBearer, farFutureRedactionExpiry());
      await registry.register(companyId, runIds[1]!, "own-value-secret", farFutureRedactionExpiry());

      const selectSpy = vi.spyOn(db, "select");
      const runs = runIds.map((id, index) => ({
        id,
        text: index === 1 ? `has own-value-secret and ${sharedBearer}` : `only ${sharedBearer}`,
      }));

      const redacted = await registry.redactForRuns(companyId, runs);

      expect(selectSpy.mock.calls.length).toBeLessThan(runIds.length);
      expect(redacted.every((run) => !run.text.includes(sharedBearer))).toBe(true);
      expect(redacted[1]!.text).not.toContain("own-value-secret");
      selectSpy.mockRestore();
    });
  });

  // The write-time redactor for an agent-authored comment body or issue
  // description. The read mask tests above already prove the cross-issue
  // paste and the fingerprint-only row cases; these tests cover the two
  // write-time arms and the text a false positive must never touch.
  describe("redactAuthoredRunBearer (write-time redaction)", () => {
    function jwtShaped(seed: string): string {
      const segment = (label: string) => Buffer.from(`${label}-${seed}`).toString("base64url");
      return `${segment("header")}.${segment("payload")}.${segment("sig")}`;
    }

    // A candidate whose first segment decodes as a real JWT header, the
    // shape the D4 fallback arm requires. `jwtShaped` above is enough for an
    // exact-match test, because that arm only compares hashes, but the
    // fallback arm needs the header to actually decode this way.
    function realJwtShaped(seed: string): string {
      const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
      const payload = Buffer.from(`payload-${seed}`).toString("base64url");
      const signature = Buffer.from(`sig-${seed}`).toString("base64url");
      return `${header}.${payload}.${signature}`;
    }

    it("redacts an exact registered bearer and keeps the header words", async () => {
      const { companyId, runId } = await seedRun();
      const registry = createRunSecretRedactionRegistry(db);
      const bearer = jwtShaped("write-exact");
      await registry.register(companyId, runId, bearer, farFutureRedactionExpiry());

      const result = await redactAuthoredRunBearer(db, companyId, `Authorization: Bearer ${bearer}`);

      expect(result).toBe(`Authorization: Bearer ${REDACTED_EVENT_VALUE}`);
    });

    it("redacts a JWT-shaped value the registry does not yet hold, via the narrow shape fallback", async () => {
      const unregistered = realJwtShaped("write-fallback");

      const result = await redactAuthoredRunBearer(db, randomUUID(), `Authorization: Bearer ${unregistered}`);

      expect(result).toBe(`Authorization: Bearer ${REDACTED_EVENT_VALUE}`);
    });

    it("redacts a registered bearer glued to a preceding word by a hyphen, keeping the word's text before the match", async () => {
      const { companyId, runId } = await seedRun();
      const registry = createRunSecretRedactionRegistry(db);
      const bearer = jwtShaped("write-hyphen-glued");
      await registry.register(companyId, runId, bearer, farFutureRedactionExpiry());

      const result = await redactAuthoredRunBearer(db, companyId, `see run-${bearer} in the log`);

      expect(result).toBe(`see run-${REDACTED_EVENT_VALUE} in the log`);
    });

    it("redacts a registered bearer glued to a preceding word by an underscore, keeping the word's text before the match", async () => {
      const { companyId, runId } = await seedRun();
      const registry = createRunSecretRedactionRegistry(db);
      const bearer = jwtShaped("write-underscore-glued");
      await registry.register(companyId, runId, bearer, farFutureRedactionExpiry());

      const result = await redactAuthoredRunBearer(db, companyId, `see tok_${bearer} in the log`);

      expect(result).toBe(`see tok_${REDACTED_EVENT_VALUE} in the log`);
    });

    it("leaves an unexpanded environment variable, its brace form, and the exact incident-report line unchanged", async () => {
      const companyId = randomUUID();

      await expect(redactAuthoredRunBearer(db, companyId, "$PAPERCLIP_API_KEY"))
        .resolves.toBe("$PAPERCLIP_API_KEY");
      await expect(redactAuthoredRunBearer(db, companyId, "${PAPERCLIP_API_KEY}"))
        .resolves.toBe("${PAPERCLIP_API_KEY}");
      await expect(redactAuthoredRunBearer(db, companyId, "Authorization: Bearer $PAPERCLIP_API_KEY"))
        .resolves.toBe("Authorization: Bearer $PAPERCLIP_API_KEY");
    });

    it("leaves a placeholder and the redaction marker unchanged", async () => {
      const companyId = randomUUID();

      await expect(redactAuthoredRunBearer(db, companyId, "Authorization: Bearer <token>"))
        .resolves.toBe("Authorization: Bearer <token>");
      await expect(redactAuthoredRunBearer(db, companyId, "Authorization: Bearer YOUR_TOKEN"))
        .resolves.toBe("Authorization: Bearer YOUR_TOKEN");
      await expect(redactAuthoredRunBearer(db, companyId, REDACTED_EVENT_VALUE))
        .resolves.toBe(REDACTED_EVENT_VALUE);
    });

    it("leaves an ordinary dotted identifier and a file name unchanged", async () => {
      const companyId = randomUUID();

      await expect(redactAuthoredRunBearer(db, companyId, "com.example.Foo.bar"))
        .resolves.toBe("com.example.Foo.bar");
      await expect(redactAuthoredRunBearer(db, companyId, "a.b.c"))
        .resolves.toBe("a.b.c");
    });

    it("propagates a failed fingerprint lookup instead of returning unredacted text", async () => {
      const bearer = jwtShaped("write-fail-closed");
      const failingDbOrTx = {
        select: () => {
          throw new Error("simulated fingerprint lookup failure");
        },
      } as unknown as Db;

      await expect(redactAuthoredRunBearer(failingDbOrTx, randomUUID(), `has ${bearer}`))
        .rejects.toThrow("simulated fingerprint lookup failure");
    });
  });

  // The scanner finds a registered bearer inside a chain by its own content,
  // an "eyJ" anchor at the start of its header segment, not only by the
  // character right before it. A named table names a regression in its
  // failure output; a property test generates many glue words instead of
  // one example per delimiter, so a new, unnamed glue word cannot reopen
  // this class the way a delimiter-specific fix did three times before.
  describe("bearer glued to a neighbouring word, closed by the header's own start anchor", () => {
    // A candidate whose header segment decodes as a real JWT header, the
    // shape the start anchor requires: every header this product mints
    // starts with the literal text "eyJ".
    function anchoredBearer(seed: string): string {
      const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
      const payload = Buffer.from(`payload-${seed}`).toString("base64url");
      const signature = Buffer.from(`sig-${seed}`).toString("base64url");
      return `${header}.${payload}.${signature}`;
    }

    const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

    // A random run of base64url characters, 0 to `maxLength` of them. This
    // can end in a plain letter or digit as easily as in a hyphen or an
    // underscore, so it exercises a glue word the delimiter-only mechanism
    // could never find.
    function randomGlueWord(maxLength: number): string {
      const length = Math.floor(Math.random() * (maxLength + 1));
      let word = "";
      for (let index = 0; index < length; index += 1) {
        word += BASE64URL_ALPHABET[Math.floor(Math.random() * BASE64URL_ALPHABET.length)]!;
      }
      return word;
    }

    const NAMED_GLUE_SHAPES: Array<{ id: string; name: string; glue: (bearer: string) => string }> = [
      { id: "dotted-hyphen", name: "a dotted prefix and a hyphen glued together", glue: (bearer) => `paperclip.local.run-${bearer}` },
      { id: "dotted-underscore", name: "a dotted prefix and an underscore glued together", glue: (bearer) => `svc.host.tok_${bearer}` },
      { id: "short-dotted-hyphen", name: "a short dotted prefix and a hyphen glued together", glue: (bearer) => `a.b.c-${bearer}` },
      { id: "no-delimiter", name: "an ordinary word glued with no delimiter at all", glue: (bearer) => `run${bearer}` },
      { id: "hyphen-and-trailing-word", name: "a dotted prefix, a hyphen glue, and a trailing word", glue: (bearer) => `run-${bearer}-old` },
    ];

    it.each(NAMED_GLUE_SHAPES)(
      "masks a bearer glued by $name, on the write path",
      async ({ id, glue }) => {
        const { companyId, runId } = await seedRun();
        const registry = createRunSecretRedactionRegistry(db);
        const bearer = anchoredBearer(`named-write-${id}`);
        await registry.register(companyId, runId, bearer, farFutureRedactionExpiry());

        const result = await redactAuthoredRunBearer(db, companyId, glue(bearer));

        expect(result).not.toContain(bearer);
      },
    );

    it("masks a registered bearer glued by a random prefix and a random suffix, on the write path (property test, 200 generated cases)", async () => {
      const { companyId, runId } = await seedRun();
      const registry = createRunSecretRedactionRegistry(db);
      const trials = Array.from({ length: 200 }, (_, trial) => ({
        bearer: anchoredBearer(`write-property-${trial}`),
        prefix: randomGlueWord(8),
        suffix: randomGlueWord(8),
      }));

      await Promise.all(trials.map((trial) =>
        registry.register(companyId, runId, trial.bearer, farFutureRedactionExpiry())));
      const results = await Promise.all(trials.map((trial) =>
        redactAuthoredRunBearer(db, companyId, `${trial.prefix}${trial.bearer}${trial.suffix}`)));

      results.forEach((result, index) => expect(result).not.toContain(trials[index]!.bearer));
    });

    it("masks a registered bearer glued by a random prefix and a random suffix, on the read path while its material is live (property test, 200 generated cases)", async () => {
      // Each trial gets its own run, so each read below resolves only its
      // own registered value instead of every other trial's value too.
      const { companyId, agentId } = await seedRun();
      const registry = createRunSecretRedactionRegistry(db);
      const trials = await Promise.all(Array.from({ length: 200 }, async (_, trial) => {
        const runId = randomUUID();
        await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", contextSnapshot: {} });
        return {
          runId,
          bearer: anchoredBearer(`read-live-property-${trial}`),
          prefix: randomGlueWord(8),
          suffix: randomGlueWord(8),
        };
      }));

      await Promise.all(trials.map((trial) =>
        registry.register(companyId, trial.runId, trial.bearer, farFutureRedactionExpiry())));
      const results = await Promise.all(trials.map((trial) =>
        registry.redactForRun(companyId, trial.runId, `${trial.prefix}${trial.bearer}${trial.suffix}`)));

      results.forEach((result, index) => expect(result).not.toContain(trials[index]!.bearer));
    });

    it("masks a registered bearer glued by a random prefix, on the read path after the expiry sweep clears its material (property test, 200 generated cases)", async () => {
      // The read path has no decrypted plain text left once the sweep clears
      // a row's material, so this exercises the fingerprint candidate scan
      // alone. It generates only a random prefix. A random SUFFIX glued
      // after the signature segment extends that segment with no dot to
      // mark where the real token ends, so the extended candidate's
      // fingerprint never equals the registered token's fingerprint.
      // Closing that side needs the registered value's own length, which
      // the registry does not store today. That is a known, stated
      // residual; this test does not claim to cover it.
      const { companyId, agentId } = await seedRun();
      const registry = createRunSecretRedactionRegistry(db);
      const trials = await Promise.all(Array.from({ length: 200 }, async (_, trial) => {
        const runId = randomUUID();
        await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", contextSnapshot: {} });
        return { runId, bearer: anchoredBearer(`read-swept-property-${trial}`), prefix: randomGlueWord(8) };
      }));

      await Promise.all(trials.map((trial) => registry.register(companyId, trial.runId, trial.bearer, new Date(0))));
      await createRunSecretRedactionReaper(db).sweep();
      const results = await Promise.all(trials.map((trial) =>
        registry.redactForRun(companyId, trial.runId, `${trial.prefix}${trial.bearer}`)));

      results.forEach((result, index) => expect(result).not.toContain(trials[index]!.bearer));
    });
  });
});
