import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const migrationFile = "0278_special_whiplash.sql";
const migrationSql = await readFile(new URL(`./migrations/${migrationFile}`, import.meta.url), "utf8");
const migrationHash = createHash("sha256").update(migrationSql).digest("hex");
const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); });

async function seed(sql: postgres.Sql) {
  const company = randomUUID(), allocation = randomUUID(), service = randomUUID(), task = randomUUID();
  await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${company}, 'Migration fixture', 'MIG')`;
  await sql`INSERT INTO issues (id, company_id, title) VALUES (${task}, ${company}, 'Retained task')`;
  await sql`INSERT INTO runtime_service_allocations (id, company_id, provider, reuse_key, cwd, metadata, storage_usage)
    VALUES (${allocation}, ${company}, 'local', 'retained', '/fixture/workspace', '{"credentialBinding":"fixture-reference"}', '{"sourceBytes":42}')`;
  await sql`INSERT INTO runtime_services (id, company_id, allocation_id, name, purpose, issue_id, creation_key, spec, policy, process_ref)
    VALUES (${service}, ${company}, ${allocation}, 'App', 'Retained app', ${task}, 'create-once', '{"command":"node"}', '{}', '{"identity":"fixture-process"}')`;
  await sql`INSERT INTO runtime_service_shares (company_id, service_id, endpoint_name, token_hash, creation_key, expires_at)
    VALUES (${company}, ${service}, 'web', 'fixture-share-hash', 'share-once', now() + interval '1 day')`;
  await sql`INSERT INTO runtime_service_task_workspaces (company_id, allocation_id, issue_id, host_cwd, created_by_user_id)
    VALUES (${company}, ${allocation}, ${task}, '/fixture/workspace', 'fixture-user')`;
  await sql`INSERT INTO runtime_service_data_deletions (company_id, allocation_id, service_id, target, "authorization")
    VALUES (${company}, ${allocation}, ${service}, '{"receipt":"fixture-deletion"}', '{"kind":"operator"}')`;
  return { company, allocation, service, task };
}

async function retainedState(sql: postgres.Sql) {
  const tables = ["runtime_service_allocations", "runtime_services", "runtime_service_shares", "runtime_service_task_workspaces", "runtime_service_data_deletions"];
  return Promise.all(tables.map(table => sql.unsafe(`SELECT * FROM "${table}" ORDER BY id`)));
}

async function verifyReplay(sql: postgres.Sql, url: string) {
  const identity = await seed(sql);
  const before = await retainedState(sql);
  await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${migrationHash}`;
  await applyPendingMigrations(url);
  await sql.begin(async tx => { for (const statement of migrationSql.split("--> statement-breakpoint")) if (statement.trim()) await tx.unsafe(statement); });
  expect(await inspectMigrations(url)).toMatchObject({ status: "upToDate" });
  expect(await retainedState(sql)).toEqual(before);
  await expect(sql`INSERT INTO runtime_service_allocations (company_id, provider, reuse_key, cwd) VALUES (${identity.company}, 'local', 'retained', '/other')`).rejects.toMatchObject({ code: "23505" });
  await sql`DELETE FROM issues WHERE id = ${identity.task}`;
  expect(await sql`SELECT issue_id FROM runtime_service_task_workspaces WHERE allocation_id = ${identity.allocation}`).toEqual([{ issue_id: null }]);
  expect(await sql`SELECT id FROM runtime_services WHERE id = ${identity.service}`).toHaveLength(1);
}

describePostgres("runtime service migration", () => {
  it("creates the current-master schema and replays without changing retained state", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-services-migration-current-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());
    await verifyReplay(sql, database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("upgrades an applied development history without skipping intervening master migrations", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-services-migration-legacy-");
    cleanups.push(database.cleanup);
    const admin = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => admin.end());
    await admin`CREATE DATABASE runtime_services_legacy`;
    const url = new URL(database.connectionString); url.pathname = "/runtime_services_legacy";
    const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());
    const directory = await mkdtemp(join(tmpdir(), "paperclip-services-history-"));
    cleanups.push(async () => rm(directory, { recursive: true, force: true }));
    await mkdir(join(directory, "meta"));
    const journal = JSON.parse(await readFile(new URL("./migrations/meta/_journal.json", import.meta.url), "utf8"));
    const legacy = JSON.parse(await readFile(new URL("./__fixtures__/runtime-services-development-migrations.json", import.meta.url), "utf8"));
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 273);
    for (const entry of journal.entries) await writeFile(join(directory, `${entry.tag}.sql`), await readFile(new URL(`./migrations/${entry.tag}.sql`, import.meta.url), "utf8"));
    for (const item of legacy) { journal.entries.push(item.entry); await writeFile(join(directory, `${item.entry.tag}.sql`), item.sql); }
    await writeFile(join(directory, "meta/_journal.json"), JSON.stringify(journal));
    await migrate(drizzle(sql), { migrationsFolder: directory });
    expect(await inspectMigrations(url.toString())).toMatchObject({ status: "needsMigrations", pendingMigrations: expect.arrayContaining(["0274_agent_chat.sql", migrationFile]) });
    await verifyReplay(sql, url.toString());
    expect(await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'issues' AND column_name = 'conversation_state'`).toHaveLength(1);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
