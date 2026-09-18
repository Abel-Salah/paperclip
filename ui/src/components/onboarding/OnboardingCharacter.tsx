import { useEffect, useRef, useState } from "react";
import { resolveAgentAppearance, type AgentAppearance } from "@paperclipai/shared";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "../AgentAvatar";
import type { createCharacter, Definition } from "@/vendor/cliplab-runtime/cliplab";
import { colorOnboardingDefinition, resolveOnboardingSequences, sequenceDuration, type OnboardingSequences } from "./onboarding-character";

type Player = ReturnType<typeof createCharacter>;
type Phase = "asleep" | "awake";

export interface OnboardingCharacterProps {
  appearance: AgentAppearance;
  /** Review is the first step where an agent exists; that is where it wakes. */
  awake: boolean;
  className?: string;
}

/**
 * The onboarding hero: gray and dozing while the agent is being specified,
 * then — once on Review — it plays the studio's sleepy → wink → idle
 * transition while its palette fades in over the gray, and settles into the
 * idle loop.
 *
 * Played by the vendored ClipLab 0.2.0 runtime rather than `AgentCharacter`:
 * the transition is a custom studio expression that needs this renderer's
 * face morphing, and the arc needs a one-shot that holds its last pose. The
 * runtime has no completion callback, so the hand-off to the idle loop is
 * timed from the sequence's authored duration — presentation only; nothing in
 * the wizard's state waits on it.
 *
 * Colouring in: the runtime's `setDefinition` restarts playback, so the body
 * cannot be recoloured mid-sequence. Instead a second canvas in the agent's
 * palette plays the same transition in lock-step above the gray one and fades
 * in; the gray canvas is destroyed once it is covered.
 *
 * Mounting straight onto Review (a reload, or a return to the wizard) shows
 * the awake hero without replaying the wake. Reduced motion skips the
 * sequence entirely: the runtime holds the first pose under that setting, so
 * the hero switches straight to its coloured idle.
 */
export function OnboardingCharacter({ appearance, awake, className }: OnboardingCharacterProps) {
  const identity = resolveAgentAppearance(appearance);
  const base = useRef<HTMLSpanElement>(null), overlay = useRef<HTMLSpanElement>(null);
  const players = useRef<{ base: Player | null; overlay: Player | null }>({ base: null, overlay: null });
  const library = useRef<{ create: typeof createCharacter; definition: Definition; sequences: OnboardingSequences } | null>(null);
  // What the live canvas currently shows, so a prop change is a transition
  // from something rather than a re-mount. Starts where the props say.
  const phase = useRef<Phase>(awake ? "awake" : "asleep");
  const timers = useRef<number[]>([]);
  const [ready, setReady] = useState(false), [failed, setFailed] = useState(false), [colored, setColored] = useState(awake);
  const [wakeSeconds, setWakeSeconds] = useState(0);

  const clearTimers = () => { for (const id of timers.current) window.clearTimeout(id); timers.current = []; };
  const destroy = (key: "base" | "overlay") => { players.current[key]?.destroy(); players.current[key] = null; };
  const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  /** A fresh base canvas at rest in the given phase; no transition. */
  function mount(next: Phase) {
    const lib = library.current;
    if (!lib || !base.current) return;
    clearTimers(); destroy("overlay"); destroy("base");
    const definition = colorOnboardingDefinition(lib.definition, identity, next === "asleep");
    players.current.base = lib.create(base.current, definition, { animation: next === "asleep" ? lib.sequences.asleep : lib.sequences.awake, background: null });
    phase.current = next; setColored(next === "awake");
  }

  /** The arc's payoff: both canvases play the transition together while the palette fades in. */
  function wake() {
    const lib = library.current, basePlayer = players.current.base;
    if (!lib || !basePlayer || !overlay.current) { mount("awake"); return; }
    if (reducedMotion()) { mount("awake"); return; }
    clearTimers(); destroy("overlay");
    const seconds = sequenceDuration(lib.definition, lib.sequences.wake);
    setWakeSeconds(seconds);
    players.current.overlay = lib.create(overlay.current, colorOnboardingDefinition(lib.definition, identity, false), { animation: lib.sequences.wake, background: null });
    basePlayer.setAnimation(lib.sequences.wake); basePlayer.play();
    phase.current = "awake";
    // Next frame, so the overlay's first paint is at opacity 0 and the fade transitions from it.
    timers.current.push(window.setTimeout(() => setColored(true), 0));
    // The gray canvas is fully covered by then; the runtime holds the wake's last pose, so the
    // idle loop's first beat picks up from the same face.
    timers.current.push(window.setTimeout(() => {
      destroy("base");
      players.current.overlay?.setAnimation(lib.sequences.awake);
    }, Math.ceil(seconds * 1000) + 50));
  }

  useEffect(() => {
    // The runtime observes its container and needs a GL canvas; where neither
    // exists (jsdom, some embedded views) the still portrait is the whole hero.
    if (typeof IntersectionObserver !== "function" || typeof ResizeObserver !== "function" || typeof WebGLRenderingContext === "undefined") { setFailed(true); return; }
    let disposed = false;
    setReady(false);
    void Promise.all([import("@/vendor/cliplab-runtime/cliplab"), import("@/assets/cliplab/onboarding.character.json")]).then(([runtime, exported]) => {
      if (disposed) return;
      const definition = exported.default as unknown as Definition;
      library.current = { create: runtime.createCharacter, definition, sequences: resolveOnboardingSequences(definition) };
      mount(phase.current);
      setReady(true);
    }).catch((error: unknown) => {
      if (disposed) return;
      console.warn("Onboarding character unavailable, showing the still portrait.", error);
      setFailed(true);
    });
    return () => { disposed = true; clearTimers(); destroy("overlay"); destroy("base"); library.current = null; setReady(false); };
    // Mount once; later prop changes are transitions handled below.
  }, []);

  useEffect(() => {
    if (!ready || !library.current) return;
    const next: Phase = awake ? "awake" : "asleep";
    if (next === phase.current) return;
    try {
      if (next === "awake") wake(); else mount("asleep");
    } catch (error) {
      console.warn("Onboarding character transition failed, showing the still portrait.", error);
      setFailed(true);
    }
  }, [awake, ready]);

  // A palette change while awake (a re-hire) recolours in place; asleep is gray regardless.
  useEffect(() => {
    if (!ready || phase.current !== "awake" || !library.current) return;
    mount("awake");
  }, [identity.paletteId]);

  const live = ready && !failed;
  return (
    <span className={cn("relative inline-block", className)} aria-hidden="true">
      <AgentAvatar appearance={identity} size={256} pose={awake ? "rest" : "sleepy"} muted={!awake} className={cn("size-full", live && "invisible")} />
      <span ref={base} className="absolute inset-0" />
      <span
        ref={overlay}
        className="absolute inset-0 transition-opacity ease-out motion-reduce:transition-none"
        style={{ opacity: colored ? 1 : 0, transitionDuration: `${Math.max(0, wakeSeconds)}s` }}
      />
    </span>
  );
}
