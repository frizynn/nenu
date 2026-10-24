// What the desk's sidebar lists, drawn the way Cursor's agent window draws its own: every
// conversation as a chat, dated by when it last moved. Kept free of React so the rows' rules stay
// unit-testable.
import { displayName } from "./display-name";
import { chatRecency } from "./recency";
import type { AgentStatus, AgentView } from "./types";

export interface DeskChat {
  key: string;
  title: string;
  /** The live pane it opens. */
  paneId: string;
  pane: AgentView;
  /** When it last moved, epoch ms; 0 when nothing says. */
  at: number;
  /** It finished or asked for you since it was last opened in Nenu: the row's +1, in place of a toast. */
  unread: boolean;
}

/** `done` already means not yet seen in Nenu (ADR 0071); an ask is new until the chat is opened after it. */
const unread = (pane: AgentView) =>
  (pane.status === "done" || pane.status === "blocked") && (pane.lastActiveAt ?? 0) > (pane.lastSeenAt ?? 0);

/** Every agent pane, as a chat. */
export function deskChats(data: { agents: readonly AgentView[] }): DeskChat[] {
  return data.agents.map((pane): DeskChat => ({
    key: pane.paneId, title: displayName(pane), paneId: pane.paneId, pane, at: chatRecency(pane), unread: unread(pane),
  }));
}

/** The most pressing state among `panes`, for a row's dot. Resting agents draw none. */
export function liveliest(panes: readonly AgentView[]): AgentStatus | undefined {
  return (["blocked", "working", "done"] as const).find((status) => panes.some((pane) => pane.status === status));
}
