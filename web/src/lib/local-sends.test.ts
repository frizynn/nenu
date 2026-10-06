import { act, renderHook } from "@testing-library/react";
import {
  SENT_TTL_MS, addLocalSend, listLocalSends, localImageUrl, localSendScope, reconcileLocalSends,
  rememberLocalImage, updateLocalSend, useLocalSends,
} from "./local-sends";
import type { TranscriptEntry } from "./types";

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
