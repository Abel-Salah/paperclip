import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { paperclipApiHelperSource } from "./paperclip-api-launcher.js";

const exec = promisify(execFile);
const SENTINEL_BEARER = "sentinel-bearer-must-never-leave-the-configured-origin";

type RecordedRequest = { method: string; url: string; headers: IncomingMessage["headers"]; body: string; rawBody: Buffer };

function countOccurrences(buffer: Buffer, marker: Buffer): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const index = buffer.indexOf(marker, from);
    if (index === -1) break;
    count++;
    from = index + marker.length;
  }
  return count;
}

async function startRecordingServer(
  respond: (req: IncomingMessage) => { status: number; body: string },
): Promise<{ server: Server; port: number; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks);
      requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: rawBody.toString("utf8"), rawBody });
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
      configured.requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: "", rawBody: Buffer.alloc(0) });
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

  describe("keeps the configured base URL's path prefix", () => {
    async function startEchoingServer(): Promise<{ server: Server; port: number }> {
      const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ receivedPath: req.url }));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as { port: number };
      return { server, port };
    }

    it.each<[string, string]>([
      ["http://host", "/api/agents/me"],
      ["http://host/", "/api/agents/me"],
      ["http://host/api", "/api/agents/me"],
      ["http://host/paperclip", "/paperclip/api/agents/me"],
      ["http://host/paperclip/api", "/paperclip/api/agents/me"],
      ["http://host/paperclip/", "/paperclip/api/agents/me"],
    ])("sends PAPERCLIP_API_URL=%s to %s for GET /api/agents/me", async (configuredForm, expectedPath) => {
      const echo = await startEchoingServer();
      try {
        const apiUrl = configuredForm.replace("http://host", `http://127.0.0.1:${echo.port}`);
        const result = await exec(bin, ["GET", "/api/agents/me"], { env: runEnv({ PAPERCLIP_API_URL: apiUrl }) });
        expect(JSON.parse(result.stdout)).toEqual({ receivedPath: expectedPath });
      } finally {
        await new Promise<void>((resolve) => echo.server.close(() => resolve()));
      }
    });

    const PREFIX_ESCAPE_NAMED_CASES: Array<{ name: string; relativePath: string }> = [
      { name: "a single ../ segment", relativePath: "/api/../agents/me" },
      { name: "a doubled ../../ segment", relativePath: "/api/agents/../../me" },
      { name: "a percent-encoded ../ segment", relativePath: "/api/%2e%2e/agents/me" },
      { name: "an uppercase percent-encoded ../ segment", relativePath: "/api/%2E%2E/agents/me" },
      { name: "a leading // form", relativePath: "//api/agents/me" },
      { name: "a backslash form", relativePath: "/api\\agents\\me" },
    ];

    it.each(PREFIX_ESCAPE_NAMED_CASES)(
      "rejects $name that would escape the configured prefix",
      async ({ relativePath }) => {
        const echo = await startEchoingServer();
        try {
          const apiUrl = `http://127.0.0.1:${echo.port}/paperclip`;
          await expect(
            exec(bin, ["GET", relativePath], { env: runEnv({ PAPERCLIP_API_URL: apiUrl }) }),
          ).rejects.toMatchObject({ code: 2 });
        } finally {
          await new Promise<void>((resolve) => echo.server.close(() => resolve()));
        }
      },
    );

    const PATH_SEGMENT_POOL = ["agents", "me", "issues", "PAP-1", "comments", "status", "42"];

    function randomSegment(): string {
      return PATH_SEGMENT_POOL[Math.floor(Math.random() * PATH_SEGMENT_POOL.length)]!;
    }

    // Generates one of several input shapes at random: an ordinary path under
    // /api/, a dot-segment escape, a percent-encoded dot-segment escape, a
    // percent-encoded separator, a leading // form, a backslash form, or a
    // path carrying a scheme. 200 calls cover many combinations of these
    // shapes, instead of one example per shape.
    function randomPathCase(): string {
      const depth = 1 + Math.floor(Math.random() * 4);
      const segments = Array.from({ length: depth }, randomSegment);
      const ordinary = "/api/" + segments.join("/");
      switch (Math.floor(Math.random() * 7)) {
        case 0: return ordinary;
        case 1: return "/api/" + "../".repeat(1 + Math.floor(Math.random() * 3)) + segments.join("/");
        case 2: return "/api/" + "%2e%2e/".repeat(1 + Math.floor(Math.random() * 3)) + segments.join("/");
        case 3: return "/api%2f" + segments.join("%2f");
        case 4: return "//" + segments.join("/");
        case 5: return "/api\\" + segments.join("\\");
        case 6: return "http://attacker.example" + ordinary;
        default: return ordinary;
      }
    }

    it(
      "either rejects, or keeps the configured prefix, for 200 generated path inputs (property test)",
      async () => {
        const echo = await startEchoingServer();
        try {
          const apiUrl = `http://127.0.0.1:${echo.port}/paperclip`;
          const expectedPrefix = "/paperclip/api/";
          const trials = Array.from({ length: 200 }, randomPathCase);
          const outcomes = await Promise.all(
            trials.map((relativePath) =>
              exec(bin, ["GET", relativePath], { env: runEnv({ PAPERCLIP_API_URL: apiUrl }) })
                .then((result) => ({ accepted: true as const, body: result.stdout }))
                .catch((error: { code?: number }) => ({ accepted: false as const, code: error.code })),
            ),
          );
          outcomes.forEach((outcome, index) => {
            const input = trials[index];
            if (!outcome.accepted) {
              expect(outcome.code, `input ${JSON.stringify(input)} rejected with an unexpected exit code`).toBe(2);
              return;
            }
            const receivedPath = (JSON.parse(outcome.body) as { receivedPath: string }).receivedPath;
            expect(
              receivedPath.startsWith(expectedPrefix),
              `input ${JSON.stringify(input)} produced ${receivedPath}, outside ${expectedPrefix}`,
            ).toBe(true);
          });
        } finally {
          await new Promise<void>((resolve) => echo.server.close(() => resolve()));
        }
      },
      30_000,
    );
  });

  function execWithStdin(args: string[], env: NodeJS.ProcessEnv, input: Buffer) {
    const result = exec(bin, args, { env, maxBuffer: 64 * 1024 * 1024 });
    result.child.stdin!.end(input);
    return result;
  }

  describe("a request body from a file or from standard input", () => {
    it("sends a body piped through standard input, byte for byte", async () => {
      const payload = randomBytes(4096);
      const result = await execWithStdin(["POST", "/api/issues/PAP-1/comments", "-d", "@-"], runEnv(), payload);
      expect(JSON.parse(result.stdout)).toEqual({ ok: true });
      expect(configured.requests[0]!.rawBody.equals(payload)).toBe(true);
    });

    it("sends a body read from a named file, byte for byte", async () => {
      const payload = randomBytes(4096);
      const filePath = path.join(root, "body.bin");
      await writeFile(filePath, payload);
      const result = await exec(bin, ["POST", "/api/issues/PAP-1/comments", "-d", `@${filePath}`], { env: runEnv() });
      expect(JSON.parse(result.stdout)).toEqual({ ok: true });
      expect(configured.requests[0]!.rawBody.equals(payload)).toBe(true);
    });

    it("keeps sending a literal -d argument as a body", async () => {
      await exec(bin, ["POST", "/api/issues/PAP-1/comments", "-d", '{"body":"literal"}'], { env: runEnv() });
      expect(configured.requests[0]!.body).toBe('{"body":"literal"}');
    });

    it("fails without making a request when the named body file does not exist", async () => {
      const filePath = path.join(root, "missing.bin");
      await expect(exec(bin, ["POST", "/api/issues/PAP-1/comments", "-d", `@${filePath}`], { env: runEnv() })).rejects.toMatchObject({
        code: 2,
      });
      expect(configured.requests).toHaveLength(0);
    });
  });

  describe("a multipart file upload", () => {
    function multipartBoundary(request: RecordedRequest): string {
      const match = /boundary=(.+)$/.exec(request.headers["content-type"] ?? "");
      expect(match).toBeTruthy();
      return match![1]!;
    }

    it("uploads one file part, with the file content unchanged, and Content-Type set once", async () => {
      const payload = randomBytes(2048);
      const filePath = path.join(root, "output.webm");
      await writeFile(filePath, payload);
      const result = await exec(
        bin,
        ["POST", "/api/issues/PAP-1/attachments", "-F", `file=@${filePath};type=video/webm`],
        { env: runEnv() },
      );
      expect(JSON.parse(result.stdout)).toEqual({ ok: true });
      const request = configured.requests[0]!;
      expect(request.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
      const boundary = multipartBoundary(request);
      expect(countOccurrences(request.rawBody, Buffer.from(`--${boundary}`, "utf8"))).toBe(2);
      expect(countOccurrences(request.rawBody, Buffer.from("Content-Disposition: form-data", "utf8"))).toBe(1);
      const headEnd = request.rawBody.indexOf("\r\n\r\n") + 4;
      const tailStart = request.rawBody.lastIndexOf(`\r\n--${boundary}--`);
      expect(request.rawBody.subarray(headEnd, tailStart).equals(payload)).toBe(true);
    });

    it("rejects a caller-supplied Content-Type header in multipart mode", async () => {
      const filePath = path.join(root, "output.webm");
      await writeFile(filePath, "content");
      await expect(
        exec(
          bin,
          ["POST", "/api/issues/PAP-1/attachments", "-F", `file=@${filePath};type=video/webm`, "-H", "Content-Type: text/plain"],
          { env: runEnv() },
        ),
      ).rejects.toMatchObject({ code: 2 });
      expect(configured.requests).toHaveLength(0);
    });

    it("rejects more than one -F file part", async () => {
      const filePath = path.join(root, "output.webm");
      await writeFile(filePath, "content");
      await expect(
        exec(
          bin,
          [
            "POST",
            "/api/issues/PAP-1/attachments",
            "-F",
            `file=@${filePath};type=video/webm`,
            "-F",
            `second=@${filePath};type=video/webm`,
          ],
          { env: runEnv() },
        ),
      ).rejects.toMatchObject({ code: 2 });
      expect(configured.requests).toHaveLength(0);
    });

    it("fails without making a request when the multipart file does not exist", async () => {
      const filePath = path.join(root, "missing.webm");
      await expect(
        exec(bin, ["POST", "/api/issues/PAP-1/attachments", "-F", `file=@${filePath};type=video/webm`], { env: runEnv() }),
      ).rejects.toMatchObject({ code: 2 });
      expect(configured.requests).toHaveLength(0);
    });

    // This character set holds a carriage return, a line feed, a double
    // quote, and a backslash. Each of these can inject a header, end a body
    // early, or collide with the boundary. The set also holds the
    // letters, digits, and hyphen the boundary itself uses.
    const MULTIPART_TEST_CHARSET = 'PaperclipFormBoundary0123456789abcdefABCDEF-_\r\n"\\';
    const HAS_FORBIDDEN_MULTIPART_CHAR = /[\r\n"\\]/;
    const FIXED_UPLOAD_CONTENT = Buffer.from("sample file content, unchanged");

    function randomMultipartTestString(minLength: number, maxLength: number): string {
      const length = minLength + Math.floor(Math.random() * (maxLength - minLength + 1));
      let value = "";
      for (let i = 0; i < length; i++) {
        value += MULTIPART_TEST_CHARSET[Math.floor(Math.random() * MULTIPART_TEST_CHARSET.length)];
      }
      return value;
    }

    async function runMultipartCase(fieldName: string, fileNameSeed: string, contentType: string) {
      const filePath = path.join(root, `upload-${fileNameSeed}`);
      await writeFile(filePath, FIXED_UPLOAD_CONTENT);
      try {
        const outcome = await exec(
          bin,
          ["POST", "/api/issues/PAP-1/attachments", "-F", `${fieldName}=@${filePath};type=${contentType}`],
          { env: runEnv() },
        );
        return { accepted: true as const, result: outcome };
      } catch (error) {
        return { accepted: false as const, error: error as { code?: number } };
      }
    }

    // This is the one invariant the program's boundary handling must keep.
    // Either the program rejects the caller's field name, file name, or
    // content type. Or it sends a request with the boundary in exactly the
    // two places the multipart format needs, and with the original file
    // bytes and nothing else. This same check also catches an injected
    // header line: an injected carriage return or line feed moves the "end
    // of headers" marker, so the extracted content no longer matches the
    // original bytes.
    function assertRequestHasOneSafePart(request: RecordedRequest) {
      const boundary = multipartBoundary(request);
      expect(countOccurrences(request.rawBody, Buffer.from(`--${boundary}`, "utf8"))).toBe(2);
      const headersEnd = request.rawBody.indexOf("\r\n\r\n");
      const tailStart = request.rawBody.lastIndexOf(`\r\n--${boundary}--`);
      expect(headersEnd).toBeGreaterThan(-1);
      expect(tailStart).toBeGreaterThan(headersEnd);
      const content = request.rawBody.subarray(headersEnd + 4, tailStart);
      expect(content.equals(FIXED_UPLOAD_CONTENT)).toBe(true);
    }

    const NAMED_MULTIPART_CASES: Array<{ name: string; fieldName: string; fileName: string; contentType: string }> = [
      { name: "a carriage return in the field name", fieldName: "file\rname", fileName: "plain", contentType: "text/plain" },
      { name: "a line feed in the file name", fieldName: "file", fileName: "plain\nname", contentType: "text/plain" },
      { name: "a double quote in the content type", fieldName: "file", fileName: "plain", contentType: 'text/plain"x' },
      { name: "a backslash in the field name", fieldName: "fi\\le", fileName: "plain", contentType: "text/plain" },
      { name: "a header-ending double CRLF in the field name", fieldName: "file\r\n\r\ninjected", fileName: "plain", contentType: "text/plain" },
      { name: "the boundary's own characters in the content type (accepted, still one safe part)", fieldName: "file", fileName: "plain", contentType: "PaperclipFormBoundaryabc123" },
    ];

    it.each(NAMED_MULTIPART_CASES)("$name", async ({ fieldName, fileName, contentType }) => {
      configured.requests.length = 0;
      const outcome = await runMultipartCase(fieldName, fileName, contentType);
      const dangerous = HAS_FORBIDDEN_MULTIPART_CHAR.test(fieldName) || HAS_FORBIDDEN_MULTIPART_CHAR.test(fileName) || HAS_FORBIDDEN_MULTIPART_CHAR.test(contentType);
      if (dangerous) {
        expect(outcome.accepted).toBe(false);
        expect(!outcome.accepted && outcome.error.code).toBe(2);
        expect(configured.requests).toHaveLength(0);
        return;
      }
      expect(outcome.accepted).toBe(true);
      assertRequestHasOneSafePart(configured.requests[0]!);
    });

    it(
      "either rejects a dangerous field/file/content-type, or sends exactly one safe part, for 200 generated inputs (property test)",
      async () => {
        for (let trial = 0; trial < 200; trial++) {
          configured.requests.length = 0;
          const fieldName = randomMultipartTestString(1, 12);
          const fileNameSeed = `${trial}-${randomMultipartTestString(1, 12)}`;
          const contentType = randomMultipartTestString(1, 24);
          const outcome = await runMultipartCase(fieldName, fileNameSeed, contentType);
          const dangerous =
            HAS_FORBIDDEN_MULTIPART_CHAR.test(fieldName)
            || HAS_FORBIDDEN_MULTIPART_CHAR.test(fileNameSeed)
            || HAS_FORBIDDEN_MULTIPART_CHAR.test(contentType);
          if (dangerous) {
            expect(outcome.accepted, `trial ${trial} accepted a dangerous field/file/content-type`).toBe(false);
            expect(!outcome.accepted && outcome.error.code, `trial ${trial} rejected with an unexpected exit code`).toBe(2);
            expect(configured.requests, `trial ${trial} sent a request despite rejecting`).toHaveLength(0);
            continue;
          }
          expect(outcome.accepted, `trial ${trial} rejected a safe field/file/content-type`).toBe(true);
          assertRequestHasOneSafePart(configured.requests[0]!);
        }
      },
      60_000,
    );
  });

  describe("the response status code and output file", () => {
    it("writes the numeric status code and nothing else for a 200 response", async () => {
      const result = await exec(bin, ["GET", "/api/agents/me", "--status"], { env: runEnv() });
      expect(result.stdout).toBe("200");
    });

    it("writes the numeric status code and nothing else for a 404 response", async () => {
      await new Promise<void>((resolve) => configured.server.close(() => resolve()));
      configured.server = createServer((req, res) => {
        res.writeHead(404, { "content-type": "application/json" });
        res.end('{"error":"not found"}');
      });
      await new Promise<void>((resolve) => configured.server.listen(configured.port, "127.0.0.1", resolve));
      const result = await exec(bin, ["GET", "/api/agents/me", "--status"], { env: runEnv() });
      expect(result.stdout).toBe("404");
    });

    it("does not fail the process on a non-2xx status when --status is given", async () => {
      await new Promise<void>((resolve) => configured.server.close(() => resolve()));
      configured.server = createServer((req, res) => {
        res.writeHead(404, { "content-type": "application/json" });
        res.end('{"error":"not found"}');
      });
      await new Promise<void>((resolve) => configured.server.listen(configured.port, "127.0.0.1", resolve));
      await expect(exec(bin, ["GET", "/api/agents/me", "--status"], { env: runEnv() })).resolves.toMatchObject({ stdout: "404" });
    });

    it("writes the response body to -o instead of standard output", async () => {
      const outputPath = path.join(root, "response.json");
      const result = await exec(bin, ["GET", "/api/agents/me", "-o", outputPath], { env: runEnv() });
      expect(result.stdout).toBe("");
      const written = await readFile(outputPath, "utf8");
      expect(JSON.parse(written)).toEqual({ ok: true });
    });

    it("combines -o and --status the way a status-then-body curl call would", async () => {
      const outputPath = path.join(root, "response.json");
      const result = await exec(bin, ["GET", "/api/agents/me", "-o", outputPath, "--status"], { env: runEnv() });
      expect(result.stdout).toBe("200");
      const written = await readFile(outputPath, "utf8");
      expect(JSON.parse(written)).toEqual({ ok: true });
    });
  });
});
