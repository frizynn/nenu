import { act, renderHook } from "@testing-library/react";
import {
  SENT_TTL_MS, addLocalSend, listLocalSends, localImageUrl, localSendScope, pendingSends, reconcileLocalSends,
  rememberLocalImage, removeLocalSend, resetLocalSends, updateLocalSend, useLocalSends,
} from "./local-sends";
import { isWorkHeld } from "./reload-guard";
import type { LocalSend } from "./local-sends";
import type { TranscriptEntry } from "./types";
import { pendingStatus } from "@/components/pending-turns";

const scope = localSendScope("w1:p1", undefined);
const user = (uuid: string, text: string): TranscriptEntry => ({ uuid, ts: "2026-10-06T10:00:00Z", role: "user", parts: [{ kind: "text", text }] });

describe("local sends", () => {
  it("draws a bubble until the journal gains a NEW matching user turn", () => {
    const earlier = [user("u1", "continue")];
    addLocalSend(scope, "continue");
    reconcileLocalSends(scope, earlier); // the old "continue" is baseline, not this send
    expect(pendingSends(listLocalSends(scope), earlier)).toHaveLength(1);
    const other = [...earlier, user("u2", "something else")];
    reconcileLocalSends(scope, other);
    expect(pendingSends(listLocalSends(scope), other)).toHaveLength(1);
    const landed = [...earlier, user("u3", "  continue ")];
    // The render that draws the journal's turn no longer draws the bubble, before any effect runs.
    expect(pendingSends(listLocalSends(scope), landed)).toHaveLength(0);
    reconcileLocalSends(scope, landed);
    expect(listLocalSends(scope)).toEqual([expect.objectContaining({ landed: "u3" })]);
    expect(pendingSends(listLocalSends(scope), earlier)).toHaveLength(0);
  });

  it("keeps a landed bubble's queue row claimed for a while, then forgets it", () => {
    vi.useFakeTimers();
    try {
      const id = addLocalSend(scope, "queued words");
      updateLocalSend(scope, id, { state: "queued", queueId: "row-1", native: "enqueued" });
      reconcileLocalSends(scope, []);
      reconcileLocalSends(scope, [user("u9", "queued words")]);
      // The queue still reports the row in Claude's queue: it stays this bubble's, so it is not drawn alone.
      updateLocalSend(scope, id, { native: "enqueued" });
      expect(listLocalSends(scope)).toEqual([expect.objectContaining({ queueId: "row-1", landed: "u9" })]);
      vi.advanceTimersByTime(SENT_TTL_MS);
      expect(listLocalSends(scope)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reuses a failed bubble when the same message is retried", () => {
    const id = addLocalSend(scope, "retry me");
    updateLocalSend(scope, id, { state: "failed", error: "nope" });
    expect(addLocalSend(scope, "retry me")).toBe(id);
    expect(listLocalSends(scope)).toEqual([expect.objectContaining({ id, state: "sending", error: undefined })]);
  });

  it("drops a delivered bubble the journal never shows, after a grace period", () => {
    vi.useFakeTimers();
    try {
      const id = addLocalSend(scope, "lost in translation");
      updateLocalSend(scope, id, { state: "sent" });
      vi.advanceTimersByTime(SENT_TTL_MS - 1);
      expect(listLocalSends(scope)).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(listLocalSends(scope)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("notifies subscribers per pane", () => {
    const { result } = renderHook(() => useLocalSends(scope));
    act(() => { addLocalSend(scope, "hello"); addLocalSend(localSendScope("w2:p1", undefined), "elsewhere"); });
    expect(result.current.map((send) => send.text)).toEqual(["hello"]);
  });

  it("revokes the oldest local image once the cache is full", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    for (let i = 0; i < 33; i++) rememberLocalImage(`/u/${i}.png`, `blob:${i}`);
    expect(localImageUrl("/u/0.png")).toBeUndefined();
    expect(localImageUrl("/u/32.png")).toBe("blob:32");
    expect(revoke).toHaveBeenCalledWith("blob:0");
    revoke.mockRestore();
  });
});

describe("what a pending bubble says", () => {
  const send = (patch: Partial<LocalSend>): LocalSend => ({ id: "b", text: "hi", state: "sending", ...patch });

  it("points a failure whose text may be typed at Terminal, with no Retry", () => {
    expect(pendingStatus(send({ state: "failed", error: "Check Terminal.", textDelivered: true }))).toEqual({ tone: "problem", label: "Check Terminal.", actions: ["openTerminal", "edit"] });
    expect(pendingStatus(send({ state: "failed", error: "nope" })).actions).toEqual(["retry", "edit"]);
  });

  it("marks a send to an agent Nenu cannot read back as not verified", () => {
    expect(pendingStatus(send({ state: "sent", unverified: true })).label).toBe("Sent, not verified");
    expect(pendingStatus(send({ state: "sent" })).label).toBe("Sent");
  });

  it("follows its queue row: waiting per mode, then the CLI's own queue, then read", () => {
    const queued = send({ state: "queued", queueId: "q", agent: "claude", queueState: "queued", deliveryMode: "afterTurn", waitingFor: "working" });
    expect(pendingStatus(queued)).toMatchObject({ label: "Waiting for Claude to finish this turn.", actions: ["sendNow", "edit", "remove"] });
    expect(pendingStatus({ ...queued, native: "enqueued", queueState: undefined })).toMatchObject({ label: expect.stringMatching(/^In Claude's queue/), actions: ["readNow", "edit", "remove"] });
    expect(pendingStatus({ ...queued, state: "sent", native: "absorbed" })).toMatchObject({ tone: "done", label: "Read by Claude" });
  });
});

it("a retried bubble forgets that its earlier try may have been typed", () => {
  const id = addLocalSend(scope, "again");
  updateLocalSend(scope, id, { state: "failed", textDelivered: true });
  addLocalSend(scope, "again");
  expect(listLocalSends(scope)).toEqual([expect.objectContaining({ id, state: "sending", textDelivered: undefined })]);
});

describe("a message without its answer is unsent work", () => {
  beforeEach(() => resetLocalSends());
  afterEach(() => resetLocalSends());

  it("holds an update while it is on its way, and while a failure keeps its text only on the bubble", () => {
    const id = addLocalSend(scope, "on its way");
    expect(isWorkHeld()).toBe(true);
    updateLocalSend(scope, id, { state: "sent" });
    expect(isWorkHeld()).toBe(false);
    const failed = addLocalSend(scope, "lost answer");
    updateLocalSend(scope, failed, { state: "failed", error: "Not sent" });
    expect(isWorkHeld()).toBe(true);
    removeLocalSend(scope, failed);
    expect(isWorkHeld()).toBe(false);
  });

  it("does not hold for a message queued on the bridge or one already in the terminal", () => {
    addLocalSend(scope, "queued", "queued");
    const typed = addLocalSend(scope, "typed");
    updateLocalSend(scope, typed, { state: "failed", textDelivered: true });
    expect(isWorkHeld()).toBe(false);
  });
});
