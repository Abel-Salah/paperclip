import { and, asc, inArray, isNotNull, lte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { runSecretRedactions } from "@paperclipai/db";

// The restart-safe expiry sweep for the run secret redaction registry.
//
// A lazy purge on read is not enough: a row a caller never reads again would
// keep its encrypted material forever. This reaper runs on server startup and
// on the scheduler interval, following the setup-token reaper convention
// (server/src/services/setup-token-reaper.ts). One sweep pass clears a
// bounded, ordered batch of rows whose expiry has passed: it orders by
// expiry then id, and clears at most `batchSize` rows. It never deletes a
// row and never touches `fingerprintSha256`; the run's own foreign key
// cascade is what removes a row, when its run row is removed.
export interface RunSecretRedactionSweepResult {
  cleared: number;
}

const DEFAULT_SWEEP_BATCH_SIZE = 500;

export function createRunSecretRedactionReaper(
  db: Db,
  options: { batchSize?: number; now?: () => Date } = {},
) {
  const batchSize = options.batchSize ?? DEFAULT_SWEEP_BATCH_SIZE;
  const now = options.now ?? (() => new Date());

  async function sweep(): Promise<RunSecretRedactionSweepResult> {
    const candidates = await db.select({ id: runSecretRedactions.id })
      .from(runSecretRedactions)
      .where(and(isNotNull(runSecretRedactions.material), lte(runSecretRedactions.expiresAt, now())))
      .orderBy(asc(runSecretRedactions.expiresAt), asc(runSecretRedactions.id))
      .limit(batchSize);
    if (candidates.length === 0) return { cleared: 0 };
    await db.update(runSecretRedactions)
      .set({ material: null })
      .where(inArray(runSecretRedactions.id, candidates.map((row) => row.id)));
    return { cleared: candidates.length };
  }

  return { sweep };
}

export type RunSecretRedactionReaper = ReturnType<typeof createRunSecretRedactionReaper>;
