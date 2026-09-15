import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";

test("live services require explicit opt-in, disappear when disabled, and retain their records", async ({ page, request }, testInfo) => {
  test.setTimeout(120_000);
  await page.addLocatorHandler(page.getByRole("button", { name: "Dismiss announcement" }), async (button) => button.click());
  const cwd = testInfo.outputPath("service-workspace");
  await fs.mkdir(cwd, { recursive: true });
  const settingsPath = "/api/instance/settings/experimental";
  expect((await (await request.get(settingsPath)).json()).enableLiveServices).toBe(false);
  const company = await (await request.post("/api/companies", { data: { name: "Live services opt-in" } })).json();
  const task = await (await request.post(`/api/companies/${company.id}/issues`, { data: { title: "Experimental preview" } })).json();
  const servicesPath = `/api/companies/${company.id}/runtime-services`;
  expect((await request.get(servicesPath)).status()).toBe(403);
  expect((await request.post(servicesPath, { data: {} })).status()).toBe(403);
  const prefix = `/${company.issuePrefix}`;
  await page.goto(`${prefix}/issues/${task.identifier}`);
  await expect(page.getByRole("link", { name: "Services", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "All company services", exact: true })).toHaveCount(0);
  await page.goto(`${prefix}/runtime-services`);
  await expect(page).toHaveURL(new RegExp(`${prefix}/dashboard$`));
  await page.goto(`${prefix}/company/settings/instance/experimental`);
  const toggle = page.getByRole("switch", { name: "Toggle Experimental Live Services", exact: true });
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect.poll(async () => (await (await request.get(settingsPath)).json()).enableLiveServices).toBe(true);
  await page.goto(`${prefix}/dashboard`);
  await expect(page.getByRole("link", { name: "Services", exact: true })).toBeVisible();
  const created = await request.post(servicesPath, { data: {
    requestId: randomUUID(), name: "Preserved preview", cwd, command: "node app.cjs", issueId: task.id, start: false,
  } });
  expect(created.status()).toBe(202);
  const service = await created.json();
  await page.goto(`${prefix}/issues/${task.identifier}`);
  await expect(page.getByRole("link", { name: "Preserved preview", exact: true })).toBeVisible();
  await page.goto(`${prefix}/company/settings/instance/experimental`);
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(page.getByRole("link", { name: "Services", exact: true })).toHaveCount(0);
  await expect.poll(async () => (await request.get(servicesPath)).status()).toBe(403);
  await page.goto(`${prefix}/issues/${task.identifier}`);
  await expect(page.getByRole("link", { name: "Preserved preview", exact: true })).toHaveCount(0);
  await page.goto(`${prefix}/runtime-services/${service.id}`);
  await expect(page).toHaveURL(new RegExp(`${prefix}/dashboard$`));
  expect((await request.patch(settingsPath, { data: { enableLiveServices: true } })).ok()).toBe(true);
  expect((await (await request.get(`${servicesPath}/${service.id}`)).json()).id).toBe(service.id);
});
