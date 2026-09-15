import type { RunnerApi } from "./api.js";
import type { LiveFixtureValues } from "./live-fixtures.js";
import type { CredentialName, MatrixExecution } from "./types.js";

/** Provision only credentials for the UI-created company. The production wizard
 * remains the sole creator/configurer of its first agent and onboarding task. */
export async function provisionFirstTaskFixtures(input: {
  api: Pick<RunnerApi, "get" | "postSensitive">;
  execution: MatrixExecution;
  nonce: string;
  company: LiveFixtureValues["company"];
  credentials: Partial<Record<CredentialName, string>>;
}): Promise<LiveFixtureValues> {
  const { api, execution, nonce, company, credentials } = input;
  if (
    execution.suite.id !== "first-task" ||
    execution.environment.id !== "local" ||
    !["legacy-codex", "legacy-claude"].includes(execution.profile.id)
  ) {
    throw new Error(
      "First-task fixtures require a supported local onboarding profile",
    );
  }
  const credential = execution.profile.credential;
  const value = credentials[credential];
  if (!value) throw new Error(`Missing credential ${credential}`);
  const environments = await api.get<Array<LiveFixtureValues["environment"]>>(
    `/api/companies/${company.id}/environments?driver=local`,
  );
  const environment = environments.find((e) => e.driver === "local");
  if (!environment)
    throw new Error("Onboarding fixture local environment missing");
  const secret = await api.postSensitive<{ id: string }>(
    `/api/companies/${company.id}/secrets`,
    {
      name: `First task ${credential}`,
      key: credential,
      value,
    },
  );
  return {
    company,
    environment,
    secretRefs: {
      [credential]: {
        type: "secret_ref",
        secretId: secret.id,
        version: "latest",
      },
    },
    agent: { id: "", name: `Garden lead ${nonce}`, companyId: company.id },
    teardown: async () => {}, // Existing launcher removes the complete isolated instance.
  };
}
