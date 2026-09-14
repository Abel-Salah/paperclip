import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";
import { useCloudInstance } from "../hooks/useCloudInstance";
import { useTheme } from "../context/ThemeContext";
import {
  CLOUD_FEEDBACK_OPEN_EVENT, CLOUD_FEEDBACK_CLOSE_EVENT,
  cloudFeedbackController, useCloudFeedbackConfig, type FeedbackConfig,
} from "../lib/cloud-feedback";
import { PaperclipFeedbackLockup } from "./PaperclipFeedbackLockup";
import { Button } from "./ui/button";

export function CloudFeedbackPanel() {
  const config = useCloudFeedbackConfig(Boolean(useCloudInstance()));
  return config ? <ConfiguredCloudFeedbackPanel config={config} /> : null;
}

function ConfiguredCloudFeedbackPanel({ config }: { config: FeedbackConfig }) {
  const { theme } = useTheme();
  const session = useQuery({ queryKey: queryKeys.auth.session, queryFn: () => authApi.getSession(), enabled: Boolean(config), retry: false });
  const identity = session.isSuccess ? (session.data?.user.id ?? "local-board") : null;
  const [open, setOpen] = useState(false);
  const [started, setStarted] = useState(false);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const container = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const boundIdentity = useRef<string | null>(null);

  useEffect(() => {
    if (!config) return;
    const onOpen = (event: Event) => {
      const target = (event as CustomEvent<unknown>).detail;
      trigger.current = target instanceof HTMLElement ? target : null;
      setStarted(true);
      setOpen(true);
    };
    const onSignOut = () => { cloudFeedbackController.invalidate(); setOpen(false); setStatus("error"); };
    window.addEventListener(CLOUD_FEEDBACK_OPEN_EVENT, onOpen);
    window.addEventListener(CLOUD_FEEDBACK_CLOSE_EVENT, onSignOut);
    return () => {
      window.removeEventListener(CLOUD_FEEDBACK_OPEN_EVENT, onOpen);
      window.removeEventListener(CLOUD_FEEDBACK_CLOSE_EVENT, onSignOut);
    };
  }, [config]);

  useEffect(() => {
    if (!started || !config || !container.current) return;
    if (session.isError || (boundIdentity.current !== null && identity !== boundIdentity.current)) {
      cloudFeedbackController.invalidate();
      setStatus("error");
      return;
    }
    if (!identity) return;
    boundIdentity.current = identity;
    let active = true;
    const brand = getComputedStyle(panel.current!).getPropertyValue("--cloud-feedback-brand").trim();
    void cloudFeedbackController.mount(container.current, config, identity, theme, brand).then(
      () => { if (active) setStatus("ready"); },
      () => { if (active) setStatus("error"); },
    );
    return () => { active = false; };
  }, [started, config, identity, session.isError, theme]);

  useEffect(() => {
    if (!open) return;
    closeButton.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing) {
        event.preventDefault();
        setOpen(false);
        if (trigger.current?.isConnected) trigger.current.focus();
      }
    };
    document.addEventListener("keydown", escape, true);
    return () => document.removeEventListener("keydown", escape, true);
  }, [open]);

  if (!config || !started) return null;
  return (
    <section ref={panel} data-theme={theme} id="cloud-feedback-panel" role="dialog" aria-modal="false" aria-labelledby="cloud-feedback-title"
      hidden={!open} className="cloud-feedback-panel fixed z-50 overflow-auto rounded-xl border border-border shadow-lg">
      <header className="flex flex-col gap-4 border-b border-border p-5">
        <div className="flex items-center justify-between gap-3">
          <PaperclipFeedbackLockup />
          <Button ref={closeButton} variant="ghost" size="icon-sm" aria-label="Close feedback" onClick={() => {
            setOpen(false);
            if (trigger.current?.isConnected) trigger.current.focus();
          }}><X className="size-4" /></Button>
        </div>
        <div className="flex flex-col gap-2">
          <h2 id="cloud-feedback-title" className="text-lg font-semibold">Help shape Paperclip</h2>
          <p className="text-sm text-muted-foreground">What’s working? What’s getting in your way?</p>
        </div>
      </header>
      {status === "loading" && <p role="status" className="p-4 text-sm text-muted-foreground">Loading chat…</p>}
      {status === "error" && <p role="alert" className="p-4 text-sm">Chat is unavailable. Email support below, or reload the page to try again.</p>}
      <div ref={container} hidden={status === "error"} className="cloud-feedback-chat" />
      <footer className="flex gap-4 border-t border-border px-5 py-3 text-xs text-muted-foreground">
        <a className="underline underline-offset-4" href="https://docs.paperclip.ing/hosted-beta/" target="_blank" rel="noopener noreferrer">Beta guide & FAQ</a>
        <a className="underline underline-offset-4" href="mailto:support@paperclip.ing">Email support</a>
      </footer>
    </section>
  );
}
