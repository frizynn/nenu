import { join } from "node:path";
import { homedir } from "node:os";
import WebSocket from "ws";

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid Codex response.");
  return value as Record<string, unknown>;
}

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

/** A local client of the existing daemon. It never starts/stops Codex or replays a failed command. */
export class CodexRpc {
  private socket: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();

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
              request.reject(new Error(typeof error.message === "string" ? error.message : "Codex rejected the request."));
            } else request.resolve(message.result);
          }
        } catch { socket.close(1002, "Invalid protocol message"); }
      });
      socket.once("open", () => {
        void this.sendRequest("initialize", {
          clientInfo: { name: "nenu", version: "1" }, capabilities: { experimentalApi: true },
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

  close(): void { this.socket?.close(); }
}
