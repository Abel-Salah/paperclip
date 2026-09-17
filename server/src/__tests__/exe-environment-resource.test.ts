import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, environments } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { bindEnvironmentResource, readEnvironmentResourceBinding } from "../services/environment-resource-binding.js";
import { assertExeEnvironmentEnabled } from "../services/exe-environment-gate.js";
import { environmentService } from "../services/environments.js";
import { instanceSettingsService } from "../services/instance-settings.js";
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("durable exe.dev environment resource", () => {
  let db: ReturnType<typeof createDb>;
  let stop: () => Promise<void>;
  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("exe-resource");
    db = createDb(started.connectionString); stop = started.stop;
  });
  afterAll(async () => { await stop?.(); });
  async function fixture() {
    const id = randomUUID(); const companyId = randomUUID();
    await db.insert(environments).values({ id, name: id, driver: "sandbox", config: { provider: "exe-dev" } });
    const binding = { provider: "exe-dev", companyId, resourceId: "test-vm", identity: randomUUID() };
    return { id, companyId, binding };
  }
  it("defaults off, gates API/runtime admission, and allows explicit opt-in", async () => {
    const environment = { driver: "sandbox", config: { provider: "exe-dev" } };
    await expect(assertExeEnvironmentEnabled(db, environment)).rejects.toThrow("Enable experimental");
    await expect(assertExeEnvironmentEnabled(db, { driver: "sandbox", config: { provider: "daytona" } })).resolves.toBeUndefined();
    await instanceSettingsService(db).updateExperimental({ enableExeEnvironments: true });
    await expect(assertExeEnvironmentEnabled(db, environment)).resolves.toBeUndefined();
    await instanceSettingsService(db).updateExperimental({ enableExeEnvironments: false });
  });
  it("atomically converges concurrent acquisitions on the same durable identity", async () => {
    const { id, companyId, binding } = await fixture();
    await Promise.all(Array.from({ length: 8 }, () => bindEnvironmentResource(db, id, companyId, binding)));
    expect(await readEnvironmentResourceBinding(db, id, companyId)).toEqual(binding);
  });
  it("allows only one identity when competing first acquisitions disagree", async () => {
    const { id, companyId, binding } = await fixture();
    const results = await Promise.allSettled([
      bindEnvironmentResource(db, id, companyId, binding),
      bindEnvironmentResource(db, id, companyId, { ...binding, identity: randomUUID() }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });
  it("survives metadata replacement and has no dependence on run lease rows", async () => {
    const { id, companyId, binding } = await fixture();
    await bindEnvironmentResource(db, id, companyId, binding);
    await environmentService(db).update(id, { metadata: { note: "operator edit" } });
    expect(await readEnvironmentResourceBinding(db, id, companyId)).toEqual(binding);
    await environmentService(db).update(id, { metadata: null });
    expect(await readEnvironmentResourceBinding(db, id, companyId)).toEqual(binding);
  });
  it("denies a different company and a replacement VM", async () => {
    const { id, companyId, binding } = await fixture();
    await bindEnvironmentResource(db, id, companyId, binding);
    await expect(readEnvironmentResourceBinding(db, id, randomUUID())).rejects.toThrow("another company");
    await expect(bindEnvironmentResource(db, id, companyId, { ...binding, identity: randomUUID() })).rejects.toThrow("identity changed");
    expect(await readEnvironmentResourceBinding(db, id, companyId)).toEqual(binding);
  });
});
