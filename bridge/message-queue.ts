import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface QueuedMessage {
  id: string;
  scope: string;
  paneId: string;
  session: string;
  conversation: string;
  agent: string;
  text: string;
  state: "queued" | "sending" | "sent" | "paused";
  createdAt: number;
  revision: number;
  error?: string;
  sendNow?: boolean;
  device: string | null;
}
export type QueueOutcome = {
  status: "sent" | "blocked" | "uncertain";
  error?: string;
};

/** Single bridge writer. Persist before delivery; interrupted sends never replay after restart. */
export class MessageQueue {
  private rows: QueuedMessage[] = [];
  private serial = Promise.resolve();
  private ready: Promise<void>;
  private running = false;
  private awaitingTurn = new Map<string, QueuedMessage>();
  constructor(private path: string) {
    this.ready = this.restore();
    void this.ready.catch(() => {});
  }
  private async restore() {
    const source = await readFile(this.path, "utf8").catch((error: unknown) => {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return "[]";
      throw error;
    });
    if (source.length > 8 * 1024 * 1024)
      throw new Error("Queue storage exceeds limit.");
    const values: unknown = JSON.parse(source);
    if (!Array.isArray(values) || values.some((row) => !validRow(row)))
      throw new Error("Invalid queue storage.");
    this.rows = values;
    for (const row of this.rows)
      if (row.state === "sending") {
        row.state = "paused";
        row.error = "Delivery was interrupted. Check Terminal before retrying.";
      }
  }
  private async mutate<T>(operation: () => T): Promise<T> {
    const task = this.serial.then(async () => {
      await this.ready;
      const before = structuredClone(this.rows);
      try {
        const value = operation();
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const temp = `${this.path}.${crypto.randomUUID()}.tmp`;
        await writeFile(temp, JSON.stringify(this.rows), {
          mode: 0o600,
          flag: "wx",
        });
        await rename(temp, this.path);
        return value;
      } catch (error) {
        this.rows = before;
        throw error;
      }
    });
    this.serial = task.then(
      () => {},
      () => {},
    );
    return task;
  }
  async list(scope: string) {
    await this.ready;
    await this.serial;
    return this.rows
      .filter((row) => row.scope === scope && row.state !== "sent")
      .map((row) => ({ ...row }));
  }
  async add(row: Omit<QueuedMessage, "createdAt" | "state" | "revision">) {
    return this.mutate(() => {
      const old = this.rows.find((item) => item.id === row.id);
      if (old) {
        if (old.scope !== row.scope || old.text !== row.text)
          throw new Error("Message ID already used.");
        return;
      }
      if (this.rows.filter((item) => item.state !== "sent").length >= 200)
        throw new Error("Queue is full.");
      const retainedSent = new Set(
        this.rows
          .filter(
            (item) =>
              item.state === "sent" &&
              item.createdAt > Date.now() - 7 * 86400_000,
          )
          .slice(-100)
          .map((item) => item.id),
      );
      this.rows = this.rows.filter(
        (item) => item.state !== "sent" || retainedSent.has(item.id),
      );
      this.rows.push({
        ...row,
        state: "queued",
        createdAt: Date.now(),
        revision: 0,
      });
    });
  }
  async change(
    scope: string,
    id: string,
    revision: number,
    action: "remove" | "edit" | "send",
    text?: string,
  ) {
    return this.mutate(() => {
      const row = this.rows.find(
        (item) => item.scope === scope && item.id === id,
      );
      if (
        !row ||
        row.revision !== revision ||
        row.state === "sending" ||
        row.state === "sent"
      )
        throw new Error("The queued message changed. Refresh the queue.");
      if (action === "remove")
        this.rows = this.rows.filter((item) => item !== row);
      else {
        if (action === "edit" && text !== undefined) row.text = text;
        row.state = "queued";
        row.error = undefined;
        row.sendNow = action === "send";
        row.revision++;
      }
    });
  }
  async tick(
    resolve: (
      row: QueuedMessage,
    ) => Promise<"working" | "ready" | "unavailable">,
    deliver: (row: QueuedMessage) => Promise<QueueOutcome>,
  ) {
    if (this.running) return;
    this.running = true;
    const observed = async (row: QueuedMessage) => {
      try {
        return await resolve(row);
      } catch {
        return "unavailable" as const;
      }
    };
    try {
      await this.ready;
      await this.serial;
      for (const [scope, row] of this.awaitingTurn)
        if ((await observed(row)) === "working")
          this.awaitingTurn.delete(scope);
      const scopes = new Set<string>();
      for (const candidate of [...this.rows].sort(
        (a, b) => Number(!!b.sendNow) - Number(!!a.sendNow),
      )) {
        if (candidate.state === "sent" || scopes.has(candidate.scope)) continue;
        scopes.add(candidate.scope);
        if (candidate.state !== "queued") continue;
        const state = await observed(candidate);
        if (state === "working") this.awaitingTurn.delete(candidate.scope);
        if (
          state === "unavailable" ||
          (!candidate.sendNow &&
            (state !== "ready" || this.awaitingTurn.has(candidate.scope)))
        )
          continue;
        const claimed = await this.mutate(() => {
          const row = this.rows.find((item) => item.id === candidate.id);
          if (
            !row ||
            row.state !== "queued" ||
            row.revision !== candidate.revision
          )
            return null;
          row.state = "sending";
          row.revision++;
          return { ...row };
        });
        if (!claimed) continue;
        let outcome: QueueOutcome;
        try {
          outcome = await deliver(claimed);
        } catch {
          outcome = {
            status: "uncertain",
            error:
              "Delivery could not be confirmed. Check Terminal before retrying.",
          };
        }
        await this.mutate(() => {
          const row = this.rows.find((item) => item.id === claimed.id)!;
          row.state = outcome.status === "sent" ? "sent" : "paused";
          row.error = outcome.error;
          row.revision++;
        });
        if (outcome.status === "sent")
          this.awaitingTurn.set(claimed.scope, claimed);
      }
    } finally {
      this.running = false;
    }
  }
}
function validRow(row: unknown): row is QueuedMessage {
  if (!row || typeof row !== "object") return false;
  const keys = [
    "id",
    "scope",
    "paneId",
    "session",
    "conversation",
    "agent",
    "text",
  ];
  return (
    keys.every(
      (key) => key in row && typeof Reflect.get(row, key) === "string",
    ) &&
    "state" in row &&
    ["queued", "sending", "sent", "paused"].includes(String(row.state)) &&
    "revision" in row &&
    typeof row.revision === "number" &&
    "createdAt" in row &&
    typeof row.createdAt === "number"
  );
}
