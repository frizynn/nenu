import { join } from "node:path";
import { homedir } from "node:os";
import WebSocket from "ws";

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid Codex response.");
  return value as Record<string, unknown>;
}

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

export class CodexRpcError extends Error {
  constructor(message: string, readonly code?: number) { super(message); }
}

/** A notification, or a server request when `id` is set. Nenu never answers a server request. */
export interface CodexMessage { method: string; params: Record<string, unknown>; id?: number | string }
export interface CodexListener { message(message: CodexMessage): void; closed?(): void }

// Streaming deltas and unrelated global events. Nenu turns notifications into "re-read" names, so a
// token-by-token stream would only cost CPU. Exact names, as initialize requires.
export const OPTED_OUT_NOTIFICATIONS = [
  "item/agentMessage/delta", "item/plan/delta", "item/reasoning/summaryTextDelta", "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta", "item/commandExecution/outputDelta", "item/commandExecution/terminalInteraction",
  "item/fileChange/outputDelta", "item/fileChange/patchUpdated", "item/mcpToolCall/progress", "command/exec/outputDelta",
  "process/outputDelta", "process/exited", "rawResponseItem/completed", "rawResponse/completed", "fs/changed",
  "fuzzyFileSearch/sessionUpdated", "fuzzyFileSearch/sessionCompleted", "mcpServer/event/stream/notification",
  "account/rateLimits/updated", "model/safetyBuffering/updated", "thread/realtime/started", "thread/realtime/itemAdded",
  "thread/realtime/item/started", "thread/realtime/item/transcript/delta", "thread/realtime/item/completed",
  "thread/realtime/transcript/delta", "thread/realtime/transcript/done", "thread/realtime/outputAudio/delta",
  "thread/realtime/sdp", "thread/realtime/error", "thread/realtime/closed",
];

/** A local client of the existing daemon. It never starts/stops Codex or replays a failed command. */
export class CodexRpc {
  private socket: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<CodexListener>();

  constructor(readonly socketPath = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "app-server-control/app-server-control.sock")) {}

  private connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    const opening = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`ws+unix://${this.socketPath}:/`, { maxPayload: 32 * 1024 * 1024, handshakeTimeout: 5_000 });
      this.socket = socket;
      const failed = () => {
        const error = new Error("Codex server is unavailable. Check that the local daemon is running.");
        if (this.socket !== socket) return;
        this.socket = null;
        for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
        this.pending.clear();
        reject(error);
        // Subscriptions belong to the connection; listeners must resubscribe on the next one.
        for (const listener of this.listeners) listener.closed?.();
      };
      socket.on("error", failed);
      socket.on("close", failed);
      socket.on("message", (bytes) => {
        try {
          const message = record(JSON.parse(bytes.toString()));
          if (message.method === undefined && typeof message.id === "number") {
            const request = this.pending.get(message.id);
            if (!request) return;
            this.pending.delete(message.id);
            clearTimeout(request.timer);
            if (message.error) {
              const error = record(message.error);
              request.reject(new CodexRpcError(typeof error.message === "string" ? error.message : "Codex rejected the request.",
                typeof error.code === "number" ? error.code : undefined));
            } else request.resolve(message.result);
          } else if (typeof message.method === "string") {
            // Server requests (approvals, questions) are observed, never answered: the first answer
            // wins, so even an error reply from Nenu would decide the terminal's dialog.
            const id = typeof message.id === "number" || typeof message.id === "string" ? message.id : undefined;
            const params = typeof message.params === "object" && message.params !== null && !Array.isArray(message.params)
              ? message.params as Record<string, unknown> : {};
            this.dispatch({ method: message.method, params, ...(id === undefined ? {} : { id }) });
          }
        } catch { socket.close(1002, "Invalid protocol message"); }
      });
      socket.once("open", () => {
        void this.sendRequest("initialize", {
          clientInfo: { name: "nenu", version: "1" },
          capabilities: { experimentalApi: true, optOutNotificationMethods: OPTED_OUT_NOTIFICATIONS },
        }).then(() => {
          socket.send(JSON.stringify({ method: "initialized" }));
          resolve();
        }, (error: unknown) => { socket.close(); reject(error); });
      });
    });
    this.connecting = opening.finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    await this.connect();
    return this.sendRequest(method, params);
  }

  private sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Codex is disconnected."));
    if (this.pending.size >= 64) return Promise.reject(new Error("Codex is busy. Try again shortly."));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Codex did not confirm the request. Check the conversation before retrying."));
      }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Hear notifications and server requests from threads this connection subscribed to. */
  listen(listener: CodexListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private dispatch(message: CodexMessage): void {
    for (const listener of this.listeners) {
      try { listener.message(message); } catch (error) { console.warn("[codex] listener failed:", error instanceof Error ? error.message : "unknown error"); }
    }
  }

  close(): void { this.socket?.close(); }
}

let shared: CodexRpc | null = null;
/** The bridge's one daemon connection; history, identity, subagents and live updates share it. */
export function codexRpc(): CodexRpc {
  return shared ??= new CodexRpc();
}
