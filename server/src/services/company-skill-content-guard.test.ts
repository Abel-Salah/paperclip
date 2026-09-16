import { describe, expect, it } from "vitest";
import {
  assertSkillContentHasNoBearerAuthorizationHeader,
  containsForbiddenBearerAuthorizationHeader,
} from "./company-skill-content-guard.js";

describe("containsForbiddenBearerAuthorizationHeader", () => {
  it("rejects the plain header form", () => {
    expect(containsForbiddenBearerAuthorizationHeader("Authorization: Bearer eyJhbGciOi.abc.def\n")).toBe(true);
  });

  it("rejects case-insensitively", () => {
    expect(containsForbiddenBearerAuthorizationHeader("authorization: bearer abc\n")).toBe(true);
    expect(containsForbiddenBearerAuthorizationHeader("AUTHORIZATION: BEARER abc\n")).toBe(true);
    expect(containsForbiddenBearerAuthorizationHeader("AuThOrIzAtIoN: BeArEr abc\n")).toBe(true);
  });

  it("rejects whitespace variants around the colon and after Bearer", () => {
    expect(containsForbiddenBearerAuthorizationHeader("Authorization : Bearer abc\n")).toBe(true);
    expect(containsForbiddenBearerAuthorizationHeader("Authorization\t:\tBearer\tabc\n")).toBe(true);
    expect(containsForbiddenBearerAuthorizationHeader("Authorization:Bearer abc\n")).toBe(true);
    expect(containsForbiddenBearerAuthorizationHeader("Authorization:   Bearer   abc\n")).toBe(true);
  });

  it("rejects a match at the very end of the content, with no trailing newline", () => {
    expect(containsForbiddenBearerAuthorizationHeader("Authorization: Bearer")).toBe(true);
  });

  it("rejects the header after normalizing CRLF to LF", () => {
    expect(containsForbiddenBearerAuthorizationHeader("Run this:\r\nAuthorization: Bearer abc\r\n")).toBe(true);
  });

  it("rejects the header embedded mid-document, quoted as an example", () => {
    const content = [
      "# A skill",
      "",
      "Call the API like this:",
      "",
      "```",
      "curl -H 'Authorization: Bearer $PAPERCLIP_API_KEY' https://example.com",
      "```",
      "",
    ].join("\n");
    expect(containsForbiddenBearerAuthorizationHeader(content)).toBe(true);
  });

  it("does not reject unrelated content", () => {
    expect(containsForbiddenBearerAuthorizationHeader("# A skill\n\nNo secrets here.\n")).toBe(false);
    expect(containsForbiddenBearerAuthorizationHeader("Authorization is required for this action.\n")).toBe(false);
    expect(containsForbiddenBearerAuthorizationHeader("Use a Bearer token from paperclip-api.\n")).toBe(false);
  });

  it("does not reject Bearer glued to more text with no whitespace boundary", () => {
    expect(containsForbiddenBearerAuthorizationHeader("Authorization: Bearertoken abc\n")).toBe(false);
  });
});

describe("assertSkillContentHasNoBearerAuthorizationHeader", () => {
  it("passes silently for safe content", () => {
    expect(() => assertSkillContentHasNoBearerAuthorizationHeader("# Fine\n", "SKILL.md")).not.toThrow();
  });

  it("throws a 422-style error naming paperclip-api, and never rewrites the content", () => {
    const content = "Authorization: Bearer abc\n";
    let caught: unknown;
    try {
      assertSkillContentHasNoBearerAuthorizationHeader(content, "references/notes.md");
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      status: 422,
      message: expect.stringMatching(/paperclip-api/i),
      details: { path: "references/notes.md" },
    });
    // The guard rejects; it must never hand back a rewritten version of the content.
    expect(content).toBe("Authorization: Bearer abc\n");
  });
});
