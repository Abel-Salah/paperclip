/** Standalone source is staged unchanged on local, SSH, and sandbox runtimes. No secrets in files. */
export function paperclipApiHelperSource(): string {
  return String.raw`#!/usr/bin/env node
// paperclip-api: call the Paperclip API without putting the bearer token on a
// command line. The token stays in the process environment; this program
// reads it there and adds it to the request itself.
const FORBIDDEN_HEADER_NAMES = new Set([
  'authorization', 'host', 'proxy-authorization', 'proxy-connection', 'forwarded',
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-real-ip', 'via',
]);

function usageError(message) {
  process.stderr.write('paperclip-api: ' + message + '\n');
  process.exit(2);
}

function parseArgs(argv) {
  const method = argv[0];
  const relativePath = argv[1];
  if (!method || !relativePath) usageError('usage: paperclip-api <METHOD> </api/path> [-H "Name: Value"]... [-d <body>]');
  if (!/^[A-Z]+$/.test(method)) usageError('the method must be an uppercase HTTP verb');
  const headers = {};
  let body;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-H') {
      const raw = argv[++i];
      const sep = raw ? raw.indexOf(':') : -1;
      if (sep < 0) usageError('-H needs a "Name: Value" argument');
      const name = raw.slice(0, sep).trim();
      const value = raw.slice(sep + 1).trim();
      if (FORBIDDEN_HEADER_NAMES.has(name.toLowerCase())) usageError('this program sets the "' + name + '" header itself; the caller must not set it');
      headers[name] = value;
    } else if (arg === '-d') {
      body = argv[++i];
      if (body === undefined) usageError('-d needs a body argument');
    } else {
      usageError('unknown argument "' + arg + '"');
    }
  }
  return { method, relativePath, headers, body };
}

// Accept only a path relative to the configured Paperclip API. Reject an
// absolute URL, a scheme-relative "//host" form, and a backslash. A backslash
// in a path can make a URL parser pick a different host, so this program
// never carries one into a URL.
function assertSafeRelativeApiPath(relativePath) {
  if (relativePath.includes('\\')) usageError('the path must not contain a backslash');
  if (!relativePath.startsWith('/') || relativePath.startsWith('//')) usageError('the path must be a single relative path that starts with /api/');
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(relativePath)) usageError('the path must not carry a URL scheme');
  if (!relativePath.startsWith('/api/')) usageError('the path must start with /api/');
}

function readConfiguredOrigin() {
  const rawBase = process.env.PAPERCLIP_API_URL;
  if (!rawBase) usageError('PAPERCLIP_API_URL is not set');
  const normalized = rawBase.replace(/\/+$/, '').replace(/\/api$/, '');
  let origin;
  try { origin = new URL(normalized).origin; }
  catch { usageError('PAPERCLIP_API_URL is not a valid URL'); }
  return origin;
}

// Build the final request URL against the normalized configured origin, then
// verify the built URL actually resolved to that same origin. This check
// stands even if a future change to the path check above lets an unexpected
// form through.
function buildRequestUrl(origin, relativePath) {
  let url;
  try { url = new URL(relativePath, origin + '/'); }
  catch { usageError('could not build a request URL from the given path'); }
  if (url.origin !== origin) usageError('the given path did not resolve to the configured Paperclip API origin');
  if (!url.pathname.startsWith('/api/')) usageError('the given path did not resolve under /api/');
  return url;
}

async function main() {
  const { method, relativePath, headers, body } = parseArgs(process.argv.slice(2));
  assertSafeRelativeApiPath(relativePath);
  const origin = readConfiguredOrigin();
  const url = buildRequestUrl(origin, relativePath);
  const bearer = process.env.PAPERCLIP_API_KEY;
  if (!bearer) usageError('PAPERCLIP_API_KEY is not set');
  if (body !== undefined && !('Content-Type' in headers)) headers['Content-Type'] = 'application/json';
  if (process.env.PAPERCLIP_RUN_ID && !('X-Paperclip-Run-Id' in headers)) headers['X-Paperclip-Run-Id'] = process.env.PAPERCLIP_RUN_ID;
  // Set once, here. Nothing above this line can add or change this header.
  headers['Authorization'] = 'Bearer ' + bearer;
  let response;
  try {
    response = await fetch(url, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(30000) });
  } catch (error) {
    process.stderr.write('paperclip-api: the request failed: ' + (error && error.code ? error.code : 'network_error') + '\n');
    process.exitCode = 1;
    return;
  }
  const text = await response.text();
  process.stdout.write(text);
  if (!response.ok) process.exitCode = 1;
}
main().catch(() => { process.stderr.write('paperclip-api: an unexpected error stopped the request.\n'); process.exitCode = 1; });
`;
}
