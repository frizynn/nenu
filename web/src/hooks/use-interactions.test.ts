import { act, renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { useInteractions } from "./use-interactions";
import type { Interaction } from "@/lib/types";

const card: Interaction = {
  paneId: "w1:p1", agent: "claude", kind: "question", family: "select", question: "Which fruit?", signature: "sig-1",
  revision: 1, detectedAt: 0, options: [{ index: 0, label: "Apple", role: "neutral" }, { index: 1, label: "Pear", role: "neutral" }],
};

describe("useInteractions", () => {
  it("hides an answered dialog behind its receipt even when a read still returns it", async () => {
    server.use(http.get("/api/interactions", () => HttpResponse.json({ interactions: [card] })));
    const { result } = renderHook(() => useInteractions());
    await waitFor(() => expect(result.current.interactions).toHaveLength(1));
    await act(async () => { await result.current.answer(card, card.options[0]!); });
    expect(result.current.interactions).toEqual([]);
    expect(result.current.receipts).toMatchObject([{ paneId: "w1:p1", label: "Apple" }]);
  });

  it("leaves a multi-select toggle without a receipt", async () => {
    const multi: Interaction = { ...card, kind: "multi-select", options: [{ index: 0, label: "Cheese", role: "neutral", checked: false }] };
    server.use(http.get("/api/interactions", () => HttpResponse.json({ interactions: [multi] })));
    const { result } = renderHook(() => useInteractions());
    await waitFor(() => expect(result.current.interactions).toHaveLength(1));
    await act(async () => { await result.current.answer(multi, multi.options[0]!); });
    expect(result.current.receipts).toEqual([]);
  });

  it("reports a 409 refusal as the bridge's outcome", async () => {
    server.use(http.post(/\/api\/interactions\/[^/]+\/answer$/, () =>
      HttpResponse.json({ ok: false, error: "The dialog changed.", code: "interaction_changed" }, { status: 409 })));
    const { result } = renderHook(() => useInteractions());
    let outcome;
    await act(async () => { outcome = await result.current.answer(card, card.options[0]!); });
    expect(outcome).toEqual({ ok: false, error: "The dialog changed.", code: "interaction_changed" });
    expect(result.current.receipts).toEqual([]);
  });
});
