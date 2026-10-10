import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isSessionId } from "./journal/claude.ts";
import { object, shortText } from "./subagent-files.ts";
import type { AgentView, InteractionHint, LivePublisher, LiveTopic } from "./types.ts";

// Observer-only Claude Code hooks (ADR 0057). Claude POSTs a hook's JSON here (scripts/
// install-claude-hooks.ts writes `type: "http"` hooks). A delivery only pokes: it names the pane on
// the live stream and keeps the dialog's text as an in-memory hint. The bridge answers every hook
// with an empty 204, which Claude reads as "no output", so a hook never allows, denies or blocks.

export const CLAUDE_HOOK_PATH = "/api/hooks/claude";
export const CLAUDE_HOOK_TOKEN_HEADER = "x-nenu-hook-token";
export const CLAUDE_HOOK_TOKEN_ENV = "NENU_HOOK_TOKEN";
/** The token's file under the bridge state dir; the installer creates it, the route reads it. */
export const CLAUDE_HOOK_TOKEN_FILE = "claude-hooks.token";

/** The events the installer subscribes to, with the matcher each one uses. */
export const CLAUDE_HOOK_EVENTS = {
  UserPromptSubmit: undefined,
  PreToolUse: "AskUserQuestion|ExitPlanMode",
  PermissionRequest: undefined,
  Notification: "permission_prompt|idle_prompt|elicitation_dialog|agent_needs_input",
  Stop: undefined,
  StopFailure: undefined,
} as const satisfies Record<string, string | undefined>;

export type ClaudeHookEvent = keyof typeof CLAUDE_HOOK_EVENTS;

/** One delivery, reduced to metadata plus the dialog text a card needs. Prompts and replies are dropped. */
export interface ClaudeHookObservation {
  event: ClaudeHookEvent;
  sessionId: string;
  observedAt: number;
  toolName?: string;
  notificationType?: string;
  hint?: InteractionHint;
}

const MAX_DETAIL = 8_000;
const HINT_TTL_MS = 10 * 60_000;

const isEvent = (value: string): value is ClaudeHookEvent => Object.hasOwn(CLAUDE_HOOK_EVENTS, value);

/** Decode a hook body. Anything that is not a known event from a well-formed session is null. */
export function decodeClaudeHook(body: unknown, now = Date.now()): ClaudeHookObservation | null {
  const row = object(body);
  const event = shortText(row.hook_event_name, 40);
  const sessionId = shortText(row.session_id, 64);
  if (!isEvent(event) || !isSessionId(sessionId)) return null;
  const toolName = shortText(row.tool_name, 120) || undefined;
  const notificationType = shortText(row.notification_type, 60) || undefined;
  const hint = hintFrom(event, toolName, object(row.tool_input), now);
  return { event, sessionId, observedAt: now, ...(toolName ? { toolName } : {}), ...(notificationType ? { notificationType } : {}), ...(hint ? { hint } : {}) };
}

function hintFrom(event: ClaudeHookEvent, tool: string | undefined, input: Record<string, unknown>, observedAt: number): InteractionHint | undefined {
  if (event === "PreToolUse" && tool === "AskUserQuestion") {
    const first = object(Array.isArray(input.questions) ? input.questions[0] : undefined);
    const question = shortText(first.question, 500);
    if (!question) return undefined;
    const options = (Array.isArray(first.options) ? first.options : []).map((o) => shortText(object(o).label, 200)).filter(Boolean);
    return { source: "claude-hook", observedAt, question, options };
  }
  if (event === "PreToolUse" && tool === "ExitPlanMode") {
    const plan = shortText(input.plan, MAX_DETAIL);
    return plan ? { source: "claude-hook", observedAt, detail: plan } : undefined;
  }
  if (event === "PermissionRequest" && tool) {
    const subject = [input.command, input.file_path, input.url, input.pattern].find((v) => typeof v === "string" && v);
    return { source: "claude-hook", observedAt, question: tool, ...(subject ? { detail: shortText(subject, MAX_DETAIL) } : {}) };
  }
  return undefined;
}

/** The one Claude pane whose Herdr-reported session is this id; null when none or ambiguous. */
export function paneForSession(agents: readonly AgentView[], sessionId: string): string | null {
  const owners = agents.filter((a) => a.agent === "claude" && a.agentSession?.kind === "id" && a.agentSession.value === sessionId);
  return owners.length === 1 ? owners[0]!.paneId : null;
}

/** Constant-time comparison; an empty expected token never matches. */
export function hookTokenMatches(given: string | null, expected: string): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The installed token, or "" when hooks were never installed (every delivery is then refused). */
export async function readHookToken(stateDir: string): Promise<string> {
  try {
    return (await readFile(join(stateDir, CLAUDE_HOOK_TOKEN_FILE), "utf8")).trim();
  } catch {
    return "";
  }
}

const TOPICS: Record<ClaudeHookEvent, LiveTopic[]> = {
  UserPromptSubmit: ["pane"],
  PreToolUse: ["pane", "interaction"],
  PermissionRequest: ["pane", "interaction"],
  Notification: ["pane", "interaction"],
  Stop: ["pane", "journal", "interaction"],
  StopFailure: ["pane", "journal", "interaction"],
};

export class ClaudeHooks {
  /** Latest dialog hint per pane, in memory only; a restart forgets it and the screen still rules. */
  private readonly hints = new Map<string, InteractionHint>();

  constructor(readonly live: LivePublisher) {}

  /** Record one observation for its pane and name what changed on the live stream. */
  receive(session: string, paneId: string, observation: ClaudeHookObservation): void {
    const key = `${session}\u0000${paneId}`;
    if (observation.hint) this.hints.set(key, observation.hint);
    else if (observation.event === "Stop" || observation.event === "StopFailure" || observation.event === "UserPromptSubmit") this.hints.delete(key);
    for (const topic of TOPICS[observation.event]) this.live.publish({ session, topic, paneId });
  }

  /** The pane's latest hook hint while it is fresh, for enriching a screen-detected Interaction. */
  hintFor(session: string, paneId: string, now = Date.now()): InteractionHint | undefined {
    const hint = this.hints.get(`${session}\u0000${paneId}`);
    return hint && now - hint.observedAt <= HINT_TTL_MS ? hint : undefined;
  }
}
