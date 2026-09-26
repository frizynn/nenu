import type { TranscriptEntry } from "./journal/types.ts";

export type SubagentStatus = "running" | "waiting" | "idle" | "completed" | "failed" | "unknown";
export interface SubagentView {
  id: string;
  parentId: string;
  name: string;
  task: string;
  model?: string;
  status: SubagentStatus;
  updatedAt?: string;
}
export type SubagentsResponse =
  | { available: false; reason: "disabled" | "no-session" | "unsupported" }
  | { available: true; sessionKey: string; agents: SubagentView[]; truncated: boolean };
export interface SubagentHistoryResponse {
  sessionKey: string;
  agent: SubagentView;
  entries: TranscriptEntry[];
  truncated: boolean;
}
