// Route path helpers. Pane ids contain a colon (e.g. "wE:p2"), so they must be URL-encoded in the
// path; React Router decodes them back in useParams. The active session rides along as `?s=` so a
// navigation stays scoped to the session you're viewing (see lib/session.ts) — omitted on primary.
import { SESSION_PARAM, sessionSearch } from "./session";
import { workspaceEntry, type Herd } from "./spaces";

export function panePath(paneId: string, session?: string): string {
  return `/pane/${encodeURIComponent(paneId)}${sessionSearch(session)}`;
}

/**
 * A pane's conversation history — the agent's own transcript, which is the only scrollback a Claude
 * pane can have (its terminal runs on the alternate screen and retains nothing). A child path of the
 * pane so "back" lands on the live mirror.
 */
export function historyPath(paneId: string, session?: string): string {
  return `/pane/${encodeURIComponent(paneId)}/history${sessionSearch(session)}`;
}

/**
 * A file's own page: Nenu's viewer on the whole screen, for a new tab or a link to keep. It reads the
 * file through the same routes as the viewer in a chat, so it opens nothing the chat could not.
 */
export function filePagePath(paneId: string, path: string, session?: string): string {
  const query = new URLSearchParams({ path });
  if (session) query.set(SESSION_PARAM, session);
  return `/pane/${encodeURIComponent(paneId)}/file?${query}`;
}

/**
 * A workspace's link: the pane it opens on (workspaceEntry), else `/space/:id`, which an empty
 * workspace answers and an older link resolves the same way.
 */
export function workspacePath(workspaceId: string, herd: Herd, session?: string): string {
  const entry = workspaceEntry(workspaceId, herd);
  return entry ? panePath(entry.paneId, session) : `/space/${encodeURIComponent(workspaceId)}${sessionSearch(session)}`;
}

/** The dashboard path, carrying the current session so "go home" doesn't drop you back to primary. */
export function homePath(session?: string): string {
  return `/${sessionSearch(session)}`;
}

/** The settings route, carrying the current session like the other path helpers. */
export function settingsPath(session?: string): string {
  return `/settings${sessionSearch(session)}`;
}

/** Settings → Usage: tokens and API-equivalent cost from the agents' own logs. */
export function usagePath(session?: string): string {
  return `/settings/usage${sessionSearch(session)}`;
}
