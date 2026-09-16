import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

// A company-scoped registry of secret text a run may leak into plain text (a
// run bearer token, a proposed secret value). A later read of run or issue
// text uses this registry to mask any value it finds.
//
// `fingerprintSha256` is a one-way hash of the registered value. A periodic
// sweep clears `material` at or after `expiresAt` and keeps the row and its
// fingerprint, so the row still blocks a repeat registration of the same
// value. The fingerprint never appears in an API response or a log line.
export const runSecretRedactions = pgTable(
  "run_secret_redactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    // The foreign key cascades on delete. This bounds the life of a
    // fingerprint-only row to the life of its run row, so the table needs no
    // separate retention policy.
    runId: uuid("run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    fingerprintSha256: text("fingerprint_sha256").notNull(),
    material: jsonb("material").$type<Record<string, unknown>>(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // This index gives register() its idempotency key: one run cannot
    // register the same value twice. Its first two columns also give a
    // fingerprint lookup the (company_id, fingerprint_sha256) shape it needs.
    // The run_id column lets two different runs register the identical value
    // without a conflict, so each run keeps its own row to mask its own text.
    companyFingerprintRunUq: uniqueIndex("run_secret_redactions_company_fingerprint_run_uq")
      .on(table.companyId, table.fingerprintSha256, table.runId),
    companyRunIdx: index("run_secret_redactions_company_run_idx").on(table.companyId, table.runId),
    // Supports the bounded, ordered expiry sweep: only a row that still holds
    // material and has passed its expiry is a sweep candidate.
    sweepIdx: index("run_secret_redactions_sweep_idx")
      .on(table.expiresAt)
      .where(sql`${table.material} is not null`),
  }),
);
