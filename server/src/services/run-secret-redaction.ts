import { createHash } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, runSecretRedactions } from "@paperclipai/db";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import { getSecretProvider } from "../secrets/provider-registry.js";
import type { StoredSecretVersionMaterial } from "../secrets/types.js";

// Lets a caller pass either the pooled `Db` or an open transaction. A
// write-time caller must read on its own transaction connection, not
// re-enter the outer pool while that transaction still holds locks.
type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

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

// A maximal chain of base64url segments joined by dots, at least three
// segments long. A registered run bearer that appears in text is the plain
// text of that bearer, so a later pass hashes each candidate this scanner
// offers and looks up the hash. It never decrypts stored material to find a
// match.
const JWT_CHAIN_RE = /[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2,}/g;

// A caller may supply a batch of many runs, or one run with a large payload.
// This bounds each fingerprint lookup to a fixed number of query round trips
// instead of one round trip per candidate.
const FINGERPRINT_QUERY_BATCH_SIZE = 1000;

// Every window of three consecutive segments inside one maximal chain. A
// dotted word right before a bearer (for example "paperclip.local.<bearer>")
// joins into one longer chain, so the bearer's own three segments are not
// always the chain's first three. Offering every window, not only the
// first, closes that gap. No window is dropped here: a later pass bounds
// its database lookups, but this candidate set itself stays unbounded.
function jwtWindowsInChain(chain: string): string[] {
  const segments = chain.split(".");
  const windows: string[] = [];
  for (let start = 0; start + 3 <= segments.length; start += 1) {
    windows.push(segments.slice(start, start + 3).join("."));
  }
  return windows;
}

// The one candidate scanner. Both the read mask below and the write-time
// redactor in `redactAuthoredRunBearer` call this, so a shape fix here
// applies to both paths at once.
function collectJwtCandidateStrings(text: string, into: Set<string>): void {
  for (const chain of text.matchAll(JWT_CHAIN_RE)) {
    for (const candidate of jwtWindowsInChain(chain[0])) into.add(candidate);
  }
}

function collectJwtCandidates(value: unknown, into: Set<string>): void {
  if (typeof value === "string") {
    collectJwtCandidateStrings(value, into);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectJwtCandidates(item, into);
    return;
  }
  if (value instanceof Date) return;
  const record = asRecord(value);
  if (!record) return;
  for (const [key, entry] of Object.entries(record)) {
    if (key === REGISTRY_KEY) continue;
    collectJwtCandidates(entry, into);
  }
}

// Replaces only the matched windows inside each maximal chain, scanning
// left to right and consuming three segments at a time on a match. Every
// other character of the chain, including a dotted prefix such as
// "paperclip.local.", stays exactly as it was.
function replaceJwtWindowsInText(text: string, matched: Set<string>): string {
  if (matched.size === 0) return text;
  return text.replace(JWT_CHAIN_RE, (chain) => {
    const segments = chain.split(".");
    const tokens: string[] = [];
    let index = 0;
    while (index < segments.length) {
      const window = index + 3 <= segments.length
        ? segments.slice(index, index + 3).join(".")
        : null;
      if (window && matched.has(window)) {
        tokens.push(REDACTED_EVENT_VALUE);
        index += 3;
      } else {
        tokens.push(segments[index]!);
        index += 1;
      }
    }
    return tokens.join(".");
  });
}

// Runs after the value pass has already rebuilt the object graph and
// stripped the legacy registry key, so this pass does not need to repeat
// that filter. It only replaces a candidate substring whose fingerprint
// matched; every other character stays exactly as the value pass left it.
function replaceMatchedCandidates<T>(input: T, matched: Set<string>): T {
  if (matched.size === 0) return input;
  if (typeof input === "string") {
    return replaceJwtWindowsInText(input, matched) as T;
  }
  if (Array.isArray(input)) return input.map((item) => replaceMatchedCandidates(item, matched)) as T;
  if (input instanceof Date) return input;
  const record = asRecord(input);
  if (!record) return input;
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, replaceMatchedCandidates(value, matched)]),
  ) as T;
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

// Looks up a company-scoped set of digests against the registry, in query
// batches bounded to `FINGERPRINT_QUERY_BATCH_SIZE`. The lookup filters on
// `company_id` only, so a registered value matches wherever it appears in
// that company's text. It never filters on `run_id`, and it never matches a
// row of another company. Shared by the read mask inside
// `createRunSecretRedactionRegistry` and by the write-time
// `redactAuthoredRunBearer` below, so both read the registry the same way.
async function matchedFingerprintsFor(
  dbOrTx: DbOrTx,
  companyId: string,
  digests: string[],
): Promise<Set<string>> {
  const matched = new Set<string>();
  for (let start = 0; start < digests.length; start += FINGERPRINT_QUERY_BATCH_SIZE) {
    const batch = digests.slice(start, start + FINGERPRINT_QUERY_BATCH_SIZE);
    const rows = await dbOrTx.select({ fingerprintSha256: runSecretRedactions.fingerprintSha256 })
      .from(runSecretRedactions)
      .where(and(
        eq(runSecretRedactions.companyId, companyId),
        inArray(runSecretRedactions.fingerprintSha256, batch),
      ));
    for (const row of rows) matched.add(row.fingerprintSha256);
  }
  return matched;
}

// A base64url segment that decodes to a JSON object carrying an `alg`
// member. A real JWT header always has this shape. An ordinary dotted
// identifier, a file name, or a placeholder never decodes this way, so this
// is the test that keeps the write-time fallback below narrow.
function decodesAsJwtHeader(segment: string): boolean {
  let decoded: string;
  try {
    decoded = Buffer.from(segment, "base64url").toString("utf8");
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return false;
  }
  const header = asRecord(parsed);
  return header !== null && typeof header.alg === "string";
}

function isJwtShapedCandidate(candidate: string): boolean {
  const header = candidate.split(".")[0];
  return header !== undefined && decodesAsJwtHeader(header);
}

// Write-time redaction for an agent-authored comment body or issue
// description, applied before the row is written. Two arms, in this order:
//
//   1. An exact registered-bearer match, using the same fingerprint lookup
//      the read mask uses. A digest match cannot be a false positive, so
//      this arm is safe to run on any text.
//   2. A narrow JWT-shaped fallback for a candidate the registry does not
//      yet hold. It fires only when the candidate's first segment decodes
//      as a JSON header carrying an `alg` member, so it does not fire on an
//      unexpanded variable, a placeholder, or the redaction marker — none
//      of those decode this way.
//
// Reads on `dbOrTx`, the caller's own connection. A failed lookup
// propagates instead of being swallowed, so the caller's write aborts
// rather than persist unredacted text.
export async function redactAuthoredRunBearer(
  dbOrTx: DbOrTx,
  companyId: string,
  text: string,
): Promise<string> {
  const candidates = new Set<string>();
  collectJwtCandidateStrings(text, candidates);
  if (candidates.size === 0) return text;
  const digestByCandidate = new Map(
    [...candidates].map((candidate) => [candidate, createHash("sha256").update(candidate).digest("hex")] as const),
  );
  const digests = [...new Set(digestByCandidate.values())];
  const matchedDigests = await matchedFingerprintsFor(dbOrTx, companyId, digests);
  const matched = new Set<string>();
  for (const [candidate, digest] of digestByCandidate) {
    if (matchedDigests.has(digest) || isJwtShapedCandidate(candidate)) matched.add(candidate);
  }
  if (matched.size === 0) return text;
  return replaceJwtWindowsInText(text, matched);
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

  // Delegates to the module-level `matchedFingerprintsFor`, bound to this
  // registry's own `db`, so this read mask and `redactAuthoredRunBearer`
  // share one query implementation.
  const matchedFingerprints = (companyId: string, digests: string[]) =>
    matchedFingerprintsFor(db, companyId, digests);

  // Walks a value for JWT-shaped candidates, hashes each distinct candidate
  // once, and masks only the candidates whose hash the registry holds. A
  // fingerprint-only row (its material cleared by the expiry sweep) still
  // masks here, because this pass needs no decrypted plain text: the
  // candidate found in the value already is the plain text.
  async function maskByFingerprint<T>(companyId: string, value: T): Promise<T> {
    const candidates = new Set<string>();
    collectJwtCandidates(value, candidates);
    if (candidates.size === 0) return value;
    const digestByCandidate = new Map(
      [...candidates].map((candidate) => [candidate, createHash("sha256").update(candidate).digest("hex")] as const),
    );
    const digests = [...new Set(digestByCandidate.values())];
    const matched = await matchedFingerprints(companyId, digests);
    if (matched.size === 0) return value;
    const matchedCandidates = new Set(
      [...digestByCandidate.entries()].filter(([, digest]) => matched.has(digest)).map(([candidate]) => candidate),
    );
    return replaceMatchedCandidates(value, matchedCandidates);
  }

  // The batch form of `maskByFingerprint`: it collects the candidates of the
  // whole batch of values first, then issues one bounded set of queries for
  // the whole batch, instead of one query per value.
  async function maskManyByFingerprint<T>(companyId: string, values: T[]): Promise<T[]> {
    const candidates = new Set<string>();
    for (const value of values) collectJwtCandidates(value, candidates);
    if (candidates.size === 0) return values;
    const digestByCandidate = new Map(
      [...candidates].map((candidate) => [candidate, createHash("sha256").update(candidate).digest("hex")] as const),
    );
    const digests = [...new Set(digestByCandidate.values())];
    const matched = await matchedFingerprints(companyId, digests);
    if (matched.size === 0) return values;
    const matchedCandidates = new Set(
      [...digestByCandidate.entries()].filter(([, digest]) => matched.has(digest)).map(([candidate]) => candidate),
    );
    return values.map((value) => replaceMatchedCandidates(value, matchedCandidates));
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
      const valuePass = runs.map((run) => redactRegisteredSecretValues(run, valuesByRun.get(run.id) ?? []));
      return maskManyByFingerprint(companyId, valuePass);
    },
    redactForRun: async <T>(companyId: string, runId: string, value: T): Promise<T> => {
      const valuePass = redactRegisteredSecretValues(value, await valuesForRun(companyId, runId));
      return maskByFingerprint(companyId, valuePass);
    },
    redactForIssue: async <T>(companyId: string, issueId: string, value: T): Promise<T> => {
      const valuePass = redactRegisteredSecretValues(value, await valuesForIssue(companyId, issueId));
      return maskByFingerprint(companyId, valuePass);
    },
  };
}
