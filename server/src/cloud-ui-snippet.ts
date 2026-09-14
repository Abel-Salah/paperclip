import { isCloudManagedInstance, type CloudInstanceEnv } from "./services/cloud-instance.js";

/** Trusted operator HTML only. This content is public and runs in the app origin. */
export function injectCloudUiSnippet(html: string, env: CloudInstanceEnv = process.env): string {
  if (!isCloudManagedInstance(env)) return html;
  // Embedded mode owns initialization. Never inject a legacy launcher too.
  const appId = env.PAPERCLIP_CLOUD_FEEDBACK_APP_ID?.trim();
  if (appId) {
    if (!/^liveChatApp_[a-zA-Z0-9]+$/.test(appId)) return html;
    const config = JSON.stringify({ appId });
    return html.replace(/<\/body>/i, () => `<script type="application/json" id="paperclip-cloud-feedback-config">${config}</script>\n</body>`);
  }
  const snippet = resolveCloudUiSnippet(env);
  if (!snippet) return html;
  return html.replace(/<\/body>/i, () => `${snippet}\n</body>`);
}

/**
 * A present plain variable always wins — blank included, so clearing it to
 * blank disables injection even when a base64 value is still deployed. The
 * base64 variant exists because delivery pipelines that write env vars
 * through provider APIs can sit behind web application firewalls that
 * reject values containing raw script markup; base64 carries the same
 * snippet through them unchanged.
 */
function resolveCloudUiSnippet(env: CloudInstanceEnv): string | null {
  const plain = env.PAPERCLIP_CLOUD_UI_SNIPPET;
  if (plain !== undefined) return plain.trim() ? plain : null;
  const encoded = env.PAPERCLIP_CLOUD_UI_SNIPPET_B64?.replace(/\s+/g, "");
  if (!encoded) return null;
  const decoded = decodeBase64(encoded);
  return decoded?.trim() ? decoded : null;
}

/**
 * A value that is not canonical, padded base64 of valid UTF-8 is ignored
 * rather than injected as garbage: the round trip rejects stray padding
 * bits, and the fatal decoder rejects byte sequences that are not UTF-8.
 */
function decodeBase64(encoded: string): string | null {
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
