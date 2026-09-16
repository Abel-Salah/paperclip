import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { paperclipApiHelperSource } from "./paperclip-api-launcher.js";

const exec = promisify(execFile);
const SENTINEL_BEARER = "sentinel-bearer-must-never-leave-the-configured-origin";

type RecordedRequest = { method: string; url: string; headers: IncomingMessage["headers"]; body: string };

async function startRecordingServer(
  respond: (req: IncomingMessage) => { status: number; body: string },
): Promise<{ server: Server; port: number; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      const { status, body } = respond(req);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { server, port, requests };
}

describe("paperclip-api helper", () => {
  let root: string;
  let bin: string;
  let configured: Awaited<ReturnType<typeof startRecordingServer>>;
  let nonconfigured: Awaited<ReturnType<typeof startRecordingServer>>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "paperclip-api-helper-"));
    bin = path.join(root, "paperclip-api");
    await writeFile(bin, paperclipApiHelperSource(), { mode: 0o700 });
    configured = await startRecordingServer(() => ({ status: 200, body: '{"ok":true}' }));
    nonconfigured = await startRecordingServer(() => ({ status: 200, body: '{"ok":true}' }));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await new Promise<void>((resolve) => configured.server.close(() => resolve()));
    await new Promise<void>((resolve) => nonconfigured.server.close(() => resolve()));
  });

  function runEnv(overrides: Record<string, string> = {}) {
    return {
      ...process.env,
      PAPERCLIP_API_URL: `http://127.0.0.1:${configured.port}/api`,
      PAPERCLIP_API_KEY: SENTINEL_BEARER,
      PAPERCLIP_RUN_ID: "run-123",
      ...overrides,
    };
  }

  it("makes a GET request, setting the Authorization header exactly once", async () => {
    const result = await exec(bin, ["GET", "/api/agents/me"], { env: runEnv() });
    expect(JSON.parse(result.stdout)).toEqual({ ok: true });
    expect(configured.requests).toHaveLength(1);
    const request = configured.requests[0]!;
    expect(request.method).toBe("GET");
    expect(request.url).toBe("/api/agents/me");
    expect(request.headers.authorization).toBe(`Bearer ${SENTINEL_BEARER}`);
    expect(nonconfigured.requests).toHaveLength(0);
  });

  it("posts a scoped issue comment with Content-Type and X-Paperclip-Run-Id set for the caller", async () => {
    const result = await exec(bin, ["POST", "/api/issues/PAP-1/comments", "-d", '{"body":"status"}'], { env: runEnv() });
    expect(JSON.parse(result.stdout)).toEqual({ ok: true });
    const request = configured.requests[0]!;
    expect(request.method).toBe("POST");
    expect(request.headers["content-type"]).toBe("application/json");
    expect(request.headers["x-paperclip-run-id"]).toBe("run-123");
    expect(request.body).toBe('{"body":"status"}');
  });

  it("never puts the bearer on the command line", async () => {
    const args = ["POST", "/api/issues/PAP-1/comments", "-d", '{"body":"status"}'];
    expect(args.join(" ")).not.toContain(SENTINEL_BEARER);
    await exec(bin, args, { env: runEnv() });
    expect(configured.requests[0]!.headers.authorization).toBe(`Bearer ${SENTINEL_BEARER}`);
  });

  it.each<[string, (attackerPort: number) => string]>([
    ["an absolute URL to the nonconfigured origin", (port) => `http://127.0.0.1:${port}/api/x`],
    ["a scheme-relative //host form", (port) => `//127.0.0.1:${port}/api/x`],
    ["a backslash form", (port) => `/\\127.0.0.1:${port}/api/x`],
    ["a path outside /api/", () => "/not-api/x"],
  ])("rejects %s and never reaches the nonconfigured origin", async (_label, buildPath) => {
    const relativePath = buildPath(nonconfigured.port);
    await expect(exec(bin, ["GET", relativePath], { env: runEnv() })).rejects.toMatchObject({ code: 2 });
    expect(configured.requests).toHaveLength(0);
    expect(nonconfigured.requests).toHaveLength(0);
  });

  it.each(["Authorization", "Host", "Proxy-Authorization", "X-Forwarded-Host"])(
    "rejects a caller-supplied %s header",
    async (headerName) => {
      await expect(
        exec(bin, ["GET", "/api/agents/me", "-H", `${headerName}: attacker-value`], { env: runEnv() }),
      ).rejects.toMatchObject({ code: 2 });
      expect(configured.requests).toHaveLength(0);
    },
  );

  it("does not follow a redirect to another origin", async () => {
    await new Promise<void>((resolve) => configured.server.close(() => resolve()));
    configured.server = createServer((req, res) => {
      configured.requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: "" });
      res.writeHead(302, { location: `http://127.0.0.1:${nonconfigured.port}/api/x` });
      res.end();
    });
    await new Promise<void>((resolve) => configured.server.listen(configured.port, "127.0.0.1", resolve));
    await expect(exec(bin, ["GET", "/api/agents/me"], { env: runEnv() })).rejects.toBeTruthy();
    expect(nonconfigured.requests).toHaveLength(0);
  });

  it("fails when PAPERCLIP_API_KEY is not set, without making a request", async () => {
    const env = runEnv();
    delete (env as Record<string, string | undefined>).PAPERCLIP_API_KEY;
    await expect(exec(bin, ["GET", "/api/agents/me"], { env })).rejects.toMatchObject({ code: 2 });
    expect(configured.requests).toHaveLength(0);
  });
});
