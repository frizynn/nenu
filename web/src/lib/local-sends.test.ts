import { act, renderHook } from "@testing-library/react";
import {
  SENT_TTL_MS, addLocalSend, listLocalSends, localImageUrl, localSendScope, pendingSends, reconcileLocalSends, takenBack,
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

  // 2026-10-22: Nenu typed a message into a box that still held earlier text, Claude got both as one
  // turn, and the failed bubble sat under every newer turn for good, so the chat's end never moved.
  const leftover = "Se cortó por el límite de la cuenta y ya cambió. Continuá desde donde quedaste.";
  const failedInPane = (text: string) => {
    const id = addLocalSend(scope, text);
    updateLocalSend(scope, id, { state: "failed", error: "Your message didn't show in the agent's input box, so nothing was sent.", textDelivered: true });
    return id;
  };

  it("lands a failure whose text may be in the pane on a new turn that holds it joined to other text", () => {
    const sent = "Haceme una foto diagrama con el fondo negro y una grilla cuadriculada";
    const id = failedInPane(sent);
    const before = [user("u1", leftover)];
    reconcileLocalSends(scope, before);
    expect(pendingSends(listLocalSends(scope), before)).toHaveLength(1);
    const joined = [...before, user("u2", `${sent}${leftover}`)];
    expect(pendingSends(listLocalSends(scope), joined)).toHaveLength(0);
    reconcileLocalSends(scope, joined);
    expect(listLocalSends(scope)).toEqual([expect.objectContaining({ id, landed: "u2" })]);
  });

  it("lands a short one too, wherever the caret was in the box", () => {
    const id = failedInPane("dale, seguí");
    reconcileLocalSends(scope, []);
    reconcileLocalSends(scope, [user("u1", `Se cortó por eldale, seguí límite de la cuenta.`)]);
    expect(listLocalSends(scope)).toEqual([expect.objectContaining({ id, landed: "u1" })]);
  });

  it("never lands one on a turn that was already there", () => {
    failedInPane("dale, seguí");
    const earlier = [user("u1", "dale, seguí con el PR")];
    reconcileLocalSends(scope, earlier);
    reconcileLocalSends(scope, earlier);
    expect(pendingSends(listLocalSends(scope), earlier)).toHaveLength(1);
  });

  it("needs the whole turn for any other bubble: one never typed keeps its words", () => {
    const id = addLocalSend(scope, "Revisá el PR https://github.com/frizynn/nenu/pull/25");
    updateLocalSend(scope, id, { state: "failed", error: "Not sent" });
    reconcileLocalSends(scope, []);
    const later = [user("u1", "Revisá el PR https://github.com/frizynn/nenu/pull/251 y mergealo")];
    reconcileLocalSends(scope, later);
    expect(pendingSends(listLocalSends(scope), later)).toHaveLength(1);
    addLocalSend(scope, "ok");
    reconcileLocalSends(scope, later);
    const okay = [...later, user("u2", "okay, now the next file")];
    reconcileLocalSends(scope, okay);
    expect(pendingSends(listLocalSends(scope), okay)).toHaveLength(2);
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
    expect(pendingStatus({ ...queued, native: "enqueued", queueState: undefined })).toMatchObject({ label: "Claude reads it after this step.", actions: ["readNow", "edit", "remove"] });
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

describe("what a take-back puts in the composer", () => {
  const messages = [{ id: "a", text: "primero" }, { id: "b", text: "segundo\ncon dos líneas" }];

  it("puts back the rows' own words, line breaks kept, when the box held only them", () => {
    expect(takenBack({ text: "primero segundo con dos líneas", messages, ours: true })).toEqual({ text: "primero\n\nsegundo\ncon dos líneas" });
  });

  it("leaves out the removed one and says the others are back", () => {
    expect(takenBack({ text: "", messages, ours: true }, "a")).toEqual({ text: "segundo\ncon dos líneas", note: expect.stringMatching(/^Removed/) });
    expect(takenBack({ text: "", messages: [messages[0]!], ours: true }, "a")).toEqual({ text: "" });
  });

  it("puts back the box as the screen showed it, and says so, when it held more than Nenu sent", () => {
    expect(takenBack({ text: "primero y algo tecleado", messages: [messages[0]!], ours: false }, "a"))
      .toEqual({ text: "primero y algo tecleado", note: expect.stringMatching(/held more than Nenu sent/) });
  });
});
