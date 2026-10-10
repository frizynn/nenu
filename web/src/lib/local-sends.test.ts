import { act, renderHook } from "@testing-library/react";
import {
  SENT_TTL_MS, addLocalSend, listLocalSends, localImageUrl, localSendScope, reconcileLocalSends,
  rememberLocalImage, updateLocalSend, useLocalSends,
} from "./local-sends";
import type { LocalSend } from "./local-sends";
import type { TranscriptEntry } from "./types";
import { pendingStatus } from "@/components/pending-turns";

const scope = localSendScope("w1:p1", undefined);
const user = (uuid: string, text: string): TranscriptEntry => ({ uuid, ts: "2026-10-06T10:00:00Z", role: "user", parts: [{ kind: "text", text }] });

describe("local sends", () => {
  it("keeps a bubble until the journal gains a NEW matching user turn", () => {
    const earlier = [user("u1", "continue")];
    addLocalSend(scope, "continue");
    reconcileLocalSends(scope, earlier); // the old "continue" is baseline, not this send
    expect(listLocalSends(scope)).toHaveLength(1);
    reconcileLocalSends(scope, [...earlier, user("u2", "something else")]);
    expect(listLocalSends(scope)).toHaveLength(1);
    reconcileLocalSends(scope, [...earlier, user("u3", "  continue ")]);
    expect(listLocalSends(scope)).toHaveLength(0);
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
    expect(pendingStatus({ ...queued, native: "enqueued", queueState: undefined })).toMatchObject({ label: expect.stringMatching(/^In Claude's queue/), actions: ["readNow"] });
    expect(pendingStatus({ ...queued, state: "sent", native: "absorbed" })).toMatchObject({ tone: "done", label: "Read by Claude" });
  });
});

it("a retried bubble forgets that its earlier try may have been typed", () => {
  const id = addLocalSend(scope, "again");
  updateLocalSend(scope, id, { state: "failed", textDelivered: true });
  addLocalSend(scope, "again");
  expect(listLocalSends(scope)).toEqual([expect.objectContaining({ id, state: "sending", textDelivered: undefined })]);
});
