import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { loadRawTerminal, saveRawTerminal } from "@/lib/raw-terminal";

// Terminal mirror display preferences, persisted in localStorage.
// Safe to call in SSR contexts (localStorage guarded throughout).

export interface DisplayPrefs {
  /** Whether the mirror wraps long lines (default: true). The mirror is mostly agent prose, and a
   *  phone shows ~45-50 columns against panes herdr spawns at desktop width (190 in one reporter's
   *  session), so panning was the common case, not the exception. Column-faithful no-wrap for TUI
   *  tables stays one tap away in View. */
  wrap: boolean;
  /** Font size in px for the mirror pre (default: 12, range: 9–16). */
  fontSize: number;
  /**
   * Raw-terminal escape hatch (default: false). When on, the mirror renders the PLAIN terminal —
   * every Claude grammar (chrome stripping, native prompt-select buttons, the status strip) is
   * bypassed, so a misdetected/mis-rendered dialog can always be driven manually with the keys pad.
   * The universal fallback, made user-controllable.
   */
  rawTerminal: boolean;
  /**
   * Whether a tap on the terminal mirror focuses the composer (default: true).
   *
   * On, it is the fastest path from reading to replying — the whole mirror is one big "start typing"
   * target. Off, the mirror is a document: taps land on the text, so you can put a caret in it, and
   * the keyboard only appears when you tap the composer itself. Reported from the outside as the
   * mirror "absorbing the click", by someone expecting to interact with a line rather than reply to
   * it — which Nenu cannot offer (herdr's `pane.read` strips the OSC 8 hyperlinks a terminal like
   * Termux makes tappable, so the link target never reaches us). Getting out of the way is the part
   * that IS ours to give.
   */
  tapToFocus: boolean;
}

// v5 deliberately drops the old global raw-terminal bit: one emergency switch must not make every
// future pane open as a terminal. Common preferences migrate from v4; raw view now lives separately
// and is scoped to one Herdr session + pane.
const STORAGE_KEY = "collie:display-prefs:v5";
const LEGACY_STORAGE_KEY = "collie:display-prefs:v4";
const DEFAULT_SCOPE = "global";
export const FONT_MIN = 9;
export const FONT_MAX = 16;
const DEFAULTS: DisplayPrefs = { wrap: true, fontSize: 12, rawTerminal: false, tapToFocus: true };

function clampFont(n: number): number {
  return Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(n)));
}

function loadPrefs(scope: string): DisplayPrefs {
  try {
    const raw = typeof localStorage !== "undefined"
      ? localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY)
      : null;
    if (!raw) return { ...DEFAULTS, rawTerminal: loadRawTerminal(scope) };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { ...DEFAULTS, rawTerminal: loadRawTerminal(scope) };
    const p = parsed as Record<string, unknown>;
    return {
      wrap: typeof p.wrap === "boolean" ? p.wrap : DEFAULTS.wrap,
      fontSize: typeof p.fontSize === "number" ? clampFont(p.fontSize) : DEFAULTS.fontSize,
      rawTerminal: loadRawTerminal(scope),
      tapToFocus: typeof p.tapToFocus === "boolean" ? p.tapToFocus : DEFAULTS.tapToFocus,
    };
  } catch {
    return { ...DEFAULTS, rawTerminal: loadRawTerminal(scope) };
  }
}

function savePrefs(prefs: DisplayPrefs): void {
  try {
    if (typeof localStorage !== "undefined") {
      const { rawTerminal: _rawTerminal, ...common } = prefs;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(common));
    }
  } catch {
    // Ignore quota / SSR write errors.
  }
}

export interface UseDisplayPrefsReturn {
  prefs: DisplayPrefs;
  /** Toggle or explicitly set line-wrap. */
  setWrap: (wrap: boolean) => void;
  /** Set font size, clamped to 9–16. */
  setFontSize: (size: number) => void;
  /** Step font size by delta (positive = larger), clamped to 9–16. */
  stepFontSize: (delta: number) => void;
  /** Toggle or explicitly set the raw-terminal escape hatch. */
  setRawTerminal: (raw: boolean) => void;
  /** Toggle or explicitly set whether a mirror tap focuses the composer. */
  setTapToFocus: (tapToFocus: boolean) => void;
}

export function useDisplayPrefs(scope = DEFAULT_SCOPE): UseDisplayPrefsReturn {
  const [prefs, setPrefs] = useState<DisplayPrefs>(() => loadPrefs(scope));

  useEffect(() => {
    setPrefs(loadPrefs(scope));
  }, [scope]);

  const setWrap = useCallback((wrap: boolean) => {
    setPrefs((p) => {
      const next: DisplayPrefs = { ...p, wrap };
      savePrefs(next);
      return next;
    });
  }, []);

  const setFontSize = useCallback((size: number) => {
    setPrefs((p) => {
      const next: DisplayPrefs = { ...p, fontSize: clampFont(size) };
      savePrefs(next);
      return next;
    });
  }, []);

  const stepFontSize = useCallback((delta: number) => {
    setPrefs((p) => {
      const next: DisplayPrefs = { ...p, fontSize: clampFont(p.fontSize + delta) };
      savePrefs(next);
      return next;
    });
  }, []);

  const setRawTerminal = useCallback((rawTerminal: boolean) => {
    setPrefs((p) => {
      const next: DisplayPrefs = { ...p, rawTerminal };
      saveRawTerminal(scope, rawTerminal);
      return next;
    });
  }, [scope]);

  const setTapToFocus = useCallback((tapToFocus: boolean) => {
    setPrefs((p) => {
      const next: DisplayPrefs = { ...p, tapToFocus };
      savePrefs(next);
      return next;
    });
  }, []);

  return { prefs, setWrap, setFontSize, stepFontSize, setRawTerminal, setTapToFocus };
}

// ── Chat text ─────────────────────────────────────────────────────────────────────────────────────
//
// How big the conversation reads. The choice goes on the root as data-chat-text, and the chat
// stylesheet (styles/chat.css) turns it into a step around the root's own body size for the
// conversation's turns only, so the app's row titles keep their size and the mirror keeps its own
// Text size above. One value for the whole app, not per pane, and applied at import so every route,
// history included, reads it from first paint, before any Display dock has mounted.

export type ChatTextSize = "small" | "default" | "large";

export const CHAT_TEXT_SIZES: ReadonlyArray<{ id: ChatTextSize; label: string }> = [
  { id: "small", label: "Small" },
  { id: "default", label: "Default" },
  { id: "large", label: "Large" },
];

const CHAT_TEXT_KEY = "collie:chat-text:v1";

function isChatTextSize(value: unknown): value is ChatTextSize {
  return CHAT_TEXT_SIZES.some((size) => size.id === value);
}

function loadChatText(): ChatTextSize {
  try {
    const stored = typeof localStorage !== "undefined" ? localStorage.getItem(CHAT_TEXT_KEY) : null;
    return isChatTextSize(stored) ? stored : "default";
  } catch {
    return "default";
  }
}

function applyChatText(size: ChatTextSize): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (size === "default") delete root.dataset.chatText;
  else root.dataset.chatText = size;
}

let chatText = loadChatText();
const chatTextListeners = new Set<() => void>();
applyChatText(chatText);

function setChatText(size: ChatTextSize): void {
  chatText = size;
  try {
    if (typeof localStorage !== "undefined") {
      if (size === "default") localStorage.removeItem(CHAT_TEXT_KEY);
      else localStorage.setItem(CHAT_TEXT_KEY, size);
    }
  } catch {
    // Ignore quota / SSR write errors; the size still applies for this session.
  }
  applyChatText(size);
  for (const listener of chatTextListeners) listener();
}

function subscribeChatText(listener: () => void): () => void {
  chatTextListeners.add(listener);
  return () => chatTextListeners.delete(listener);
}

export function useChatText(): [ChatTextSize, (size: ChatTextSize) => void] {
  return [useSyncExternalStore(subscribeChatText, () => chatText, () => "default"), setChatText];
}
