/** Standalone source is staged unchanged on local, SSH, and sandbox runtimes. No secrets in files. */
export function paperclipApiHelperSource(): string {
  return String.raw`#!/usr/bin/env node
// paperclip-api: call the Paperclip API without putting the bearer token on a
// command line. The token stays in the process environment; this program
// reads it there and adds it to the request itself.
const fsPromises = require('node:fs/promises');
const pathModule = require('node:path');
const cryptoModule = require('node:crypto');

const USAGE = 'usage: paperclip-api <METHOD> </api/path> [-H "Name: Value"]... '
  + '[-d <body>|-d @-|-d @<path>] [-F \'field=@<path>;type=<mime>\'] [-o <path>] [--status]';

const FORBIDDEN_HEADER_NAMES = new Set([
  'authorization', 'host', 'proxy-authorization', 'proxy-connection', 'forwarded',
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-real-ip', 'via',
]);

function usageError(message) {
  process.stderr.write('paperclip-api: ' + message + '\n');
  process.exit(2);
}

function hasHeaderNamed(headers, name) {
  return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
}

// Parse "<fieldName>=@<filePath>;type=<mimeType>", the one multipart shape
// this program accepts. The field name and the content type must not carry
// the literal text "=@" or ";type=". Keep these two character sequences out
// of any generated test data for this parser.
function parseMultipartArg(raw) {
  const marker = raw.indexOf('=@');
  if (marker < 0) usageError('-F needs a "field=@path;type=mime" argument');
  const fieldName = raw.slice(0, marker);
  const rest = raw.slice(marker + 2);
  const typeMarker = rest.indexOf(';type=');
  if (typeMarker < 0) usageError('-F needs a ";type=<mime>" suffix');
  const filePath = rest.slice(0, typeMarker);
  const contentType = rest.slice(typeMarker + ';type='.length);
  if (!fieldName || !filePath || !contentType) usageError('-F needs a non-empty field name, file path, and content type');
  return { fieldName, filePath, contentType };
}

function parseArgs(argv) {
  const method = argv[0];
  const relativePath = argv[1];
  if (!method || !relativePath) usageError(USAGE);
  if (!/^[A-Z]+$/.test(method)) usageError('the method must be an uppercase HTTP verb');
  const headers = {};
  let bodySpec;
  let multipartSpec;
  let outputPath;
  let wantStatus = false;
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
      bodySpec = argv[++i];
      if (bodySpec === undefined) usageError('-d needs a body argument');
    } else if (arg === '-F') {
      const raw = argv[++i];
      if (raw === undefined) usageError('-F needs a "field=@path;type=mime" argument');
      if (multipartSpec) usageError('this program accepts at most one -F file part');
      multipartSpec = parseMultipartArg(raw);
    } else if (arg === '-o') {
      outputPath = argv[++i];
      if (outputPath === undefined) usageError('-o needs a file path argument');
    } else if (arg === '--status') {
      wantStatus = true;
    } else {
      usageError('unknown argument "' + arg + '"');
    }
  }
  if (bodySpec !== undefined && multipartSpec) usageError('-d and -F cannot be used together');
  return { method, relativePath, headers, bodySpec, multipartSpec, outputPath, wantStatus };
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

// Read the configured Paperclip API base: the origin plus any path prefix,
// for example "/paperclip" when the API sits behind a reverse proxy at that
// path. Every other base-URL reader in this codebase keeps this prefix; this
// program must too, or a proxied deployment gets every request 404ed.
function readConfiguredBase() {
  const rawBase = process.env.PAPERCLIP_API_URL;
  if (!rawBase) usageError('PAPERCLIP_API_URL is not set');
  const normalized = rawBase.replace(/\/+$/, '').replace(/\/api$/, '');
  let parsed;
  try { parsed = new URL(normalized); }
  catch { usageError('PAPERCLIP_API_URL is not a valid URL'); }
  const pathPrefix = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
  return { origin: parsed.origin, pathPrefix };
}

// Build the final request URL against the normalized configured base,
// including its path prefix, then verify the built URL actually resolved to
// that same origin and under that same prefix. This check stands even if a
// future change to the path check above lets an unexpected form through.
function buildRequestUrl(base, relativePath) {
  let url;
  try { url = new URL(base.pathPrefix + relativePath, base.origin + '/'); }
  catch { usageError('could not build a request URL from the given path'); }
  if (url.origin !== base.origin) usageError('the given path did not resolve to the configured Paperclip API origin');
  const expectedPrefix = base.pathPrefix + '/api/';
  if (!url.pathname.startsWith(expectedPrefix)) usageError('the given path did not resolve under the configured Paperclip API base');
  return url;
}

function readStdinBytes() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
    process.stdin.on('error', reject);
  });
}

// Resolve the -d argument to a byte body. "@-" reads standard input.
// "@<path>" reads the named file. Anything else keeps its current meaning:
// a literal body. Read the file or the stream as bytes. Do not assume it is
// text. This way a binary attachment or a large comment body survives
// unchanged.
async function resolveBodySpec(bodySpec) {
  if (bodySpec === '@-') return readStdinBytes();
  if (bodySpec.startsWith('@')) {
    const filePath = bodySpec.slice(1);
    try { return await fsPromises.readFile(filePath); }
    catch { usageError('could not read the body file "' + filePath + '"'); }
  }
  return bodySpec;
}

function countOccurrences(buffer, marker) {
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

// A caller controls the field name, the file name, and the content type of a
// multipart upload. Each value enters the assembled request as a header
// line. Reject a carriage return, a line feed, a double quote, and a
// backslash. This stops a caller from adding a header, changing a header, or
// ending the body early.
function assertSafeMultipartValue(value, label) {
  if (/[\r\n"\\]/.test(value)) usageError('a multipart ' + label + ' must not contain a carriage return, a line feed, a double quote, or a backslash');
}

// Build one multipart/form-data body holding exactly one file part. The
// boundary comes from a cryptographic random source. It never derives from
// caller input, so a caller cannot predict it. After assembly, count the
// boundary marker in the finished body. It must appear exactly twice: once
// opening the part, once closing it. A third occurrence means a
// caller-controlled value, most plausibly the file content, collided with
// the boundary. Do not send that request.
async function buildMultipartBody(spec) {
  const { fieldName, filePath, contentType } = spec;
  const fileName = pathModule.basename(filePath);
  assertSafeMultipartValue(fieldName, 'field name');
  assertSafeMultipartValue(fileName, 'file name');
  assertSafeMultipartValue(contentType, 'content type');
  let fileBytes;
  try { fileBytes = await fsPromises.readFile(filePath); }
  catch { usageError('could not read the multipart file "' + filePath + '"'); }
  const boundary = 'PaperclipFormBoundary' + cryptoModule.randomBytes(24).toString('hex');
  const head = Buffer.from(
    '--' + boundary + '\r\n'
    + 'Content-Disposition: form-data; name="' + fieldName + '"; filename="' + fileName + '"\r\n'
    + 'Content-Type: ' + contentType + '\r\n\r\n',
    'utf8',
  );
  const tail = Buffer.from('\r\n--' + boundary + '--\r\n', 'utf8');
  const assembled = Buffer.concat([head, fileBytes, tail]);
  const occurrences = countOccurrences(assembled, Buffer.from('--' + boundary, 'utf8'));
  if (occurrences !== 2) usageError('a multipart file part could not be assembled safely');
  return { body: assembled, contentType: 'multipart/form-data; boundary=' + boundary };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const { method, relativePath, headers, outputPath, wantStatus } = parsed;
  assertSafeRelativeApiPath(relativePath);
  const base = readConfiguredBase();
  const url = buildRequestUrl(base, relativePath);
  const bearer = process.env.PAPERCLIP_API_KEY;
  if (!bearer) usageError('PAPERCLIP_API_KEY is not set');

  let body;
  if (parsed.multipartSpec) {
    // The program owns the multipart Content-Type header, the same way it
    // owns Authorization. This header carries the boundary. A caller value
    // here can smuggle in a different boundary.
    if (hasHeaderNamed(headers, 'content-type')) usageError('this program sets the multipart Content-Type header itself; the caller must not set it');
    const multipart = await buildMultipartBody(parsed.multipartSpec);
    body = multipart.body;
    headers['Content-Type'] = multipart.contentType;
  } else if (parsed.bodySpec !== undefined) {
    body = await resolveBodySpec(parsed.bodySpec);
    if (!hasHeaderNamed(headers, 'content-type')) headers['Content-Type'] = 'application/json';
  }
  if (process.env.PAPERCLIP_RUN_ID && !hasHeaderNamed(headers, 'x-paperclip-run-id')) headers['X-Paperclip-Run-Id'] = process.env.PAPERCLIP_RUN_ID;
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
  const responseBytes = Buffer.from(await response.arrayBuffer());
  if (outputPath) {
    await fsPromises.writeFile(outputPath, responseBytes);
  } else if (!wantStatus) {
    process.stdout.write(responseBytes);
  }
  if (wantStatus) {
    // The caller reads the numeric status and decides what to do next, the
    // same way it already reads a response body written to -o. Do not fail
    // the process here on a non-2xx status. That decision belongs to the
    // caller, not to this program.
    process.stdout.write(String(response.status));
  } else if (!response.ok) {
    process.exitCode = 1;
  }
}
main().catch(() => { process.stderr.write('paperclip-api: an unexpected error stopped the request.\n'); process.exitCode = 1; });
`;
}
