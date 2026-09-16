import { unprocessable } from "../errors.js";

/**
 * Matches a bearer Authorization header field: the word "Authorization",
 * optional spaces or tabs, a colon, optional spaces or tabs, the word
 * "Bearer", then whitespace or the end of the text. The match is
 * case-insensitive and runs after CRLF line endings are normalized to LF.
 */
const FORBIDDEN_BEARER_AUTHORIZATION_HEADER_RE = /authorization[ \t]*:[ \t]*bearer(?=[ \t\r\n]|$)/i;

/** Normalize CRLF line endings to LF before a content scan. */
export function normalizeSkillContentLineEndings(content: string): string {
  return content.replace(/\r\n/g, "\n");
}

/**
 * Test skill file content for a bearer Authorization header field. This
 * intentionally matches a quoted example or a command-line argument, not
 * only a live credential — the caller must never embed that header shape in
 * skill content, no matter the reason.
 */
export function containsForbiddenBearerAuthorizationHeader(content: string): boolean {
  return FORBIDDEN_BEARER_AUTHORIZATION_HEADER_RE.test(normalizeSkillContentLineEndings(content));
}

/**
 * Reject skill file content that carries a bearer Authorization header
 * field. Throws a 422-style error and never rewrites the caller's content.
 */
export function assertSkillContentHasNoBearerAuthorizationHeader(content: string, filePath: string): void {
  if (!containsForbiddenBearerAuthorizationHeader(content)) return;
  throw unprocessable(
    `The file "${filePath}" contains a bearer Authorization header. Pass a bearer Authorization header only through paperclip-api. Do not put it in skill content.`,
    { path: filePath },
  );
}
