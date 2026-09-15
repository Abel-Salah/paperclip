import { test as base, expect } from "@playwright/test";

/** Live-service acceptance opts in through the same operator setting as the UI. */
export const test = base.extend<{ liveServicesOptIn: void }>({
  liveServicesOptIn: [async ({ request }, use) => {
    const response = await request.patch("/api/instance/settings/experimental", { data: { enableLiveServices: true } });
    expect(response.ok()).toBe(true);
    await use();
  }, { auto: true }],
});
