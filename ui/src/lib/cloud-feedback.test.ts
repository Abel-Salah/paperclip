// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudFeedbackController, PLAIN_SCRIPT_URL, readCloudFeedbackConfig } from "./cloud-feedback";

const config = { appId: "liveChatApp_test" };
const sdk = () => ({ init: vi.fn().mockResolvedValue(undefined), update: vi.fn().mockResolvedValue(undefined) });
function ready(value: ReturnType<typeof sdk>) {
  Object.assign(window, { Plain: value });
  document.querySelector<HTMLScriptElement>(`script[src="${PLAIN_SCRIPT_URL}"]`)!.dispatchEvent(new Event("load"));
}
afterEach(() => { document.body.innerHTML = ""; document.head.innerHTML = ""; delete (window as unknown as { Plain?: unknown }).Plain; vi.useRealTimers(); });
describe("cloud feedback", () => {
  it("requires cloud and valid public config", () => {
    document.body.innerHTML = '<script id="paperclip-cloud-feedback-config" type="application/json">{"appId":"liveChatApp_test"}</script>';
    expect(readCloudFeedbackConfig(false)).toBeNull();
    expect(readCloudFeedbackConfig(true)).toEqual(config);
    document.getElementById("paperclip-cloud-feedback-config")!.textContent = '{"appId":"javascript:bad"}';
    expect(readCloudFeedbackConfig(true)).toBeNull();
  });
  it("initializes once, preserves its element/draft, and serializes theme changes", async () => {
    const controller = new CloudFeedbackController(); const box = document.createElement("div");
    const first = controller.mount(box, config, "user-a", "dark", "gray"); const api = sdk(); ready(api); await first;
    const host = box.firstElementChild!; host.textContent = "unsent draft";
    await controller.mount(box, config, "user-a", "light", "gray");
    expect(api.init).toHaveBeenCalledTimes(1);
    expect(box.firstElementChild).toBe(host); expect(host.textContent).toBe("unsent draft");
    expect(api.init.mock.calls[0][0]).toMatchObject({ embedAt: host, hideLauncher: true, entryPoint: { type: "chat", singleChatMode: true } });
    expect(api.init.mock.calls[0][0]).not.toHaveProperty("customerDetails");
    expect(api.update).toHaveBeenLastCalledWith({ theme: "light", style: { brandColor: "gray" } });
  });
  it("removes the surface on account changes and refuses further initialization", async () => {
    const controller = new CloudFeedbackController(); const box = document.createElement("div");
    const first = controller.mount(box, config, "a", "dark", "gray"); ready(sdk()); await first;
    await expect(controller.mount(box, config, "b", "dark", "gray")).rejects.toThrow("Reload");
    expect(box.childElementCount).toBe(0);
  });
  it("refuses a second legacy SDK owner", async () => {
    const api = sdk(); Object.assign(window, { Plain: api });
    await expect(new CloudFeedbackController().mount(document.createElement("div"), config, "a", "dark", "gray")).rejects.toThrow("owner");
    expect(api.init).not.toHaveBeenCalled();
  });
  it("bounds script loading and prevents late loads from initializing", async () => {
    vi.useFakeTimers(); const controller = new CloudFeedbackController(100); const box = document.createElement("div");
    const pending = controller.mount(box, config, "a", "dark", "gray");
    const assertion = expect(pending).rejects.toThrow("too long");
    await vi.advanceTimersByTimeAsync(101); await assertion;
    const api = sdk(); ready(api); await Promise.resolve();
    expect(api.init).not.toHaveBeenCalled(); expect(box.childElementCount).toBe(0);
  });
  it("detaches a slow initialization even if it resolves after timeout", async () => {
    vi.useFakeTimers(); const controller = new CloudFeedbackController(100); const box = document.createElement("div");
    let resolve!: () => void; const api = sdk(); api.init.mockImplementation(() => new Promise<void>(r => { resolve = r; }));
    const pending = controller.mount(box, config, "a", "dark", "gray"); const assertion = expect(pending).rejects.toThrow("too long"); ready(api);
    await vi.advanceTimersByTimeAsync(101); await assertion; resolve(); await Promise.resolve();
    expect(box.childElementCount).toBe(0);
  });
  it("removes the surface when a theme update fails", async () => {
    const controller = new CloudFeedbackController(); const box = document.createElement("div"); const api = sdk();
    const pending = controller.mount(box, config, "a", "dark", "gray"); ready(api); await pending;
    api.update.mockRejectedValueOnce(new Error("offline"));
    await expect(controller.updateTheme("light", "gray")).rejects.toThrow("offline");
    expect(box.childElementCount).toBe(0);
  });
});
