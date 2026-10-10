// Motion system (docs/GUIDE.md §15.3.A): shared durations / easing for CSS
// (custom properties in app.css) and Svelte transitions, the effective motion
// mode, and the View Transitions based theme-switch animation.
//
// Plain TS (no runes): the mode is only read when a transition starts, so it
// does not need to be reactive.

import { tick } from "svelte";

export type MotionSetting = "full" | "reduced" | "off";

/** Durations in ms. Mirrored by `--motion-fast|base|slow` in app.css. */
export const DURATION = { fast: 120, base: 180, slow: 260 } as const;
/** Theme reveal duration (circular wipe). */
export const THEME_REVEAL_MS = 400;
/** Standard ease-out; mirrored by `--motion-ease` in app.css. */
export const EASE_CSS = "cubic-bezier(0.22, 1, 0.36, 1)";
/** The same curve as a Svelte easing function (easeOutQuart is close enough). */
export const easeOut = (t: number): number => 1 - Math.pow(1 - t, 4);

let mode: MotionSetting = "full";
let mql: MediaQueryList | null = null;
let userSetting: MotionSetting = "full";

/** `full` + OS "reduce motion" = `reduced`. */
export function effectiveMotion(setting: MotionSetting): MotionSetting {
  if (setting === "full" && typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    return "reduced";
  }
  return setting;
}

/** Sets the mode used by the helpers below and `<html data-motion>` (the
 * effective mode, which CSS gates on). Called from `applyTheme()`. */
export function applyMotion(root: HTMLElement, setting: MotionSetting): void {
  userSetting = setting;
  mode = effectiveMotion(setting);
  root.dataset.motion = mode;
  if (!mql && typeof window !== "undefined" && window.matchMedia) {
    mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    mql.addEventListener?.("change", () => applyMotion(document.documentElement, userSetting));
  }
}

export function motionMode(): MotionSetting {
  return mode;
}

/** `ms`, or 0 when motion is off. */
export function dur(ms: number): number {
  return mode === "off" ? 0 : ms;
}

/** Ready-made params for `svelte/transition` (`fade`, `fly`, `scale`).
 * `y` / `scale` are dropped when motion is reduced (opacity only). */
export function fadeParams(ms: number = DURATION.fast) {
  return { duration: dur(ms), easing: easeOut };
}
export function flyParams(y = 6, ms: number = DURATION.base) {
  return { duration: dur(ms), easing: easeOut, y: mode === "full" ? y : 0 };
}
export function scaleParams(start = 0.96, ms: number = DURATION.fast) {
  return { duration: dur(ms), easing: easeOut, start: mode === "full" ? start : 1 };
}

// --- theme switch (View Transitions API) ---------------------------------

type VT = { ready: Promise<void>; finished: Promise<void>; skipTransition(): void };
type VTDocument = Document & { startViewTransition?: (cb: () => void | Promise<void>) => VT };

let pointer: { x: number; y: number; t: number } | null = null;
let fadeHintUntil = 0;
let active: VT | null = null;

if (typeof window !== "undefined") {
  window.addEventListener(
    "pointerdown",
    (e) => {
      pointer = { x: e.clientX, y: e.clientY, t: performance.now() };
    },
    { capture: true, passive: true },
  );
}

/** Next theme change (within ~250ms) uses the fast crossfade instead of the
 * circular reveal: live preview in the theme picker, reverting on Esc. */
export function hintThemeFade(ms = 250): void {
  fadeHintUntil = performance.now() + ms;
}

function origin(): { x: number; y: number } {
  // A pointer press within the last 2s is taken as the cause; otherwise the
  // change came from the keyboard and the reveal starts in the centre.
  if (pointer && performance.now() - pointer.t < 2000) return { x: pointer.x, y: pointer.y };
  return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
}

async function settle(): Promise<void> {
  await tick();
  // One frame so xterm (rAF-debounced render) has repainted before the
  // "new" snapshot is taken; bounded in case rAF is throttled.
  await Promise.race([new Promise<void>((r) => requestAnimationFrame(() => r())), new Promise<void>((r) => setTimeout(r, 50))]);
}

/** Runs `commit` (which switches the theme in the DOM) inside a view
 * transition: circular reveal from the last pointer press (full), crossfade
 * (reduced, or `hintThemeFade`), instant (off / unsupported). A newer call
 * skips the running transition, so rapid changes never queue. */
export function runThemeTransition(commit: () => void): void {
  const doc = document as VTDocument;
  const root = document.documentElement;
  if (mode === "off" || typeof doc.startViewTransition !== "function") {
    commit();
    return;
  }
  active?.skipTransition();
  const fast = performance.now() < fadeHintUntil;
  const fade = mode === "reduced" || fast;
  const { x, y } = origin();
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    commit();
  };
  root.dataset.themeSwitching = fade ? "fade" : "reveal";
  let t: VT;
  try {
    t = doc.startViewTransition(async () => {
      run();
      await settle();
    });
  } catch {
    delete root.dataset.themeSwitching;
    run();
    return;
  }
  active = t;
  // Never leave the theme unapplied if the browser withholds the callback.
  setTimeout(run, 600);
  t.ready
    .then(() => {
      if (active !== t) return;
      const opts: KeyframeAnimationOptions = { pseudoElement: "::view-transition-new(root)", fill: "both" };
      if (fade) {
        root.animate({ opacity: [0, 1] }, { ...opts, duration: fast ? DURATION.fast : DURATION.base, easing: "ease-out" });
      } else {
        const r = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
        root.animate(
          { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${Math.ceil(r)}px at ${x}px ${y}px)`] },
          { ...opts, duration: THEME_REVEAL_MS, easing: EASE_CSS },
        );
      }
    })
    .catch(() => {});
  const clear = () => {
    if (active === t) {
      active = null;
      delete root.dataset.themeSwitching;
    }
  };
  t.finished.then(clear, clear);
}
