// Whether a pane opens on its raw terminal instead of its chat, kept per Herdr session and pane. The
// pane's loader reads it too, so a chat that will not be drawn has no conversation read for it.

const RAW_STORAGE_KEY = "collie:raw-terminal-scopes:v1";
const MAX_RAW_SCOPES = 32;

/** The key a pane's display preferences are kept under. */
export function paneDisplayScope(session: string | undefined, paneId: string): string {
  return JSON.stringify([session ?? "default", paneId]);
}

export function loadRawTerminal(scope: string): boolean {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(RAW_STORAGE_KEY) : null;
    if (!raw) return false;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return false;
    return (parsed as Record<string, unknown>)[scope] === true;
  } catch {
    return false;
  }
}

export function saveRawTerminal(scope: string, rawTerminal: boolean): void {
  try {
    if (typeof localStorage === "undefined") return;
    const stored = localStorage.getItem(RAW_STORAGE_KEY);
    const parsed: unknown = stored ? JSON.parse(stored) : {};
    const previous = typeof parsed === "object" && parsed !== null
      ? parsed as Record<string, unknown>
      : {};
    const entries = Object.entries(previous).filter(([key, value]) => key !== scope && value === true);
    if (rawTerminal) entries.push([scope, true]);
    localStorage.setItem(RAW_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries.slice(-MAX_RAW_SCOPES))));
  } catch {
    // Ignore quota / malformed previous payload / SSR write errors.
  }
}
