import { expect, test } from "vitest";

import { renderApiAccessNote } from "./execute.js";

function baseEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    PAPERCLIP_API_URL: "http://paperclip.local/api",
    PAPERCLIP_API_KEY: "test-token",
    PAPERCLIP_GITHUB_LAUNCHER_PROGRAMS: "paperclip-api",
    ...overrides,
  };
}

test("teaches the paperclip-api helper form when the helper is staged", () => {
  const note = renderApiAccessNote(baseEnv());

  expect(note).toContain("Call the Paperclip API with run_shell_command and the paperclip-api helper program on your PATH. Do not use curl for this.");
  expect(note).toContain("The token never appears as a command-line argument.");
  expect(note).toContain('run_shell_command({ command: "paperclip-api GET /api/agents/me" })');
  expect(note).not.toContain("curl -");
  expect(note).not.toContain("Authorization: Bearer");
});

test("renders nothing when the staged program list omits paperclip-api", () => {
  const note = renderApiAccessNote(baseEnv({ PAPERCLIP_GITHUB_LAUNCHER_PROGRAMS: "git,gh" }));

  expect(note).toBe("");
});

test("renders nothing when no program is staged at all", () => {
  const note = renderApiAccessNote(baseEnv({ PAPERCLIP_GITHUB_LAUNCHER_PROGRAMS: "" }));

  expect(note).toBe("");
});

test("renders nothing when the run has no API key", () => {
  const note = renderApiAccessNote(baseEnv({ PAPERCLIP_API_KEY: "" }));

  expect(note).toBe("");
});
