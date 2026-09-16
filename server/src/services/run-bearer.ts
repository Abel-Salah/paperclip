import type { Db } from "@paperclipai/db";
import type { AgentApiKeyScope } from "@paperclipai/shared";
import { createLocalAgentJwt, localAgentJwtTtlSeconds } from "../agent-auth-jwt.js";
import { createRunSecretRedactionRegistry } from "./run-secret-redaction.js";

/**
 * Mint the run bearer and register it before any caller can use it.
 *
 * This is the only allowed call path to `createLocalAgentJwt`. A caller must
 * not call `createLocalAgentJwt` directly, because a minted bearer that is
 * not registered cannot be masked on any later read of run or issue text.
 *
 * When the mint returns a token, registration must complete before this
 * function returns one. A registration failure throws and returns no token,
 * so a caller must not launch a process or inject a bearer on that failure.
 *
 * When the mint returns `null` (no JWT secret configured), this function
 * returns `null` and registers nothing. That is not a failure.
 */
export async function mintAndRegisterRunBearer(
  db: Db,
  agentId: string,
  companyId: string,
  adapterType: string,
  runId: string,
  responsibleUserId?: string | null,
  keyScope?: AgentApiKeyScope,
): Promise<string | null> {
  const token = createLocalAgentJwt(agentId, companyId, adapterType, runId, responsibleUserId, keyScope);
  if (!token) return null;
  // The same TTL config `createLocalAgentJwt` used to set this token's `exp`
  // claim, read again here so the registry records the token's real expiry
  // instead of a separately guessed value.
  const ttlSeconds = localAgentJwtTtlSeconds() ?? 0;
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  await createRunSecretRedactionRegistry(db).register(companyId, runId, token, expiresAt);
  return token;
}
