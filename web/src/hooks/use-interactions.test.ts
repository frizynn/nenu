import { act, renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import type { Interaction } from "@/lib/types";
import { receiptSummary, useInteractions } from "./use-interactions";

const card: Interaction = {
  paneId: "w1:p1", agent: "claude", kind: "question", family: "select", question: "Which fruit?", signature: "sig-1",
  revision: 1, detectedAt: 0, options: [{ index: 0, label: "Apple", role: "neutral" }, { index: 1, label: "Pear", role: "neutral" }],
};

describe("receiptSummary", () => {
  const ask = (over: Partial<Interaction>): Interaction => ({ ...card, kind: "permission", family: "permission", question: "Do you want to proceed?", ...over });
  const yes = { index: 0, label: "Yes", role: "primary" } as const;

  // Shapes the bridge serves for the fixture corpus: claude--trust-prompt, codex--v0156-trust,
  // agy--permission-edit, agy--permission-bash and grok--permission-rm.
  it.each([
    ["a folder's trust names the answer, never the prompt's last line", ask({ family: "trust", context: "Accessing workspace:\n/tmp/project\nClaude Code'll be able to read, edit, and execute files here.\nSecurity guide" }), { index: 0, label: "Yes, I trust this folder", role: "persistent" as const }, "Approved · Yes, I trust this folder"],
    ["Codex's trust likewise", ask({ family: "trust", context: "can run code automatically. Your trust\ndecision will be saved." }), { index: 0, label: "Trust and continue", role: "persistent" as const }, "Approved · Trust and continue"],
    ["a declined trust", ask({ family: "trust", context: "Accessing workspace:\n/tmp/project\nSecurity guide" }), { index: 1, label: "No, exit", role: "deny" as const }, "Declined · No, exit"],
    ["a command the screen folded names the answer, not its fold", ask({ context: "Requesting permission for:\ncat << 'EOF' > test_logger.py\nimport unittest\n⋯ (25 lines hidden)" }), yes, "Approved · Yes"],
    ["a request in several plain rows names the answer", ask({ context: "Requesting permission for:\nls -la /tmp" }), yes, "Approved · Yes"],
    ["a request that is one plain row is the command", ask({ context: "rm hello.txt" }), yes, "Approved · rm hello.txt"],
    ["a command in parts", ask({ subject: { tool: "Bash", command: "echo hi > hello.txt" }, context: "Bash\necho hi > hello.txt" }), yes, "Approved · echo hi > hello.txt"],
    ["a file in parts", ask({ subject: { tool: "Create file", file: "hello.txt", preview: "1 hello" } }), yes, "Approved · hello.txt"],
  ])("%s", (_, interaction, option, summary) => {
    expect(receiptSummary(interaction, option)).toBe(summary);
  });
});

describe("useInteractions", () => {
  it("hides an answered dialog behind its receipt even when a read still returns it", async () => {
    server.use(http.get("/api/interactions", () => HttpResponse.json({ interactions: [card] })));
    const { result } = renderHook(() => useInteractions());
    await waitFor(() => expect(result.current.interactions).toHaveLength(1));
    await act(async () => { await result.current.answer(card, card.options[0]!); });
    expect(result.current.interactions).toEqual([]);
    expect(result.current.receipts).toMatchObject([{ paneId: "w1:p1", label: "Apple" }]);
  });

  // Home mounts again on the back control from a chat: it draws the dialog it last read while it reads
  // again, never a placeholder that turns into the question as the page slides in.
  it("starts from the dialogs last read for the session when it mounts again", async () => {
    server.use(http.get("/api/interactions", () => HttpResponse.json({ interactions: [card] })));
    const first = renderHook(() => useInteractions("work"));
    await waitFor(() => expect(first.result.current.interactions).toHaveLength(1));
    first.unmount();
    server.use(http.get("/api/interactions", () => new Promise(() => {})));
    const again = renderHook(() => useInteractions("work"));
    expect(again.result.current.interactions).toEqual([card]);
    expect(again.result.current.loaded).toBe(true);
    const other = renderHook(() => useInteractions("other"));
    expect(other.result.current.interactions).toEqual([]);
    expect(other.result.current.loaded).toBe(false);
  });

  it("names what an answer did in its receipt: the command approved, the answer chosen", async () => {
    const bash: Interaction = {
      ...card, kind: "permission", family: "permission", question: "Do you want to proceed?",
      subject: { tool: "Bash", command: "echo hi > hello.txt" },
      options: [{ index: 0, label: "Yes", role: "primary" }, { index: 1, label: "No", role: "deny" }],
    };
    server.use(http.get("/api/interactions", () => HttpResponse.json({ interactions: [bash, { ...card, paneId: "w1:p2" }] })));
    const { result } = renderHook(() => useInteractions());
    await waitFor(() => expect(result.current.interactions).toHaveLength(2));
    await act(async () => { await result.current.answer(bash, bash.options[0]!); });
    await act(async () => { await result.current.answer({ ...card, paneId: "w1:p2" }, { index: 0, label: "Apple (Recommended)", role: "neutral" }); });
    expect(result.current.receipts.map((r) => r.summary)).toEqual(["Approved · echo hi > hello.txt", "Answered · Apple"]);
  });

  it("leaves a wizard's Back and Next without a receipt: the dialog is still there", async () => {
    const wizard: Interaction = { ...card, kind: "wizard", options: [...card.options, { index: 2, label: "Next", role: "nav" }] };
    server.use(http.get("/api/interactions", () => HttpResponse.json({ interactions: [wizard] })));
    const { result } = renderHook(() => useInteractions());
    await waitFor(() => expect(result.current.interactions).toHaveLength(1));
    await act(async () => { await result.current.answer(wizard, wizard.options[2]!); });
    expect(result.current.receipts).toEqual([]);
  });

  it("leaves a multi-select toggle without a receipt", async () => {
    const multi: Interaction = { ...card, kind: "multi-select", options: [{ index: 0, label: "Cheese", role: "neutral", checked: false }] };
    server.use(http.get("/api/interactions", () => HttpResponse.json({ interactions: [multi] })));
    const { result } = renderHook(() => useInteractions());
    await waitFor(() => expect(result.current.interactions).toHaveLength(1));
    await act(async () => { await result.current.answer(multi, multi.options[0]!); });
    expect(result.current.receipts).toEqual([]);
  });

  // The thread draws the card from this object; a fresh copy on every poll re-renders the conversation.
  it("keeps the same dialog object across reads that say the same thing", async () => {
    server.use(http.get("/api/interactions", () => HttpResponse.json({ interactions: [card] })));
    const { result } = renderHook(() => useInteractions());
    await waitFor(() => expect(result.current.interactions).toHaveLength(1));
    const first = result.current.interactions[0];
    let reads = 0;
    server.use(http.get("/api/interactions", () => { reads++; return HttpResponse.json({ interactions: [{ ...card }] }); }));
    act(() => result.current.refresh());
    await waitFor(() => expect(reads).toBeGreaterThan(0));
    await waitFor(() => expect(result.current.interactions[0]).toBe(first));
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

  it("carries a tap refused because the question changed to the pane's next dialog, and only that one", async () => {
    const error = "The question changed in the terminal. Nothing was sent.";
    let shown = [card];
    server.use(
      http.get("/api/interactions", () => HttpResponse.json({ interactions: shown })),
      http.post(/\/api\/interactions\/[^/]+\/answer$/, () => HttpResponse.json({ ok: false, error, code: "interaction_changed" }, { status: 409 })),
    );
    const { result } = renderHook(() => useInteractions());
    await waitFor(() => expect(result.current.interactions).toHaveLength(1));
    const next = { ...card, signature: "sig-2", question: "Which colour?" };
    shown = [next];
    await act(async () => { await result.current.answer(card, card.options[0]!); });
    await waitFor(() => expect(result.current.interactions[0]?.signature).toBe("sig-2"));
    expect(result.current.refusalFor(result.current.interactions[0]!)).toBe(error);
    // The dialog after that one never inherits it.
    shown = [{ ...card, signature: "sig-3" }];
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.interactions[0]?.signature).toBe("sig-3"));
    expect(result.current.refusalFor(result.current.interactions[0]!)).toBeUndefined();
  });
});
