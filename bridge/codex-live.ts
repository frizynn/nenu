import { codexRpc, CodexRpcError, type CodexMessage, type CodexRpc } from "./codex-rpc.ts";
import { isCodexSessionId } from "./journal/codex.ts";
import type { SessionTelemetry } from "./journal/types.ts";
import type { AgentView, InteractionHint, LivePublisher, LiveTopic } from "./types.ts";

// Live Codex thread notifications over the daemon socket Nenu already opens. Observe only
// (ADR 0060): it subscribes to threads a page is looking at, turns their events into invalidation
// names, and keeps the latest plan, diff, token usage and pending-request text. It never sends a
// turn and never answers a request; panes started with --no-daemon are not loaded in the daemon
// and are left exactly as before.

type Rpc = Pick<CodexRpc, "request" | "listen">;

export interface CodexPlanStep { step: string; status: "pending" | "inProgress" | "completed" }

export interface CodexLiveView {
  threadId: string;
  /** False until thread/resume succeeded on the current connection. */
  subscribed: boolean;
  status?: "idle" | "active" | "systemError" | "notLoaded";
  waitingOn: Array<"waitingOnApproval" | "waitingOnUserInput">;
  plan?: { turnId: string; explanation?: string; steps: CodexPlanStep[] };
  diff?: { turnId: string; diff: string; truncated: boolean };
  telemetry?: SessionTelemetry;
}

interface Thread {
  id: string;
  watches: Map<string, { session: string; paneId: string; until: number }>;
  state: "idle" | "subscribing" | "subscribed" | "closing";
  retryAt: number;
  view: CodexLiveView;
  requests: Map<string, InteractionHint>;
}

const MAX_DIFF = 256 * 1024;
const RETRY_MS = 30_000;
const REQUEST_METHODS = new Set([
  "item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval",
  "item/tool/requestUserInput", "mcpServer/elicitation/request",
]);
const JOURNAL_METHODS = new Set(["item/completed", "turn/started", "turn/completed", "thread/compacted", "turn/plan/updated", "turn/diff/updated", "thread/tokenUsage/updated"]);

const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;
const obj = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** The text a server request carries, as a hint for the dialog the screen shows. Never an answer. */
export function codexRequestHint(method: string, params: Record<string, unknown>, observedAt: number): InteractionHint {
  const hint: InteractionHint = { source: "codex-rpc", observedAt };
  if (method === "item/commandExecution/requestApproval") {
    hint.question = text(params.reason) ?? "Run this command?";
    const detail = text(params.command);
    if (detail) hint.detail = detail;
  } else if (method === "item/fileChange/requestApproval") {
    hint.question = text(params.reason) ?? "Apply these changes?";
    const detail = text(params.grantRoot);
    if (detail) hint.detail = detail;
  } else if (method === "item/permissions/requestApproval") {
    hint.question = text(params.reason) ?? "Grant these permissions?";
    const detail = text(params.cwd);
    if (detail) hint.detail = detail;
  } else if (method === "item/tool/requestUserInput") {
    const questions = Array.isArray(params.questions) ? params.questions.map(obj) : [];
    const question = questions.map((q) => text(q.question)).filter(Boolean).join("\n");
    if (question) hint.question = question;
    const options = Array.isArray(questions[0]?.options) ? questions[0].options.map((o) => text(obj(o).label)).filter((o): o is string => !!o) : [];
    if (options.length) hint.options = options;
  } else {
    const question = text(params.message) ?? text(params.title);
    if (question) hint.question = question;
    const detail = text(params.url);
    if (detail) hint.detail = detail;
  }
  return hint;
}

/** thread/tokenUsage/updated in the journal's telemetry shape, so both sources read the same. */
export function codexTokenTelemetry(usage: Record<string, unknown>, observedAt: number): SessionTelemetry {
  const total = obj(usage.total);
  const window = count(usage.modelContextWindow);
  return {
    source: "journal", observedAt: new Date(observedAt).toISOString(), fileTruncated: false,
    tokens: { scope: "session", input: count(total.inputTokens), output: count(total.outputTokens), cachedInput: count(total.cachedInputTokens), total: count(total.totalTokens) },
    context: { usedTokens: count(obj(usage.last).totalTokens), ...(window ? { windowTokens: window } : {}) },
  };
}

export class CodexLive {
  private readonly threads = new Map<string, Thread>();
  private readonly panes = new Map<string, string>();
  private stopListening: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(readonly live: LivePublisher, private readonly rpc: Rpc = codexRpc(), private readonly now = Date.now, private readonly graceMs = 60_000) {}

  /** A page is looking at this pane: follow its Codex thread for the next `graceMs`. */
  observe(session: string, pane: AgentView): void {
    if (pane.agent !== "codex" || pane.agentSession?.kind !== "id" || !isCodexSessionId(pane.agentSession.value)) return;
    const threadId = pane.agentSession.value;
    const key = `${session}\0${pane.paneId}`;
    const previous = this.panes.get(key);
    if (previous && previous !== threadId) this.threads.get(previous)?.watches.delete(key);
    this.panes.set(key, threadId);
    let thread = this.threads.get(threadId);
    if (!thread) {
      thread = { id: threadId, watches: new Map(), state: "idle", retryAt: 0, view: { threadId, subscribed: false, waitingOn: [] }, requests: new Map() };
      this.threads.set(threadId, thread);
    }
    thread.watches.set(key, { session, paneId: pane.paneId, until: this.now() + this.graceMs });
    this.start();
    if (thread.state === "idle" && thread.retryAt <= this.now()) void this.subscribe(thread);
  }

  view(session: string, paneId: string): CodexLiveView | null {
    const thread = this.threadFor(session, paneId);
    return thread ? structuredClone(thread.view) : null;
  }

  /** Text of the approvals and questions Codex is waiting on, oldest first. */
  hints(session: string, paneId: string): InteractionHint[] {
    return [...this.threadFor(session, paneId)?.requests.values() ?? []];
  }

  /** Forget watches that ran out and leave threads nobody is watching. Runs on a timer. */
  async sweep(): Promise<void> {
    const now = this.now();
    for (const thread of this.threads.values()) {
      for (const [key, watch] of thread.watches) {
        if (watch.until > now) continue;
        thread.watches.delete(key);
        if (this.panes.get(key) === thread.id) this.panes.delete(key);
      }
      if (thread.watches.size) continue;
      this.threads.delete(thread.id);
      if (thread.state !== "subscribed") continue;
      thread.state = "closing";
      await this.rpc.request("thread/unsubscribe", { threadId: thread.id }).catch(() => {});
    }
    if (!this.threads.size) this.stop();
  }

  close(): void {
    this.stop();
    this.threads.clear();
    this.panes.clear();
  }

  private threadFor(session: string, paneId: string): Thread | undefined {
    const id = this.panes.get(`${session}\0${paneId}`);
    return id ? this.threads.get(id) : undefined;
  }

  private start(): void {
    this.stopListening ??= this.rpc.listen({ message: (message) => this.message(message), closed: () => this.closed() });
    if (!this.timer) {
      this.timer = setInterval(() => void this.sweep(), 15_000);
      this.timer.unref?.();
    }
  }

  private stop(): void {
    this.stopListening?.();
    this.stopListening = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async subscribe(thread: Thread): Promise<void> {
    thread.state = "subscribing";
    try {
      const read = obj(obj(await this.rpc.request("thread/read", { threadId: thread.id, includeTurns: false })).thread);
      // Not loaded means no daemon client runs it (a --no-daemon pane): resuming would load it.
      if (obj(read.status).type !== "active" && obj(read.status).type !== "idle") throw new Error("Thread is not running in the daemon.");
      // A running-thread resume reports the thread idle, and Codex's queue then sends its next
      // message. Only resume when nothing is queued, so observing never starts a turn.
      const queued = await this.rpc.request("thread/queue/list", { threadId: thread.id, limit: 1 })
        .then((result) => Array.isArray(obj(result).data) ? (obj(result).data as unknown[]).length : 1,
          (error: unknown) => { if (error instanceof CodexRpcError && error.code === -32601) return 0; throw error; });
      if (queued) throw new Error("Thread has queued input.");
      const resumed = obj(await this.rpc.request("thread/resume", { threadId: thread.id, excludeTurns: true }));
      if (this.threads.get(thread.id) !== thread) {
        // Nobody watches it any more; a newer entry for the same thread manages its own subscription.
        if (!this.threads.has(thread.id)) await this.rpc.request("thread/unsubscribe", { threadId: thread.id }).catch(() => {});
        return;
      }
      thread.state = "subscribed";
      thread.view.subscribed = true;
      this.status(thread, obj(obj(resumed.thread).status));
      this.publish(thread, "pane");
    } catch {
      thread.state = "idle";
      thread.retryAt = this.now() + RETRY_MS;
    }
  }

  private closed(): void {
    for (const thread of this.threads.values()) {
      thread.state = "idle";
      thread.retryAt = 0;
      thread.view.subscribed = false;
      thread.requests.clear();
    }
  }

  private message({ method, params, id }: CodexMessage): void {
    const thread = typeof params.threadId === "string" ? this.threads.get(params.threadId) : undefined;
    if (!thread || thread.state !== "subscribed") return;
    if (id !== undefined) {
      if (!REQUEST_METHODS.has(method)) return;
      thread.requests.set(String(id), codexRequestHint(method, params, this.now()));
      this.publish(thread, "interaction");
      return;
    }
    if (method === "serverRequest/resolved") {
      if (thread.requests.delete(String(params.requestId))) this.publish(thread, "interaction");
      return;
    }
    if (method === "thread/status/changed") {
      this.status(thread, obj(params.status));
      this.publish(thread, "pane");
      this.publish(thread, "interaction");
      return;
    }
    if (method === "thread/closed") {
      thread.state = "idle";
      thread.view.subscribed = false;
      thread.requests.clear();
      this.publish(thread, "pane");
      return;
    }
    const turnId = typeof params.turnId === "string" ? params.turnId : "";
    if (method === "turn/plan/updated") {
      const steps = Array.isArray(params.plan) ? params.plan.map(obj).flatMap((step): CodexPlanStep[] =>
        typeof step.step === "string" && (step.status === "pending" || step.status === "inProgress" || step.status === "completed")
          ? [{ step: step.step, status: step.status }] : []) : [];
      const explanation = text(params.explanation);
      thread.view.plan = { turnId, steps, ...(explanation ? { explanation } : {}) };
    } else if (method === "turn/diff/updated" && typeof params.diff === "string") {
      thread.view.diff = { turnId, diff: params.diff.slice(0, MAX_DIFF), truncated: params.diff.length > MAX_DIFF };
    } else if (method === "thread/tokenUsage/updated") {
      thread.view.telemetry = codexTokenTelemetry(obj(params.tokenUsage), this.now());
    } else if (method === "turn/completed" && thread.requests.size) {
      // Codex drops a turn's pending requests when the turn ends.
      thread.requests.clear();
      this.publish(thread, "interaction");
    }
    if (JOURNAL_METHODS.has(method)) this.publish(thread, "journal");
  }

  private status(thread: Thread, status: Record<string, unknown>): void {
    const type = status.type;
    if (type !== "idle" && type !== "active" && type !== "systemError" && type !== "notLoaded") return;
    thread.view.status = type;
    thread.view.waitingOn = type === "active" && Array.isArray(status.activeFlags)
      ? status.activeFlags.filter((flag): flag is CodexLiveView["waitingOn"][number] => flag === "waitingOnApproval" || flag === "waitingOnUserInput")
      : [];
  }

  private publish(thread: Thread, topic: LiveTopic): void {
    const now = this.now();
    for (const watch of thread.watches.values()) {
      if (watch.until > now) this.live.publish({ session: watch.session, topic, paneId: watch.paneId });
    }
  }
}
