import { describe, expect, it, afterEach } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

d("run_secret_redactions migration", () => {
  it("creates the table and its indexes, and the fingerprint lookup uses the index", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("pap6522-run-secret-redactions-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => { await sql.end(); });

    const idx = await sql`SELECT indexname FROM pg_indexes WHERE tablename = 'run_secret_redactions'`;
    const names = idx.map((r) => r.indexname as string);
    expect(names).toContain("run_secret_redactions_company_fingerprint_run_uq");
    expect(names).toContain("run_secret_redactions_company_run_idx");
    expect(names).toContain("run_secret_redactions_sweep_idx");

    await sql.unsafe("SET enable_seqscan = off");
    // Companies id 1 is never inserted; EXPLAIN plans the query without
    // executing it, so the query needs no rows to prove the planner's choice.
    const plan = await sql.unsafe(
      "EXPLAIN SELECT id FROM run_secret_redactions WHERE company_id = '00000000-0000-0000-0000-000000000001' AND fingerprint_sha256 = 'x'",
    );
    const planText = plan.map((r) => Object.values(r)[0]).join("\n");
    expect(planText).toContain("run_secret_redactions_company_fingerprint_run_uq");

    const runLookupPlan = await sql.unsafe(
      "EXPLAIN SELECT id FROM run_secret_redactions WHERE company_id = '00000000-0000-0000-0000-000000000001' AND run_id = '00000000-0000-0000-0000-000000000002'",
    );
    const runLookupText = runLookupPlan.map((r) => Object.values(r)[0]).join("\n");
    expect(runLookupText).toContain("run_secret_redactions_company_run_idx");
  }, 240_000);
});
