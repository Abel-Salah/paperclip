import { asc, eq, gt, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companySkillVersions } from "@paperclipai/db";
import {
  readPaperclipSkillSyncPreference,
  writePaperclipSkillSyncPreference,
} from "@paperclipai/adapter-utils/server-utils";
import { resolveRetiredBundledSkillReleaseIds } from "./company-skills.js";

export type RetiredSkillReleasePinMigrationResult = {
  scannedAgents: number;
  migratedAgents: number;
  clearedPins: number;
};

/** Agents per pass. Bounds one run's work so a large agent table stays cheap to retry. */
const AGENT_BATCH_SIZE = 500;

function asPlainRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Repoint every agent desired-skill entry pinned to a retired bundled skill
 * release onto the safe unpinned (current) content. Reads and updates agents
 * in ordered batches of `AGENT_BATCH_SIZE`, keyed on the agent id (an indexed
 * column), instead of one unbounded scan or an offset that re-reads earlier
 * rows on every pass. It is safe to call again: an agent that carries no
 * retired pin is left untouched, so a second run changes nothing.
 */
export async function migrateRetiredSkillReleasePins(db: Db): Promise<RetiredSkillReleasePinMigrationResult> {
  const result: RetiredSkillReleasePinMigrationResult = { scannedAgents: 0, migratedAgents: 0, clearedPins: 0 };

  const retiredReleaseIds = await resolveRetiredBundledSkillReleaseIds();
  if (retiredReleaseIds.size === 0) return result;

  const retiredVersionRows = await db
    .select({ id: companySkillVersions.id })
    .from(companySkillVersions)
    .where(inArray(companySkillVersions.releaseId, Array.from(retiredReleaseIds)));
  const retiredVersionIds = new Set(retiredVersionRows.map((row) => row.id));
  if (retiredVersionIds.size === 0) return result;

  let cursor: string | null = null;
  for (;;) {
    const rows = await db
      .select({ id: agents.id, adapterConfig: agents.adapterConfig })
      .from(agents)
      .where(cursor ? gt(agents.id, cursor) : undefined)
      .orderBy(asc(agents.id))
      .limit(AGENT_BATCH_SIZE);
    if (rows.length === 0) break;
    result.scannedAgents += rows.length;

    for (const row of rows) {
      const config = asPlainRecord(row.adapterConfig);
      const preference = readPaperclipSkillSyncPreference(config);
      const pinnedRetiredCount = preference.desiredSkillEntries.filter(
        (entry) => entry.versionId && retiredVersionIds.has(entry.versionId),
      ).length;
      if (pinnedRetiredCount === 0) continue;

      const nextEntries = preference.desiredSkillEntries.map((entry) =>
        entry.versionId && retiredVersionIds.has(entry.versionId)
          ? { key: entry.key, versionId: null }
          : entry,
      );
      const nextConfig = writePaperclipSkillSyncPreference(config, nextEntries);
      await db
        .update(agents)
        .set({ adapterConfig: nextConfig, updatedAt: new Date() })
        .where(eq(agents.id, row.id));

      result.migratedAgents += 1;
      result.clearedPins += pinnedRetiredCount;
    }

    cursor = rows[rows.length - 1]!.id;
    if (rows.length < AGENT_BATCH_SIZE) break;
  }

  return result;
}
