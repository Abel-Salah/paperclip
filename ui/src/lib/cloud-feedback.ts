import { useState } from "react";

export const CLOUD_FEEDBACK_OPEN_EVENT = "paperclip:open-cloud-feedback";
export const CLOUD_FEEDBACK_CLOSE_EVENT = "paperclip:close-cloud-feedback";
export const PLAIN_SCRIPT_URL = "https://chat.cdn-plain.com/index.js";
const TIMEOUT_MS = 15_000;
export type FeedbackTheme = "light" | "dark";
export type FeedbackConfig = { appId: string };
interface PlainSdk {
  init(config: Record<string, unknown>): void | Promise<void>;
  update(config: Record<string, unknown>): void | Promise<void>;
}

export function readCloudFeedbackConfig(isCloud: boolean): FeedbackConfig | null {
  if (!isCloud || typeof document === "undefined") return null;
  try {
    const value = JSON.parse(document.getElementById("paperclip-cloud-feedback-config")?.textContent ?? "null");
    return value && typeof value.appId === "string" && /^liveChatApp_[a-zA-Z0-9]+$/.test(value.appId)
      ? { appId: value.appId } : null;
  } catch { return null; }
}

export function useCloudFeedbackConfig(isCloud: boolean) {
  // Config is deployment-owned and immutable for this document. Health can arrive later.
  const [config] = useState(() => readCloudFeedbackConfig(true));
  return isCloud ? config : null;
}

export function openCloudFeedback(trigger: HTMLElement) {
  window.dispatchEvent(new CustomEvent(CLOUD_FEEDBACK_OPEN_EVENT, { detail: trigger }));
}

/** One anonymous Plain session per document, mounted in a Paperclip-owned element.
 * Never send account IDs, URLs, logs, or task context to the vendor.
 */
export class CloudFeedbackController {
  private host: HTMLDivElement | null = null;
  private sdk: PlainSdk | null = null;
  private initialization: Promise<void> | null = null;
  private identity: string | null = null;
  private appId: string | null = null;
  private invalid = false;
  private updates: Promise<void> = Promise.resolve();

  constructor(private readonly timeoutMs = TIMEOUT_MS) {}

  private async bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([promise, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Chat took too long to load.")), this.timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }

  private loadSdk(): Promise<PlainSdk> {
    // Refuse an existing owner, including a legacy snippet. Do not reinitialize it.
    if ((window as unknown as { Plain?: unknown }).Plain || document.querySelector(`script[src="${PLAIN_SCRIPT_URL}"]`)) {
      return Promise.reject(new Error("Chat already has an owner. Reload after checking configuration."));
    }
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = PLAIN_SCRIPT_URL;
      script.async = true;
      script.onload = () => {
        script.onload = script.onerror = null;
        const sdk = (window as unknown as { Plain?: PlainSdk }).Plain;
        if (!this.invalid && sdk && typeof sdk.init === "function" && typeof sdk.update === "function") resolve(sdk);
        else reject(new Error("Chat is unavailable. Reload to try again."));
      };
      script.onerror = () => {
        script.onload = script.onerror = null;
        reject(new Error("Chat could not load."));
      };
      document.head.appendChild(script);
    });
  }

  invalidate() {
    this.invalid = true;
    this.host?.remove();
  }

  async mount(container: HTMLElement, config: FeedbackConfig, identity: string, theme: FeedbackTheme, brandColor: string) {
    if (this.invalid) throw new Error("Reload to start a new chat session.");
    if (this.identity !== null && (this.identity !== identity || this.appId !== config.appId)) {
      this.invalidate();
      throw new Error("Reload to start a new chat session.");
    }
    if (!this.host) {
      this.host = document.createElement("div");
      this.identity = identity;
      this.appId = config.appId;
    }
    container.appendChild(this.host);
    if (!this.initialization) {
      const host = this.host;
      this.initialization = this.bounded((async () => {
        this.sdk = await this.loadSdk();
        if (this.invalid) throw new Error("Chat session ended.");
        await this.sdk.init({
          appId: config.appId,
          embedAt: host,
          hideLauncher: true,
          entryPoint: { type: "chat", singleChatMode: true },
          theme,
          style: { brandColor },
        });
      })()).catch((error: unknown) => { this.invalidate(); throw error; });
    }
    await this.initialization;
    if (this.invalid) throw new Error("Chat session ended. Reload to try again.");
    await this.updateTheme(theme, brandColor);
  }

  async updateTheme(theme: FeedbackTheme, brandColor: string) {
    if (!this.initialization) return;
    const update = this.updates.then(async () => {
      await this.initialization;
      if (this.invalid || !this.sdk) throw new Error("Chat session ended.");
      // appId and embedAt are initialization-only. Keep the same mounted host.
      await this.bounded(Promise.resolve(this.sdk.update({ theme, style: { brandColor } })));
    });
    this.updates = update.catch(() => {});
    try { await update; } catch (error) { this.invalidate(); throw error; }
  }
}

export const cloudFeedbackController = new CloudFeedbackController();
