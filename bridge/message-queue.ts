import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { normalizeMode } from "./queue-native.ts";
import type { DeliveryMode, NativeQueueState, QueueWaitReason } from "./types.ts";

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
  /** When the last delivery was claimed; a paused row's journal confirmation looks from here. */
  claimedAt?: number;
  sentAt?: number;
  revision: number;
  error?: string;
  /** The operator asked for this row now: it skips the wait for the turn, never the guard. */
  sendNow?: boolean;
  deliveryMode?: DeliveryMode;
  /** Its pane or conversation went away. It is never delivered elsewhere on its own. */
  stranded?: { reason: string; since: number };
  /** What the CLI's own queue did with it, from the CLI's journal (queue-native.ts). */
  native?: NativeQueueState;
  device: string | null;
}
export type QueueOutcome = {
  status: "sent" | "blocked" | "uncertain";
  error?: string;
  native?: NativeQueueState;
};

/** What the delivery side says about a queue's next row. */
export type Verdict<T> =
  | { ready: T }
  | { wait: QueueWaitReason }
  | { stranded: string };

/** Runs a delivery while it owns the row's pane (PaneWrites), or says the pane is busy. */
export type Exclusive = <V>(row: QueuedMessage, operation: () => Promise<V>) => Promise<{ busy: true } | { busy: false; value: V }>;

export interface TickOptions {
  /** Check rows that are backing off too; explicit kicks pass it, the fallback interval does not. */
  force?: boolean;
  exclusive?: Exclusive;
}

const MAX_ROWS = 200;
const MAX_ROWS_PER_SCOPE = 50;
const STORAGE_LIMIT = 8 * 1024 * 1024;
/** A stranded row the operator never came back for is dropped after a day. */
export const STRANDED_TTL_MS = 24 * 3600_000;
/** How long a delivered row stays in `recent`, so its journal state can still be shown. */
export const RECENT_MS = 10 * 60_000;
/**
 * How long a delivered row stays listed to clients. Longer than RECENT_MS: a phone that slept through
 * the delivery must still find the record, or it cannot tell delivered from lost.
 */
export const DELIVERED_LIST_MS = 2 * 3600_000;
// A waiting row is re-read on the fallback interval at most this often: 2 s, then 4 s, then 8 s.
const BACKOFF_MS = [2_000, 4_000, 8_000];
const STRANDED_RECHECK_MS = 30_000;

/**
 * Single bridge writer. Persist before delivery; interrupted sends never replay after restart.
 * Scopes are delivered independently and in parallel; within a scope, one row at a time, in order.
 * Why a row waits is kept in memory and never bumps its revision, so a row that keeps waiting costs
 * no disk write and no event.
 */
export class MessageQueue {
  private rows: QueuedMessage[] = [];
  private serial = Promise.resolve();
  private ready: Promise<void>;
  private workers = new Map<string, { again: boolean; force: boolean; done: Promise<void> }>();
  private waiting = new Map<string, QueueWaitReason>();
  private backoff = new Map<string, { at: number; step: number }>();
  private listeners = new Set<() => void>();
  /** `changed` hears every committed change to a row, after it is on disk, and every new wait reason. */
  constructor(
    private path: string,
    private changed: (row: Pick<QueuedMessage, "session" | "paneId" | "state">) => void = () => {},
    private now: () => number = Date.now,
  ) {
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
    if (source.length > STORAGE_LIMIT)
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
        const encoded = JSON.stringify(this.rows);
        if (encoded.length > STORAGE_LIMIT)
          throw new Error("Queue storage exceeds limit.");
        await writeFile(temp, encoded, {
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
  private notify(row: Pick<QueuedMessage, "session" | "paneId" | "state">) {
    this.changed(row);
    for (const listener of this.listeners) listener();
  }
  /** One row as the wire shows it, with why it waits. */
  private view(row: QueuedMessage) {
    const waitingFor = this.waiting.get(row.id);
    return { ...row, ...(waitingFor && row.state === "queued" ? { waitingFor } : {}) };
  }
  /**
   * The rows a scope still holds, plus the stranded rows an earlier conversation of the same pane
   * left behind, so the operator can see them, move them here or remove them.
   */
  async list(scope: string, pane?: { session: string; paneId: string }) {
    await this.ready;
    await this.serial;
    return this.rows
      .filter((row) => row.state !== "sent" && (row.scope === scope || (!!pane && strandedOn(row, pane))))
      .map((row) => this.view(row));
  }
  /** Delivered rows of a scope from the last {@link DELIVERED_LIST_MS}, newest last. */
  async recent(scope: string) {
    await this.ready;
    await this.serial;
    const since = this.now() - DELIVERED_LIST_MS;
    return this.rows
      .filter((row) => row.scope === scope && row.state === "sent" && (row.sentAt ?? 0) > since)
      .map((row) => ({ ...row }));
  }
  /** Resolves once `test` holds for the row, or after `ms`, with the row as it then is. */
  async until(id: string, test: (row: ReturnType<MessageQueue["view"]>) => boolean, ms: number) {
    await this.ready;
    const current = () => {
      const row = this.rows.find((item) => item.id === id);
      return row ? this.view(row) : undefined;
    };
    await new Promise<void>((resolve) => {
      const check = () => {
        const row = current();
        if (!row || test(row)) finish();
      };
      const finish = () => {
        clearTimeout(timer);
        this.listeners.delete(check);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.listeners.add(check);
      check();
    });
    return current();
  }
  async add(row: Omit<QueuedMessage, "createdAt" | "state" | "revision">) {
    const added = await this.mutate(() => {
      const old = this.rows.find((item) => item.id === row.id);
      if (old) {
        if (old.scope !== row.scope || old.text !== row.text)
          throw new Error("Message ID already used.");
        return false;
      }
      const now = this.now();
      // Delivered receipts: the newest 100 of the last week, plus anything from the last 10 minutes.
      // A stranded row nobody came back for in a day goes too. Unsent rows are never dropped here.
      const retainedSent = new Set(
        this.rows
          .filter((item) => item.state === "sent" && item.createdAt > now - 7 * 86400_000)
          .slice(-100)
          .map((item) => item.id),
      );
      this.rows = this.rows.filter(
        (item) =>
          !(item.stranded && item.stranded.since < now - STRANDED_TTL_MS) &&
          (item.state !== "sent" ||
            retainedSent.has(item.id) ||
            (item.sentAt ?? item.createdAt) > now - DELIVERED_LIST_MS),
      );
      const unsent = this.rows.filter((item) => item.state !== "sent");
      if (unsent.length >= MAX_ROWS) throw new Error("Queue is full.");
      if (unsent.filter((item) => item.scope === row.scope).length >= MAX_ROWS_PER_SCOPE)
        throw new Error("Queue is full for this conversation.");
      this.rows.push({
        ...row,
        state: "queued",
        createdAt: now,
        revision: 0,
      });
      return true;
    });
    if (added) this.notify({ ...row, state: "queued" });
  }
  /**
   * Edit, remove or send a row of `scope`, or a stranded row of the same pane. `send` on a stranded
   * row moves it to `target`, the pane's current conversation and agent: that is the operator
   * choosing to deliver it there.
   */
  async change(
    scope: string,
    id: string,
    revision: number,
    action: "remove" | "edit" | "send",
    text?: string,
    target?: Pick<QueuedMessage, "session" | "paneId" | "conversation" | "agent">,
  ) {
    const row = await this.mutate(() => {
      const row = this.rows.find(
        (item) => item.id === id && (item.scope === scope || (!!target && strandedOn(item, target))),
      );
      if (
        !row ||
        row.revision !== revision ||
        row.state === "sending" ||
        row.state === "sent"
      )
        throw new Error("The queued message changed. Refresh the queue.");
      if (row.state === "paused" && action !== "remove")
        throw new Error(
          "Check Terminal before sending again. Remove this uncertain delivery after checking.",
        );
      if (action === "remove")
        this.rows = this.rows.filter((item) => item !== row);
      else {
        if (action === "edit" && text !== undefined) row.text = text;
        if (row.stranded && action === "send" && target) {
          row.scope = scope;
          row.conversation = target.conversation;
          // The pane may run another CLI now; its keys and readiness follow the agent.
          row.agent = target.agent;
          row.deliveryMode = normalizeMode(target.agent, row.deliveryMode);
          row.stranded = undefined;
        }
        row.state = "queued";
        row.error = undefined;
        row.sendNow = action === "send";
        row.revision++;
      }
      return { ...row };
    });
    this.forget(row.id);
    this.notify(row);
  }
  /** Record what the CLI's own queue did with a row; a paused row the journal confirms becomes sent. */
  async confirm(id: string, native: NativeQueueState) {
    const row = await this.mutate(() => {
      const row = this.rows.find((item) => item.id === id);
      if (!row || row.native === native || (row.state !== "sent" && row.state !== "paused")) return null;
      if (row.state === "paused") {
        row.state = "sent";
        row.sentAt = this.now();
        row.error = undefined;
      }
      row.native = native;
      row.revision++;
      return { ...row };
    });
    if (row) this.notify(row);
  }
  /** Rows the journal may still say something about: delivered recently, or paused after a claim. */
  async unconfirmed() {
    await this.ready;
    await this.serial;
    const since = this.now() - RECENT_MS;
    return this.rows
      .filter(
        (row) =>
          (row.state === "sent" && (row.sentAt ?? 0) > since && row.native !== "absorbed" && row.native !== "recalled") ||
          (row.state === "paused" && row.claimedAt !== undefined && row.claimedAt > since),
      )
      .map((row) => ({ ...row }));
  }
  /** Every scope delivers on its own worker; a tick during a pass makes that worker run once more. */
  async tick<T>(
    assess: (row: QueuedMessage) => Promise<Verdict<T>>,
    deliver: (row: QueuedMessage, ready: T) => Promise<QueueOutcome>,
    options: TickOptions = {},
  ) {
    await this.ready;
    await this.serial;
    const scopes = new Set(this.rows.filter((row) => row.state !== "sent").map((row) => row.scope));
    const passes: Promise<void>[] = [];
    for (const scope of scopes) {
      const running = this.workers.get(scope);
      if (running) {
        running.again = true;
        // A forced kick that lands mid-pass must not inherit that pass's backoff.
        running.force ||= !!options.force;
        passes.push(running.done);
        continue;
      }
      const worker = { again: true, force: !!options.force, done: Promise.resolve() };
      worker.done = (async () => {
        try {
          while (worker.again) {
            worker.again = false;
            const force = worker.force;
            worker.force = false;
            if (await this.pass(scope, assess, deliver, { ...options, force })) worker.again = true;
          }
        } finally {
          this.workers.delete(scope);
        }
      })();
      this.workers.set(scope, worker);
      passes.push(worker.done);
    }
    await Promise.all(passes);
  }
  /** Look at a scope's next row once. True when it was delivered and the next one may go now. */
  private async pass<T>(
    scope: string,
    assess: (row: QueuedMessage) => Promise<Verdict<T>>,
    deliver: (row: QueuedMessage, ready: T) => Promise<QueueOutcome>,
    { force = false, exclusive = (_row, operation) => operation().then((value) => ({ busy: false as const, value })) }: TickOptions,
  ): Promise<boolean> {
    const candidates = this.rows.filter((row) => row.scope === scope && row.state !== "sent");
    const head = candidates.find((row) => row.sendNow) ?? candidates[0];
    if (!head || head.state !== "queued") return false;
    const now = this.now();
    if (head.stranded && head.stranded.since < now - STRANDED_TTL_MS) {
      const expired = candidates.filter((row) => row.stranded && row.stranded.since < now - STRANDED_TTL_MS);
      await this.mutate(() => {
        this.rows = this.rows.filter((item) => !expired.includes(item));
      });
      for (const row of expired) {
        this.forget(row.id);
        this.notify(row);
      }
      return false;
    }
    const due = this.backoff.get(head.id);
    if (!force && due && due.at > now) return false;
    let verdict: Verdict<T>;
    try {
      verdict = await assess(head);
    } catch {
      verdict = { wait: "disconnected" };
    }
    if ("stranded" in verdict) {
      this.backoff.set(head.id, { at: this.now() + STRANDED_RECHECK_MS, step: 0 });
      if (head.stranded) return false;
      // A pane or conversation that went away takes the whole scope with it, not just its head.
      const stranded = { reason: verdict.stranded, since: this.now() };
      await this.settleScope(scope, (row) => !row.stranded, (row) => {
        row.stranded = { ...stranded };
      });
      return false;
    }
    if (head.stranded) {
      // Its conversation is back: the rows wait in it again.
      await this.settleScope(scope, (row) => !!row.stranded, (row) => {
        row.stranded = undefined;
      });
      return true;
    }
    if ("wait" in verdict) {
      const step = Math.min((due?.step ?? -1) + 1, BACKOFF_MS.length - 1);
      this.backoff.set(head.id, { at: this.now() + BACKOFF_MS[step]!, step });
      if (this.waiting.get(head.id) !== verdict.wait) {
        this.waiting.set(head.id, verdict.wait);
        this.notify(head);
      }
      return false;
    }
    const run = await exclusive(head, async () => {
      const claimed = await this.mutate(() => {
        const row = this.rows.find((item) => item.id === head.id);
        if (!row || row.state !== "queued" || row.revision !== head.revision) return null;
        row.state = "sending";
        row.claimedAt = this.now();
        row.revision++;
        return { ...row };
      });
      if (!claimed) return false;
      this.forget(claimed.id);
      this.notify(claimed);
      let outcome: QueueOutcome;
      try {
        outcome = await deliver(claimed, verdict.ready);
      } catch {
        outcome = {
          status: "uncertain",
          error: "Delivery could not be confirmed. Check Terminal before retrying.",
        };
      }
      await this.settle(claimed, (row) => {
        row.state = outcome.status === "sent" ? "sent" : outcome.status === "blocked" ? "queued" : "paused";
        if (outcome.status === "sent") row.sentAt = this.now();
        if (outcome.native) row.native = outcome.native;
        row.error = outcome.error;
      });
      if (outcome.status === "blocked") this.backoff.set(claimed.id, { at: this.now() + BACKOFF_MS[0]!, step: 0 });
      return outcome.status === "sent";
    });
    return !run.busy && run.value;
  }
  private async settle(target: QueuedMessage, apply: (row: QueuedMessage) => void) {
    const row = await this.mutate(() => {
      const row = this.rows.find((item) => item.id === target.id);
      if (!row) return null;
      apply(row);
      row.revision++;
      return { ...row };
    });
    if (row) this.notify(row);
  }
  /** Apply `apply` to every unsent row of `scope` that passes `test`, in one write. */
  private async settleScope(scope: string, test: (row: QueuedMessage) => boolean, apply: (row: QueuedMessage) => void) {
    const rows = await this.mutate(() =>
      this.rows
        .filter((row) => row.scope === scope && row.state !== "sent" && test(row))
        .map((row) => {
          apply(row);
          row.revision++;
          return { ...row };
        }),
    );
    for (const row of rows) this.notify(row);
  }
  private forget(id: string) {
    this.waiting.delete(id);
    this.backoff.delete(id);
  }
}
function strandedOn(row: QueuedMessage, pane: { session: string; paneId: string }) {
  return !!row.stranded && row.state !== "sent" && row.session === pane.session && row.paneId === pane.paneId;
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
