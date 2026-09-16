import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, companySkillVersions, companySkills, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { migrateRetiredSkillReleasePins } from "./retired-skill-release-pin-migration.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("migrateRetiredSkillReleasePins", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("retired-skill-release-pins-");
    db = createDb(database.connectionString);
  }, 30000);

  afterAll(async () => {
    await database?.cleanup();
  });

  async function seedCompanyAndSkill() {
    const companyId = randomUUID();
    const skillId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Migration test",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(companySkills).values({
      id: skillId,
      companyId,
      key: "paperclipai/paperclip/paperclip",
      slug: "paperclip",
      name: "Paperclip",
      markdown: "# Paperclip",
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
    });
    return { companyId, skillId };
  }

  async function insertVersion(companyId: string, skillId: string, revisionNumber: number, releaseId: string | null) {
    const [row] = await db
      .insert(companySkillVersions)
      .values({
        companyId,
        companySkillId: skillId,
        revisionNumber,
        releaseId,
        fileInventory: [],
      })
      .returning();
    if (!row) throw new Error("Expected inserted skill version");
    return row;
  }

  async function insertAgentPinnedTo(companyId: string, key: string, versionId: string | null) {
    const [row] = await db
      .insert(agents)
      .values({
        companyId,
        name: "Pinned agent",
        adapterConfig: {
          paperclipSkillSync: {
            desiredSkills: [{ key, versionId }],
          },
        },
      })
      .returning();
    if (!row) throw new Error("Expected inserted agent");
    return row;
  }

  async function desiredSkills(db: ReturnType<typeof createDb>, agentId: string) {
    const row = await db.select({ adapterConfig: agents.adapterConfig }).from(agents)
      .where(eq(agents.id, agentId)).then((rows) => rows[0]);
    return (row?.adapterConfig as { paperclipSkillSync?: { desiredSkills?: unknown[] } })
      .paperclipSkillSync?.desiredSkills;
  }

  it("migrates an existing agent pinned to the retired v0 release onto the unpinned default", async () => {
    const { companyId, skillId } = await seedCompanyAndSkill();
    const v0 = await insertVersion(companyId, skillId, 1, "v0");
    const agentOnV0 = await insertAgentPinnedTo(companyId, "paperclipai/paperclip/paperclip", v0.id);

    const result = await migrateRetiredSkillReleasePins(db);
    expect(result.migratedAgents).toBe(1);
    expect(result.clearedPins).toBe(1);
    // Once no entry carries a versionId, the preference writer collapses back
    // to the plain string form — the same shape an unpinned desired skill has
    // always used.
    await expect(desiredSkills(db, agentOnV0.id)).resolves.toEqual(["paperclipai/paperclip/paperclip"]);
  });

  it("migrates an existing agent pinned to the retired v7-roster release onto the unpinned default", async () => {
    const { companyId, skillId } = await seedCompanyAndSkill();
    const v7 = await insertVersion(companyId, skillId, 1, "v7-roster");
    const agentOnV7 = await insertAgentPinnedTo(companyId, "paperclipai/paperclip/paperclip", v7.id);

    const result = await migrateRetiredSkillReleasePins(db);
    expect(result.migratedAgents).toBe(1);
    expect(result.clearedPins).toBe(1);
    await expect(desiredSkills(db, agentOnV7.id)).resolves.toEqual(["paperclipai/paperclip/paperclip"]);
  });

  it("leaves a pin on a release that is not retired, and an agent with no pin, untouched; a second run changes nothing", async () => {
    const { companyId, skillId } = await seedCompanyAndSkill();
    const v0 = await insertVersion(companyId, skillId, 1, "v0");
    const current = await insertVersion(companyId, skillId, 2, null);

    const agentOnV0 = await insertAgentPinnedTo(companyId, "paperclipai/paperclip/paperclip", v0.id);
    const agentOnCurrent = await insertAgentPinnedTo(companyId, "paperclipai/paperclip/paperclip", current.id);
    const agentUnpinned = await insertAgentPinnedTo(companyId, "paperclipai/paperclip/paperclip", null);

    const firstRun = await migrateRetiredSkillReleasePins(db);
    expect(firstRun.migratedAgents).toBe(1);
    expect(firstRun.clearedPins).toBe(1);

    await expect(desiredSkills(db, agentOnV0.id)).resolves.toEqual(["paperclipai/paperclip/paperclip"]);
    // A pin on a release that is not retired, and an agent with no pin at
    // all, must be left exactly as they were.
    await expect(desiredSkills(db, agentOnCurrent.id)).resolves.toEqual([
      { key: "paperclipai/paperclip/paperclip", versionId: current.id },
    ]);
    // Already unpinned, so migration skips it and leaves its stored shape untouched.
    await expect(desiredSkills(db, agentUnpinned.id)).resolves.toEqual([
      { key: "paperclipai/paperclip/paperclip", versionId: null },
    ]);

    const secondRun = await migrateRetiredSkillReleasePins(db);
    expect(secondRun.migratedAgents).toBe(0);
    expect(secondRun.clearedPins).toBe(0);
  });
});
