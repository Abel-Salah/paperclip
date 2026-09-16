import { createHash } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, runSecretRedactions } from "@paperclipai/db";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import { getSecretProvider } from "../secrets/provider-registry.js";
import type { StoredSecretVersionMaterial } from "../secrets/types.js";

const REGISTRY_KEY = "paperclipSecretRedactions";
// Project only the legacy registry: a run context can hold megabytes of
// prompt data. This projection reads only the entries a run registered
// before the move to `run_secret_redactions`, kept for a deprecation window.
const legacyRegistrySnapshot = sql`jsonb_build_object('paperclipSecretRedactions', ${heartbeatRuns.contextSnapshot} -> 'paperclipSecretRedactions')`;

type RegistryEntry = {
  fingerprintSha256: string;
  material: StoredSecretVersionMaterial;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function legacyRegistryEntries(contextSnapshot: unknown): RegistryEntry[] {
  const context = asRecord(contextSnapshot);
  const raw = context?.[REGISTRY_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value) => {
    const entry = asRecord(value);
    const material = asRecord(entry?.material);
    return typeof entry?.fingerprintSha256 === "string" && material
      ? [{ fingerprintSha256: entry.fingerprintSha256, material }]
      : [];
  });
}

function redactText(input: string, values: string[]) {
  return values.reduce(
    (result, value) => value.length > 0 ? result.split(value).join(REDACTED_EVENT_VALUE) : result,
    input,
  );
}

// A proposed or bound company secret value carries no token-style expiry
// claim the way a run bearer does, and the pre-move registry masked such a
// value for as long as its run row existed. This far horizon keeps that same
// indefinite masking, so a caller registering a non-bearer value can supply a
// real (if distant) date instead of a guessed short one.
const NON_BEARER_REGISTRATION_HORIZON_MS = 100 * 365 * 24 * 60 * 60 * 1000;

export function farFutureRedactionExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + NON_BEARER_REGISTRATION_HORIZON_MS);
}

export function redactRegisteredSecretValues<T>(input: T, values: string[]): T {
  if (typeof input === "string") return redactText(input, values) as T;
  if (Array.isArray(input)) return input.map((value) => redactRegisteredSecretValues(value, values)) as T;
  // Dates carry no redactable text; rebuilding them via Object.entries would
  // collapse them to `{}` and break every timestamp in redacted responses.
  if (input instanceof Date) return input;
  const record = asRecord(input);
  if (!record) return input;
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => key !== REGISTRY_KEY)
      .map(([key, value]) => [key, redactRegisteredSecretValues(value, values)]),
  ) as T;
}

export function createRunSecretRedactionRegistry(db: Db) {
  const provider = getSecretProvider("local_encrypted");

  // Resolves each distinct fingerprint once, using a caller-provided cache so
  // one request can share resolves across many runs. Returns plaintext values
  // sorted longest-first, so a later substring redaction replaces a longer
  // registered value before a shorter value it contains.
  async function resolveEntries(
    entries: RegistryEntry[],
    cache: Map<string, Promise<string>>,
  ): Promise<string[]> {
    const unique = new Map(entries.map((entry) => [entry.fingerprintSha256, entry]));
    const values = await Promise.all([...unique.values()].map((entry) => {
      let value = cache.get(entry.fingerprintSha256);
      if (!value) {
        value = provider.resolveVersion({ material: entry.material, externalRef: null });
        cache.set(entry.fingerprintSha256, value);
      }
      return value;
    }));
    return values.sort((left, right) => right.length - left.length);
  }

  async function legacyEntriesByRun(companyId: string, runIds: string[]): Promise<Map<string, RegistryEntry[]>> {
    if (runIds.length === 0) return new Map();
    const rows = await db.select({ id: heartbeatRuns.id, contextSnapshot: legacyRegistrySnapshot })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.id, runIds)));
    return new Map(rows.map((row) => [row.id, legacyRegistryEntries(row.contextSnapshot)]));
  }

  // A fingerprint-only row (its `material` cleared by the expiry sweep)
  // carries nothing to resolve. It is dropped here, never thrown on.
  function tableEntries(rows: Array<{ fingerprintSha256: string; material: unknown }>): RegistryEntry[] {
    return rows.flatMap((row) => {
      const material = asRecord(row.material);
      return material ? [{ fingerprintSha256: row.fingerprintSha256, material }] : [];
    });
  }

  async function valuesForRun(companyId: string, runId: string): Promise<string[]> {
    const [tableRows, legacyByRun] = await Promise.all([
      db.select({ fingerprintSha256: runSecretRedactions.fingerprintSha256, material: runSecretRedactions.material })
        .from(runSecretRedactions)
        .where(and(eq(runSecretRedactions.companyId, companyId), eq(runSecretRedactions.runId, runId))),
      legacyEntriesByRun(companyId, [runId]),
    ]);
    const entries = [...(legacyByRun.get(runId) ?? []), ...tableEntries(tableRows)];
    return resolveEntries(entries, new Map());
  }

  async function issueRunIds(companyId: string, issueId: string): Promise<string[]> {
    const rows = await db.select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, companyId),
        or(
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
          sql`${heartbeatRuns.contextSnapshot} -> 'paperclipIssue' ->> 'id' = ${issueId}`,
        ),
      ));
    return rows.map((row) => row.id);
  }

  async function valuesForIssue(companyId: string, issueId: string): Promise<string[]> {
    const runIds = await issueRunIds(companyId, issueId);
    if (runIds.length === 0) return [];
    const [tableRows, legacyByRun] = await Promise.all([
      db.select({ fingerprintSha256: runSecretRedactions.fingerprintSha256, material: runSecretRedactions.material })
        .from(runSecretRedactions)
        .where(and(eq(runSecretRedactions.companyId, companyId), inArray(runSecretRedactions.runId, runIds))),
      legacyEntriesByRun(companyId, runIds),
    ]);
    const entries = [...[...legacyByRun.values()].flat(), ...tableEntries(tableRows)];
    return resolveEntries(entries, new Map());
  }

  return {
    // `expiresAt` must be the real expiry of the value, not a guess. For a
    // run bearer, this is the token's own JWT `exp`. The later sweep clears
    // `material` at this time. A run that registers the same value twice
    // gets one row. Two different runs that register the identical value
    // each get their own row, so each run can still mask its own text.
    register: async (companyId: string, runId: string, value: string, expiresAt: Date) => {
      const fingerprintSha256 = createHash("sha256").update(value).digest("hex");
      const existing = await db.select({ id: runSecretRedactions.id })
        .from(runSecretRedactions)
        .where(and(
          eq(runSecretRedactions.companyId, companyId),
          eq(runSecretRedactions.fingerprintSha256, fingerprintSha256),
          eq(runSecretRedactions.runId, runId),
        ))
        .limit(1);
      if (existing.length > 0) return;
      const [run] = await db.select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)))
        .limit(1);
      if (!run) throw new Error("Heartbeat run redaction registration failed");
      const prepared = await provider.createSecret({ value });
      await db.insert(runSecretRedactions)
        .values({ companyId, runId, fingerprintSha256, material: prepared.material, expiresAt })
        .onConflictDoNothing({
          target: [runSecretRedactions.companyId, runSecretRedactions.fingerprintSha256, runSecretRedactions.runId],
        });
    },
    redactForRuns: async <T extends { id: string }>(companyId: string, runs: T[]): Promise<T[]> => {
      if (runs.length === 0) return [];
      const runIds = runs.map((run) => run.id);
      const [tableRows, legacyByRun] = await Promise.all([
        db.select({ runId: runSecretRedactions.runId, fingerprintSha256: runSecretRedactions.fingerprintSha256, material: runSecretRedactions.material })
          .from(runSecretRedactions)
          .where(and(eq(runSecretRedactions.companyId, companyId), inArray(runSecretRedactions.runId, runIds))),
        legacyEntriesByRun(companyId, runIds),
      ]);
      const tableByRun = new Map<string, Array<{ fingerprintSha256: string; material: unknown }>>();
      for (const row of tableRows) {
        const existingRows = tableByRun.get(row.runId) ?? [];
        existingRows.push(row);
        tableByRun.set(row.runId, existingRows);
      }
      // Resolve each encrypted value once per request, but apply only each
      // run's own registry. Do not retain plaintext secrets across requests.
      const resolved = new Map<string, Promise<string>>();
      const valuesByRun = new Map(await Promise.all(runIds.map(async (runId) => {
        const entries = [...(legacyByRun.get(runId) ?? []), ...tableEntries(tableByRun.get(runId) ?? [])];
        return [runId, await resolveEntries(entries, resolved)] as const;
      })));
      return runs.map((run) => redactRegisteredSecretValues(run, valuesByRun.get(run.id) ?? []));
    },
    redactForRun: async <T>(companyId: string, runId: string, value: T): Promise<T> =>
      redactRegisteredSecretValues(value, await valuesForRun(companyId, runId)),
    redactForIssue: async <T>(companyId: string, issueId: string, value: T): Promise<T> =>
      redactRegisteredSecretValues(value, await valuesForIssue(companyId, issueId)),
  };
}
