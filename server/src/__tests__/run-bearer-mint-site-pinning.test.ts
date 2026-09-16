import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// `createLocalAgentJwt` (server/src/agent-auth-jwt.ts) mints a run bearer but
// does not register it with the redaction registry. A direct call site mints
// a bearer that no later read path can mask. `mintAndRegisterRunBearer`
// (server/src/services/run-bearer.ts) is the only call path that mints and
// registers together, so every production caller must go through it.
//
// This scan reads the repository source and reports each production line
// that calls `createLocalAgentJwt` outside the wrapper file. It follows the
// source-scanning style of `cli-invocation-safety.test.ts`.

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, "..");

const DEFINITION_FILE = "agent-auth-jwt.ts";
const WRAPPER_FILE = path.join("services", "run-bearer.ts");

const CALL_PATTERN = /\bcreateLocalAgentJwt\s*\(/;
const DECLARATION_PATTERN = /\bfunction\s+createLocalAgentJwt\s*\(/;

function isTestFile(relPath: string): boolean {
  return relPath.includes("__tests__/") || /\.(test|spec)\.[tj]sx?$/.test(relPath);
}

function listSourceFiles(rootDir: string): string[] {
  const found: string[] = [];

  function walk(absDir: string, relDir: string): void {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        walk(path.join(absDir, entry.name), relPath);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      found.push(relPath);
    }
  }

  walk(rootDir, "");
  return found;
}

// Return one `path:line` entry for each production line that calls
// `createLocalAgentJwt` outside the wrapper file. The function definition
// line and every unit test file are exempt.
function findMintSiteOffenders(rootDir: string): string[] {
  const offenders: string[] = [];
  for (const relPath of listSourceFiles(rootDir)) {
    const normalized = relPath.split(path.sep).join("/");
    if (normalized === DEFINITION_FILE) continue;
    if (normalized === WRAPPER_FILE.split(path.sep).join("/")) continue;
    if (isTestFile(normalized)) continue;
    const text = readFileSync(path.join(rootDir, relPath), "utf8");
    text.split("\n").forEach((line, index) => {
      if (CALL_PATTERN.test(line) && !DECLARATION_PATTERN.test(line)) {
        offenders.push(`${normalized}:${index + 1}`);
      }
    });
  }
  return offenders;
}

describe("createLocalAgentJwt mint-site pinning", () => {
  it("has no caller in production source outside the register-first wrapper", () => {
    const offenders = findMintSiteOffenders(srcRoot);
    expect(
      offenders,
      "createLocalAgentJwt must be called only from server/src/services/run-bearer.ts. " +
        `A direct caller mints a bearer that the redaction registry never learns about:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("fails on a tree that still holds a direct call outside the wrapper", () => {
    // Prove the scanner can fail. Build a fixture tree with a production file
    // that calls createLocalAgentJwt directly, mirroring the old direct-call
    // shape this task replaced at all three mint sites.
    const root = mkdtempSync(path.join(os.tmpdir(), "run-bearer-pinning-"));
    try {
      const offenderDir = path.join(root, "services", "native-runtime");
      mkdirSync(offenderDir, { recursive: true });
      writeFileSync(
        path.join(offenderDir, "paperclip-runner-tool-authority.ts"),
        [
          'import { createLocalAgentJwt } from "../../agent-auth-jwt.js";',
          "",
          "const token = createLocalAgentJwt(agentId, companyId, adapterType, runId, responsibleUserId);",
          "",
        ].join("\n"),
      );
      const offenders = findMintSiteOffenders(root);
      expect(offenders).toEqual(["services/native-runtime/paperclip-runner-tool-authority.ts:3"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exempts the wrapper file and unit tests from the scan", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "run-bearer-pinning-allow-"));
    try {
      mkdirSync(path.join(root, "services"), { recursive: true });
      writeFileSync(
        path.join(root, "services", "run-bearer.ts"),
        'const token = createLocalAgentJwt(agentId, companyId, adapterType, runId, responsibleUserId, keyScope);\n',
      );
      mkdirSync(path.join(root, "__tests__"), { recursive: true });
      writeFileSync(
        path.join(root, "__tests__", "run-bearer.test.ts"),
        'const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");\n',
      );
      writeFileSync(
        path.join(root, "agent-auth-jwt.ts"),
        "export function createLocalAgentJwt(agentId, companyId, adapterType, runId) {}\n",
      );
      expect(findMintSiteOffenders(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
