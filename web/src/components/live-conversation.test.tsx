import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { fixtureTranscript } from "@/test/handlers";
import type { PaneHistoryResponse, TranscriptEntry } from "@/lib/types";
import { LiveConversation } from "./live-conversation";
import { fetchHistory } from "@/lib/api";
import { TranscriptView } from "./transcript-view";
import { addLocalSend, localSendScope, updateLocalSend } from "@/lib/local-sends";
import { ConnectConversation } from "./connect-conversation";

vi.mock("@/lib/api", () => ({ fetchHistory: vi.fn() }));
vi.mock("react-router", async (original) => ({ ...await original<typeof import("react-router")>(), useRevalidator: () => ({ revalidate: async () => {}, state: "idle" }) }));
vi.mock("@/components/transcript-view", async (original) => {
  const actual = await original<typeof import("./transcript-view")>();
  return { ...actual, TranscriptView: vi.fn(actual.TranscriptView) };
});
beforeEach(() => { vi.mocked(TranscriptView).mockClear(); });
beforeEach(() => { vi.mocked(fetchHistory).mockReset(); });

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = vi.fn();
});

describe("LiveConversation", () => {
  it("renders the existing transcript and offers older turns without leaving the live pane", () => {
    render(<MemoryRouter><LiveConversation paneId="w1:p1" session="work" history={{ paneId: "w1:p1", available: true, entries: fixtureTranscript, hasMore: true, total: 100, fileTruncated: false }} loading={false} error={false} /></MemoryRouter>);
    expect(screen.getByText("what changed today?")).toBeInTheDocument();
    expect(screen.getByText("One commit: abc1234.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load older messages" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Open full history/ })).not.toBeInTheDocument();
    expect(screen.queryByText("abc1234 fix")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Ran git log/ }));
    expect(screen.getByText("abc1234 fix")).toBeInTheDocument();
  });

  it("preserves the reading window and draft when work is expanded during live updates", () => {
    const initial: PaneHistoryResponse = { paneId: "w1:p1", available: true, entries: fixtureTranscript, hasMore: false, total: 2, fileTruncated: false };
    const view = (history: PaneHistoryResponse) => <><LiveConversation paneId="w1:p1" history={history} loading={false} error={false} /><textarea aria-label="Draft" defaultValue="Still writing" /></>;
    const { rerender } = render(view(initial));
    const draft = screen.getByRole("textbox", { name: "Draft" });
    fireEvent.click(screen.getByRole("button", { name: /^Ran git log/ }));
    rerender(view({ ...initial, entries: [{ uuid: "new", ts: "", role: "assistant", parts: [{ kind: "text", text: "New latest turn" }] }] }));
    expect(screen.getByText("abc1234 fix")).toBeInTheDocument();
    expect(screen.queryByText("New latest turn")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Draft" })).toBe(draft);
    expect(draft).toHaveValue("Still writing");
    fireEvent.click(screen.getByRole("button", { name: /^Scroll to latest/ }));
    expect(screen.getByText("New latest turn")).toBeInTheDocument();
  });

  it("keeps a last good transcript visible during a refresh failure and retries explicitly", () => {
    const retry = vi.fn();
    render(<MemoryRouter><LiveConversation paneId="w1:p1" history={{ paneId: "w1:p1", available: true, entries: fixtureTranscript, hasMore: false, total: 2, fileTruncated: false }} loading={false} error onRetry={retry} /></MemoryRouter>);
    expect(screen.getByText("what changed today?")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Showing the last update");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("describes an unavailable journal without inventing conversation content", () => {
    render(<MemoryRouter><LiveConversation paneId="w1:p1" history={{ paneId: "w1:p1", available: false, reason: "no-log" }} loading={false} error={false} /></MemoryRouter>);
    expect(screen.getByText("Waiting for the first conversation entry…")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("holds the reading window while scrolled up and resumes at the latest turn", () => {
    const initial: PaneHistoryResponse = { paneId: "w1:p1", available: true, entries: fixtureTranscript, hasMore: false, total: 2, fileTruncated: false };
    const view = (history: PaneHistoryResponse) => <MemoryRouter><LiveConversation paneId="w1:p1" history={history} loading={false} error={false} /></MemoryRouter>;
    const { container, rerender } = render(view(initial));
    const scroller = container.querySelector<HTMLElement>(".overflow-y-auto")!;
    const box = scrollBox(scroller, { height: 1000, client: 100 });
    act(() => { scroller.scrollTo({ top: box.height }); fireEvent.scroll(scroller); });
    box.top = 300;
    fireEvent.scroll(scroller);
    rerender(view({ ...initial, entries: [{ uuid: "new", ts: "", role: "assistant", parts: [{ kind: "text", text: "New latest turn" }] }] }));
    expect(screen.getByText("what changed today?")).toBeInTheDocument();
    expect(screen.queryByText("New latest turn")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Scroll to latest/ }));
    expect(screen.getByText("New latest turn")).toBeInTheDocument();
    expect(screen.queryByText("what changed today?")).not.toBeInTheDocument();
  });

  // Measured on the e2e bench with a real transcript: a new turn slid the 60-entry window (the list
  // shrank and the browser moved scrollTop up to the new bottom), then "Working…" arrived (+44 px)
  // before the scroll event that the first move queued was dispatched. That event read a gap of 44 px.
  it("keeps following when the list grows between a move and its scroll event", () => {
    const first: PaneHistoryResponse = { paneId: "w1:p1", available: true, entries: fixtureTranscript, hasMore: false, total: 2, fileTruncated: false };
    const asked: PaneHistoryResponse = { ...first, entries: [fixtureTranscript[1]!, { uuid: "t3", ts: "", role: "user", parts: [{ kind: "text", text: "and now?" }] }] };
    const view = (history: PaneHistoryResponse, activityStatus?: "working") => <MemoryRouter><LiveConversation paneId="w1:p1" history={history} activityStatus={activityStatus} loading={false} error={false} /></MemoryRouter>;
    const { container, rerender } = render(view(first));
    const scroller = container.querySelector<HTMLElement>(".overflow-y-auto")!;
    const box = scrollBox(scroller, { height: 1000, client: 100 });
    act(() => { scroller.scrollTo({ top: box.height }); fireEvent.scroll(scroller); });

    box.height = 820;
    rerender(view(asked));
    expect(box.top).toBe(720);
    box.height = 864;
    rerender(view(asked, "working"));
    fireEvent.scroll(scroller);

    expect(screen.queryByRole("button", { name: /^Scroll to latest/ })).not.toBeInTheDocument();
    expect(screen.getByText("Working…")).toBeInTheDocument();
    expect(box.top).toBe(764);
    rerender(view({ ...asked, entries: [...asked.entries, { uuid: "t4", ts: "", role: "assistant", parts: [{ kind: "text", text: "Looking." }] }] }, "working"));
    expect(screen.getByText("Looking.")).toBeInTheDocument();
  });

  // A question taller than the thread on a phone (measured: 579 px card, 48 px of thread left when
  // it sat outside the scroller). Following lands on its first line, never past it.
  it("follows to the top of a tall question at the tail and leaves the reader inside it", () => {
    const history: PaneHistoryResponse = { paneId: "w1:p1", available: true, entries: fixtureTranscript, hasMore: false, total: 2, fileTruncated: false };
    const question = <section data-follow-stop aria-label="Which fruit?">Which fruit?</section>;
    const view = (h: PaneHistoryResponse, footer?: ReactNode, waiting = false) => <MemoryRouter><LiveConversation paneId="w1:p1" history={h} loading={false} error={false} footer={footer} waiting={waiting} /></MemoryRouter>;
    const { container, rerender } = render(view(history));
    const scroller = container.querySelector<HTMLElement>(".overflow-y-auto")!;
    const box = scrollBox(scroller, { height: 1000, client: 400 });
    act(() => { scroller.scrollTo({ top: box.height }); fireEvent.scroll(scroller); });
    expect(box.top).toBe(600);
    // The card starts where the thread ended (1000) and is 700 px tall.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return { top: this.hasAttribute("data-follow-stop") ? 1000 - box.top : 0 } as DOMRect;
    });
    box.height = 1700;
    const more = (uuid: string) => ({ ...history, entries: [...history.entries, { uuid, ts: "", role: "assistant" as const, parts: [{ kind: "text" as const, text: uuid }] }] });
    rerender(view(more("asked"), question, true));
    expect(box.top).toBe(988);
    // Reading down through the options is not leaving the tail: a refresh does not pull the view back up.
    box.top = 1200;
    fireEvent.scroll(scroller);
    rerender(view(more("refreshed"), question, true));
    expect(box.top).toBe(1200);
    // Scrolled away, the way back names the question and lands on its first line.
    box.top = 300;
    fireEvent.scroll(scroller);
    const back = screen.getByRole("button", { name: /^Scroll to latest/ });
    expect(back).toHaveTextContent("Waiting on you");
    fireEvent.click(back);
    expect(box.top).toBe(988);
    vi.restoreAllMocks();
  });

  // The phone keyboard shrinks the list while the operator types a reply on the card: the box they
  // type in sits at the card's foot, so following goes to the bottom, not the question's first line.
  it("follows to the bottom while the operator types inside the question", () => {
    const history: PaneHistoryResponse = { paneId: "w1:p1", available: true, entries: fixtureTranscript, hasMore: false, total: 2, fileTruncated: false };
    const question = <section data-follow-stop aria-label="Which plan?"><textarea aria-label="Reply" /></section>;
    const view = (h: PaneHistoryResponse) => <MemoryRouter><LiveConversation paneId="w1:p1" history={h} loading={false} error={false} footer={question} /></MemoryRouter>;
    const { container, rerender } = render(view(history));
    const scroller = container.querySelector<HTMLElement>(".overflow-y-auto")!;
    const box = scrollBox(scroller, { height: 1700, client: 400 });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return { top: this.hasAttribute("data-follow-stop") ? 1000 - box.top : 0 } as DOMRect;
    });
    act(() => { screen.getByRole("textbox", { name: "Reply" }).focus(); });
    box.client = 250;
    rerender(view({ ...history, entries: [...history.entries, { uuid: "more", ts: "", role: "assistant", parts: [{ kind: "text", text: "more" }] }] }));
    expect(box.top).toBe(1450);
    vi.restoreAllMocks();
  });

  // Review of the first cut: scrolling up inside a tall question paused following, and the pill then
  // sat over the answers and a tap on it moved nothing.
  it("counts reading inside a tall question as the tail and re-lands on its first line when content above shrinks", () => {
    const history: PaneHistoryResponse = { paneId: "w1:p1", available: true, entries: fixtureTranscript, hasMore: false, total: 2, fileTruncated: false };
    const question = <section data-follow-stop aria-label="Which plan?"><button type="button">Yes</button></section>;
    const view = (h: PaneHistoryResponse) => <MemoryRouter><LiveConversation paneId="w1:p1" history={h} loading={false} error={false} footer={question} waiting /></MemoryRouter>;
    const more = (uuid: string) => ({ ...history, entries: [...history.entries, { uuid, ts: "", role: "assistant" as const, parts: [{ kind: "text" as const, text: uuid }] }] });
    const { container, rerender } = render(view(history));
    const scroller = container.querySelector<HTMLElement>(".overflow-y-auto")!;
    const box = scrollBox(scroller, { height: 1700, client: 400 });
    let stopAt = 1000;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return { top: this.hasAttribute("data-follow-stop") ? stopAt - box.top : 0 } as DOMRect;
    });
    rerender(view(more("asked")));
    expect(box.top).toBe(988);
    // "Working…" leaves above the card: the card's first line moves up 44 px and the view follows it.
    stopAt = 956;
    box.height = 1656;
    rerender(view(more("settled")));
    expect(box.top).toBe(944);
    // A tapped answer keeps focus on desktop; that is not typing, so following keeps the first line.
    act(() => { screen.getByRole("button", { name: "Yes" }).focus(); });
    rerender(view(more("focused")));
    expect(box.top).toBe(944);
    // Up and down inside the question is still the tail: no pill over the answers.
    box.top = 1150;
    fireEvent.scroll(scroller);
    box.top = 1000;
    fireEvent.scroll(scroller);
    expect(screen.queryByRole("button", { name: /^Scroll to latest/ })).not.toBeInTheDocument();
    // Above the question the reader has left; the way back lands on its first line.
    box.top = 500;
    fireEvent.scroll(scroller);
    fireEvent.click(screen.getByRole("button", { name: /^Scroll to latest/ }));
    expect(box.top).toBe(944);
    vi.restoreAllMocks();
  });

  // Measured on the e2e bench (T09): replacing an eight-line draft empties the composer for one
  // layout. The list grows, the browser clamps scrollTop 148 px up, and the composer grows back
  // before the frame, so no size changed and no ResizeObserver ran. The scroll event the clamp
  // queued then read as the reader leaving the tail, and attaching an image after that left 50 px.
  it("stays at the latest turn when an edit beside the list moves it for one layout", () => {
    const history: PaneHistoryResponse = { paneId: "w1:p1", available: true, entries: fixtureTranscript, hasMore: false, total: 2, fileTruncated: false };
    const { container } = render(<MemoryRouter><LiveConversation paneId="w1:p1" history={history} loading={false} error={false} /><textarea aria-label="Draft" /></MemoryRouter>);
    const scroller = container.querySelector<HTMLElement>(".overflow-y-auto")!;
    const box = scrollBox(scroller, { height: 3145, client: 439 });
    act(() => { scroller.scrollTo({ top: box.height }); fireEvent.scroll(scroller); });
    expect(box.top).toBe(2706);

    fireEvent.input(screen.getByRole("textbox", { name: "Draft" }), { target: { value: "Línea 1" } });
    box.client = 587;
    scroller.scrollTop = box.top;
    box.client = 439;
    fireEvent.scroll(scroller);

    expect(screen.queryByRole("button", { name: /^Scroll to latest/ })).not.toBeInTheDocument();
    expect(box.top).toBe(2706);
  });

  it("still lets the reader scroll away while a draft is being edited", () => {
    const history: PaneHistoryResponse = { paneId: "w1:p1", available: true, entries: fixtureTranscript, hasMore: false, total: 2, fileTruncated: false };
    const { container } = render(<MemoryRouter><LiveConversation paneId="w1:p1" history={history} loading={false} error={false} /><textarea aria-label="Draft" /></MemoryRouter>);
    const scroller = container.querySelector<HTMLElement>(".overflow-y-auto")!;
    const box = scrollBox(scroller, { height: 3145, client: 439 });
    act(() => { scroller.scrollTo({ top: box.height }); fireEvent.scroll(scroller); });

    fireEvent.input(screen.getByRole("textbox", { name: "Draft" }), { target: { value: "Línea 1" } });
    fireEvent.touchStart(scroller, { touches: [{ clientX: 100, clientY: 200 }] });
    box.top = 2400;
    fireEvent.scroll(scroller);

    expect(screen.getByRole("button", { name: /^Scroll to latest/ })).toBeInTheDocument();
    expect(box.top).toBe(2400);
  });

  // A screen reader or the browser's own find moves the list without touching it: long after an edit,
  // a move up is the reader's.
  it("lets a move up long after an edit leave the tail", () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(1000);
    const history: PaneHistoryResponse = { paneId: "w1:p1", available: true, entries: fixtureTranscript, hasMore: false, total: 2, fileTruncated: false };
    const { container } = render(<MemoryRouter><LiveConversation paneId="w1:p1" history={history} loading={false} error={false} /><textarea aria-label="Draft" /></MemoryRouter>);
    const scroller = container.querySelector<HTMLElement>(".overflow-y-auto")!;
    const box = scrollBox(scroller, { height: 3145, client: 439 });
    act(() => { scroller.scrollTo({ top: box.height }); fireEvent.scroll(scroller); });

    fireEvent.input(screen.getByRole("textbox", { name: "Draft" }), { target: { value: "Línea 1" } });
    now.mockReturnValue(3000);
    box.top = 2400;
    fireEvent.scroll(scroller);

    expect(screen.getByRole("button", { name: /^Scroll to latest/ })).toBeInTheDocument();
    now.mockRestore();
  });

  // T22: the two ways back looked the same. New messages say how many; tool calls are not messages.
  it("counts the messages that arrived while the reader was away", () => {
    const initial: PaneHistoryResponse = { paneId: "w1:p1", available: true, entries: fixtureTranscript, hasMore: false, total: 2, fileTruncated: false };
    const view = (history: PaneHistoryResponse) => <MemoryRouter><LiveConversation paneId="w1:p1" history={history} loading={false} error={false} /></MemoryRouter>;
    const { container, rerender } = render(view(initial));
    const scroller = container.querySelector<HTMLElement>(".overflow-y-auto")!;
    const box = scrollBox(scroller, { height: 1000, client: 100 });
    act(() => { scroller.scrollTo({ top: box.height }); fireEvent.scroll(scroller); });
    box.top = 300;
    fireEvent.scroll(scroller);
    expect(screen.getByRole("button", { name: /^Scroll to latest/ })).not.toHaveTextContent(/\S/);

    rerender(view({ ...initial, entries: [...fixtureTranscript,
      { uuid: "n1", ts: "", role: "user", parts: [{ kind: "text", text: "Open the PR." }] },
      { uuid: "n2", ts: "", role: "assistant", parts: [{ kind: "tool", name: "Bash", summary: "gh pr create" }] },
      { uuid: "n3", ts: "", role: "assistant", parts: [{ kind: "text", text: "Opened." }] },
    ] }));
    expect(screen.getByRole("button", { name: /^Scroll to latest/ })).toHaveTextContent("2 new");
  });

  // T42: on a slow link the pane showed a spinner in its upper third until the history came back.
  it("draws the thread's shape while the first load is slow, then the turns", () => {
    const view = (history: PaneHistoryResponse | null, loading: boolean) => <MemoryRouter><LiveConversation paneId="w1:p1" history={history} loading={loading} error={false} /></MemoryRouter>;
    const { container, rerender } = render(view(null, true));
    const skeleton = screen.getByText("Loading conversation…").closest("[role='status']")!;
    expect(skeleton.querySelectorAll("[data-skeleton-turn]")).toHaveLength(3);
    expect(container.querySelector(".animate-spin")).toBeNull();

    // The bridge names the session with its first page, which remounts the scoped list.
    rerender(view({ paneId: "w1:p1", available: true, sessionKey: "codex:work", entries: fixtureTranscript, hasMore: false, total: 2, fileTruncated: false }, false));
    expect(screen.queryByText("Loading conversation…")).not.toBeInTheDocument();
    expect(screen.getByText("what changed today?")).toBeInTheDocument();
  });

  // T18: two paragraphs said different things above the recovery form; then a bordered card stood
  // where every other empty page draws the shared empty state. One empty state, every way to link.
  it("offers the shared empty state for a pane with no conversation linked, with every way to link one", () => {
    render(<MemoryRouter><LiveConversation paneId="w2:codex" history={{ paneId: "w2:codex", available: false, reason: "no-session" }} loading={false} error={false}
      recovery={<ConnectConversation paneId="w2:codex" disabled={false} onConnected={vi.fn()} />} /></MemoryRouter>);
    const empty = screen.getByRole("heading", { level: 2, name: "No conversation linked" }).closest<HTMLElement>("[data-slot=empty-state]");
    expect(empty).not.toBeNull();
    expect(empty).toHaveTextContent("Send a message to start, or link the one already running.");
    // Find is the large action every empty state offers; the typed ID and its full-width Connect wait
    // behind their disclosure, inside the same empty state.
    expect(within(empty!).getByRole("button", { name: "Find Codex conversations" })).toHaveClass("ui-button-lg", "bg-foreground", "text-base");
    fireEvent.click(within(empty!).getByRole("button", { name: "Enter a session ID" }));
    expect(within(empty!).getByRole("textbox", { name: "Session ID" })).toBeVisible();
    expect(within(empty!).getByRole("button", { name: "Connect history" })).toHaveClass("w-full", "rounded-lg", "text-body");
    expect(screen.queryByText(/connect an existing session/)).not.toBeInTheDocument();
  });

  // QA 14: the link card's ink button sat stacked above the question card. While a question waits in
  // the thread, the empty state is one quiet line and the question is the only card.
  it("folds the empty state to one line while a question waits under it", () => {
    render(<MemoryRouter><LiveConversation paneId="w2:codex" history={{ paneId: "w2:codex", available: false, reason: "no-session" }} loading={false} error={false}
      recovery={<button type="button">Find Codex conversations</button>} waiting footer={<section aria-label="Agent question">Pick a fruit?</section>} /></MemoryRouter>);
    expect(screen.queryByRole("heading", { name: "No conversation linked" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Find Codex conversations" })).not.toBeInTheDocument();
    expect(screen.getByText("No conversation linked")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Agent question" })).toBeInTheDocument();
  });

  it("does not offer to connect a session where nothing can be connected", () => {
    render(<MemoryRouter><LiveConversation paneId="w1:p1" history={{ paneId: "w1:p1", available: false, reason: "no-session" }} loading={false} error={false} /></MemoryRouter>);
    expect(screen.getByText("Send the first message to start the conversation.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "No conversation linked" })).not.toBeInTheDocument();
  });

  // iOS keeps the keyboard up over a tap on plain text; Messages and herdr-web-ui close it when the
  // reader drags the thread down or taps it. The draft stays in the box.
  it("closes the keyboard when the reader drags the thread down 32 px, and keeps the draft", () => {
    const history: PaneHistoryResponse = { paneId: "w1:p1", available: true, entries: fixtureTranscript, hasMore: false, total: 2, fileTruncated: false };
    const { container } = render(<MemoryRouter><LiveConversation paneId="w1:p1" history={history} loading={false} error={false} /><textarea aria-label="Draft" defaultValue="Half a thought" /></MemoryRouter>);
    const scroller = container.querySelector<HTMLElement>(".overflow-y-auto")!;
    const draft = screen.getByRole("textbox", { name: "Draft" });
    act(() => draft.focus());

    fireEvent.touchStart(scroller, { touches: [{ clientX: 100, clientY: 200 }] });
    fireEvent.touchMove(scroller, { touches: [{ clientX: 100, clientY: 160 }] });
    fireEvent.touchMove(scroller, { touches: [{ clientX: 102, clientY: 220 }] });
    expect(draft).toHaveFocus();
    fireEvent.touchMove(scroller, { touches: [{ clientX: 104, clientY: 232 }] });
    expect(draft).not.toHaveFocus();
    expect(draft).toHaveValue("Half a thought");
  });

  it("closes the keyboard on a tap on the thread's text, not on its controls", () => {
    const history: PaneHistoryResponse = { paneId: "w1:p1", available: true, entries: fixtureTranscript, hasMore: false, total: 2, fileTruncated: false };
    render(<MemoryRouter><LiveConversation paneId="w1:p1" history={history} loading={false} error={false} /><textarea aria-label="Draft" defaultValue="Half a thought" /></MemoryRouter>);
    const draft = screen.getByRole("textbox", { name: "Draft" });
    const tap = (target: Element) => {
      fireEvent.touchStart(target, { touches: [{ clientX: 50, clientY: 50 }] });
      fireEvent.touchEnd(target, { changedTouches: [{ clientX: 52, clientY: 51 }] });
    };

    act(() => draft.focus());
    tap(screen.getByRole("button", { expanded: false })); // the folded work log, whatever its label says
    expect(draft).toHaveFocus();
    tap(screen.getByText("One commit: abc1234."));
    expect(draft).not.toHaveFocus();
    expect(draft).toHaveValue("Half a thought");
  });

  // iOS rubber-bands past the end; on the way back the list moves up while still past the bottom.
  it("counts a bounce past the bottom as the bottom", () => {
    const history: PaneHistoryResponse = { paneId: "w1:p1", available: true, entries: fixtureTranscript, hasMore: false, total: 2, fileTruncated: false };
    const { container } = render(<MemoryRouter><LiveConversation paneId="w1:p1" history={history} loading={false} error={false} /></MemoryRouter>);
    const scroller = container.querySelector<HTMLElement>(".overflow-y-auto")!;
    const box = scrollBox(scroller, { height: 1000, client: 100 });
    act(() => { scroller.scrollTo({ top: box.height }); fireEvent.scroll(scroller); });
    for (const top of [960, 940, 900]) {
      box.top = top;
      fireEvent.scroll(scroller);
    }
    expect(screen.queryByRole("button", { name: /^Scroll to latest/ })).not.toBeInTheDocument();
  });
});

/** Scroll geometry jsdom lacks: `top` clamps like a browser's, and scrollTo moves it. */
function scrollBox(el: HTMLElement, size: { height: number; client: number }) {
  const box = { ...size, top: 0 };
  Object.defineProperties(el, {
    scrollHeight: { configurable: true, get: () => box.height },
    clientHeight: { configurable: true, get: () => box.client },
    scrollTop: { configurable: true, get: () => box.top, set: (value: number) => { box.top = Math.max(0, Math.min(value, box.height - box.client)); } },
  });
  el.scrollTo = ((options: ScrollToOptions) => { el.scrollTop = options.top ?? 0; }) as HTMLElement["scrollTo"];
  return box;
}


const initialHistory: PaneHistoryResponse = { paneId: "w1:p1", available: true, entries: fixtureTranscript, hasMore: true, total: 100, fileTruncated: false };
const olderEntry = { uuid: "older-turn", ts: "", role: "user" as const, parts: [{ kind: "text" as const, text: "An older request" }] };

describe("inline history pagination", () => {
  it("loads a bounded session-scoped page, keeps the composer mounted and anchors the reader", async () => {
    vi.mocked(fetchHistory).mockResolvedValue({ ...initialHistory, available: true, entries: [olderEntry], hasMore: false });
    const { container } = render(<><LiveConversation paneId="w1:p1" session="work" history={initialHistory} loading={false} error={false} /><textarea aria-label="Live draft" defaultValue="Keep writing" /></>);
    const draft = screen.getByRole("textbox", { name: "Live draft" });
    const scroller = container.querySelector(".overflow-y-auto")!;
    Object.defineProperties(scroller, {
      scrollHeight: { get: () => screen.queryByText("An older request") ? 1500 : 1000 },
      clientHeight: { value: 100 },
    });
    fireEvent.scroll(scroller, { target: { scrollTop: 150 } });
    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));
    await screen.findByText("An older request");
    expect(fetchHistory).toHaveBeenCalledWith("w1:p1", { limit: 120, before: fixtureTranscript[0]!.uuid }, "work", expect.any(AbortSignal));
    expect(screen.getByText("what changed today?")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Live draft" })).toBe(draft);
    expect(draft).toHaveValue("Keep writing");
    expect(scroller.scrollTop).toBe(650);
    expect(screen.getByRole("button", { name: /^Scroll to latest/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load older messages" })).not.toBeInTheDocument();
  });

  it("fetches the next older page on its own as the reader scrolls up near the top, keeping their place", async () => {
    vi.mocked(fetchHistory).mockResolvedValue({ ...initialHistory, available: true, entries: [olderEntry], hasMore: true });
    const { container } = render(<LiveConversation paneId="w1:p1" session="work" history={initialHistory} loading={false} error={false} />);
    const scroller = container.querySelector<HTMLElement>(".overflow-y-auto")!;
    const box = scrollBox(scroller, { height: 3000, client: 600 });
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => screen.queryByText("An older request") ? 3400 : 3000 });
    act(() => { scroller.scrollTo({ top: box.height }); fireEvent.scroll(scroller); });

    box.top = 1500;
    fireEvent.scroll(scroller);
    expect(fetchHistory).not.toHaveBeenCalled();
    box.top = 300;
    fireEvent.scroll(scroller);
    box.top = 200;
    fireEvent.scroll(scroller);

    await screen.findByText("An older request");
    expect(fetchHistory).toHaveBeenCalledOnce();
    expect(fetchHistory).toHaveBeenCalledWith("w1:p1", { limit: 120, before: fixtureTranscript[0]!.uuid }, "work", expect.any(AbortSignal));
    // The page landed 400 px above the turn being read, so the list moved down by exactly that much.
    expect(box.top).toBe(600);
    expect(screen.getByRole("button", { name: /^Scroll to latest/ })).toBeInTheDocument();
  });

  it("leaves a failed older page for the reader to retry and pages nothing while searching", async () => {
    vi.mocked(fetchHistory).mockRejectedValue(new Error("offline"));
    const view = (searching: boolean) => <LiveConversation paneId="w1:p1" history={initialHistory} loading={false} error={false} searching={searching} query={searching ? "changed" : ""} />;
    const { container, rerender } = render(view(false));
    const scroller = container.querySelector<HTMLElement>(".overflow-y-auto")!;
    const box = scrollBox(scroller, { height: 3000, client: 600 });
    act(() => { scroller.scrollTo({ top: box.height }); fireEvent.scroll(scroller); });
    box.top = 300;
    fireEvent.scroll(scroller);
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry older messages" })).toBeEnabled());
    box.top = 100;
    fireEvent.scroll(scroller);
    expect(fetchHistory).toHaveBeenCalledOnce();

    vi.mocked(fetchHistory).mockClear();
    Element.prototype.scrollIntoView = vi.fn();
    rerender(view(true));
    box.top = 2400;
    fireEvent.scroll(scroller);
    box.top = 200;
    fireEvent.scroll(scroller);
    expect(fetchHistory).not.toHaveBeenCalled();
  });

  it("stops paging when a capped log returns no new entries", async () => {
    vi.mocked(fetchHistory).mockResolvedValue({ ...initialHistory, available: true, entries: fixtureTranscript, fileTruncated: true });
    render(<LiveConversation paneId="w1:p1" history={initialHistory} loading={false} error={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));
    await screen.findByText("You've reached the oldest messages available from this session log.");
    expect(screen.queryByRole("button", { name: "Load older messages" })).not.toBeInTheDocument();
    expect(fetchHistory).toHaveBeenCalledOnce();
  });

  it("ignores an older-page response after the session changes", async () => {
    let resolvePage!: (value: PaneHistoryResponse) => void;
    vi.mocked(fetchHistory).mockImplementation(() => new Promise((resolve) => { resolvePage = resolve; }));
    const view = (session: string) => <LiveConversation paneId="w1:p1" session={session} history={initialHistory} loading={false} error={false} />;
    const { rerender } = render(view("work"));
    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));
    const signal = vi.mocked(fetchHistory).mock.calls[0]![3]!;
    rerender(view("personal"));
    expect(signal.aborted).toBe(true);
    await act(async () => { resolvePage({ ...initialHistory, available: true, entries: [olderEntry] }); });
    expect(screen.queryByText("An older request")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load older messages" })).toBeEnabled();
  });

  it("freezes refreshed turns during paging and follows latest after a successful send", async () => {
    let resolvePage!: (value: PaneHistoryResponse) => void;
    vi.mocked(fetchHistory).mockImplementation(() => new Promise((resolve) => { resolvePage = resolve; }));
    const latest: PaneHistoryResponse = { ...initialHistory, available: true, entries: [{ uuid: "newest", ts: "", role: "assistant", parts: [{ kind: "text", text: "Latest reply" }] }] };
    const view = (history: PaneHistoryResponse, followKey: number) => <LiveConversation paneId="w1:p1" history={history} loading={false} error={false} followKey={followKey} />;
    const { rerender } = render(view(initialHistory, 0));
    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));
    rerender(view(latest, 0));
    expect(screen.queryByText("Latest reply")).not.toBeInTheDocument();
    expect(screen.getByText("what changed today?")).toBeInTheDocument();
    rerender(view(latest, 1));
    expect(screen.getByText("Latest reply")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Scroll to latest/ })).not.toBeInTheDocument();
    await act(async () => { resolvePage({ ...initialHistory, available: true, entries: [olderEntry] }); });
    expect(screen.queryByText("An older request")).not.toBeInTheDocument();
  });

  it("keeps the reading window and offers retry when an older page fails", async () => {
    vi.mocked(fetchHistory).mockRejectedValue(new Error("offline"));
    render(<LiveConversation paneId="w1:p1" history={initialHistory} loading={false} error={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry older messages" })).toBeEnabled());
    expect(screen.getByText("what changed today?")).toBeInTheDocument();
  });
});

it("skips transcript rendering on unrelated parent polls but renders changed history", () => {
  const history: PaneHistoryResponse = { paneId: "memo", available: true, entries: fixtureTranscript, hasMore: false, total: 2, fileTruncated: false };
  const retry = vi.fn();
  const view = (revision: number, data = history) => <section data-parent-revision={revision}><LiveConversation paneId="memo" history={data} loading={false} error={false} onRetry={retry} /></section>;
  const { rerender } = render(view(0));
  const initialRenders = vi.mocked(TranscriptView).mock.calls.length;
  expect(initialRenders).toBeGreaterThan(0);
  for (let revision = 1; revision <= 10; revision++) rerender(view(revision));
  expect(vi.mocked(TranscriptView).mock.calls.length).toBe(initialRenders);
  rerender(view(11, { ...history, entries: [...fixtureTranscript, { uuid: "new", ts: "", role: "assistant", parts: [{ kind: "text", text: "A new response" }] }] }));
  expect(vi.mocked(TranscriptView).mock.calls.length).toBeGreaterThan(initialRenders);
  expect(screen.getByText("A new response")).toBeInTheDocument();
});

it("searches the native transcript and holds results while new messages arrive", () => {
  const count = vi.fn();
  const view = (history: PaneHistoryResponse) => <LiveConversation paneId="w1:p1" history={history} loading={false} error={false} searching query="changed" onMatchCount={count} />;
  const { container, rerender } = render(view(initialHistory));
  expect(count).toHaveBeenLastCalledWith(1);
  expect(container.querySelector('mark[aria-current="true"]')).toHaveTextContent("changed");
  rerender(view({ ...initialHistory, available: true, entries: [olderEntry] }));
  expect(container.querySelector("mark")).toHaveTextContent("changed");
  expect(screen.queryByText("An older request")).not.toBeInTheDocument();
});

// Find leaves the current hit a third down what the reader sees, below the chrome a phone draws over
// the list's top (its scroll-padding), so each step lands the eye in one place. A call's result landing
// in the held window redraws the turns; the hit stays put.
describe("find's current hit", () => {
  const asked: TranscriptEntry = { uuid: "q", ts: "", role: "user", parts: [{ kind: "text", text: "what changed today?" }] };
  const call = (result?: { text: string }): TranscriptEntry => ({ uuid: "c", ts: "", role: "assistant", parts: [{ kind: "tool", name: "Bash", summary: "git log", ...(result ? { result } : {}) }] });
  const history = (entries: TranscriptEntry[]): PaneHistoryResponse => ({ paneId: "w1:p1", available: true, entries, hasMore: false, total: entries.length, fileTruncated: false });

  function setup(inset: number) {
    const view = (entries: TranscriptEntry[], searching: boolean) => <LiveConversation paneId="w1:p1" history={history(entries)} loading={false} error={false} searching={searching} query={searching ? "changed" : ""} currentMatch={0} activityStatus="working" />;
    const { container, rerender } = render(view([asked, call()], false));
    const scroller = container.querySelector<HTMLElement>(".overflow-y-auto")!;
    const box = scrollBox(scroller, { height: 3000, client: 600 });
    if (inset) scroller.style.setProperty("scroll-padding-top", `${inset}px`);
    // The hit sits 900px down the list; the list's box is the top 600px of the screen.
    const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 390, width: 390, height, x: 0, y: top, toJSON: () => ({}) });
    const spy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this === scroller) return rect(0, 600);
      if (this.matches('mark[aria-current="true"]')) return rect(900 - box.top, 20);
      if (this.matches("[data-turn]")) return rect(880 - box.top, 60);
      return rect(0, 0);
    });
    onTestFinished(() => spy.mockRestore());
    // What the browser's centring would do, so a stray scrollIntoView shows up as a moved hit.
    const centre = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) { box.top += this.getBoundingClientRect().top - 300; });
    onTestFinished(() => centre.mockRestore());
    return { box, show: (entries: TranscriptEntry[]) => rerender(view(entries, true)) };
  }

  it("lands a third down the list, and stays there when a call's result lands", () => {
    const { box, show } = setup(0);
    show([asked, call()]);
    expect(box.top).toBe(700);
    show([asked, call({ text: "abc1234 fix" })]);
    expect(screen.getByRole("button", { name: /^Ran git log/ })).toBeInTheDocument();
    expect(box.top).toBe(700);
  });

  it("measures the third below the chrome drawn over the list's top", () => {
    const { box, show } = setup(90);
    show([asked, call()]);
    expect(box.top).toBe(640);
  });
});

it("opens older messages from the toolbar without replacing the live draft", async () => {
  vi.mocked(fetchHistory).mockResolvedValue({ ...initialHistory, available: true, entries: [olderEntry], hasMore: false });
  const view = (historyRequest: number) => <><LiveConversation paneId="w1:p1" history={initialHistory} loading={false} error={false} historyRequest={historyRequest} /><textarea aria-label="Draft" defaultValue="Still here" /></>;
  const { rerender } = render(view(0));
  const input = screen.getByRole("textbox");
  expect(fetchHistory).not.toHaveBeenCalled();
  rerender(view(1));
  expect(await screen.findByText("An older request")).toBeInTheDocument();
  expect(screen.getByRole("textbox")).toBe(input);
  expect(input).toHaveValue("Still here");
});

describe("LiveConversation — pending bubbles", () => {
  it("shows this client's send at the end until the journal has it", async () => {
    const scope = localSendScope("w1:p1", undefined);
    const history = (entries: TranscriptEntry[]): PaneHistoryResponse =>
      ({ paneId: "w1:p1", available: true, entries, hasMore: false, total: entries.length, fileTruncated: false });
    const { rerender } = render(<LiveConversation paneId="w1:p1" history={history(fixtureTranscript)} loading={false} error={false} />);
    act(() => { addLocalSend(scope, "ship it"); });
    expect(await screen.findByText("ship it")).toBeInTheDocument();
    expect(screen.getByText("Sending…")).toBeInTheDocument();

    rerender(<LiveConversation paneId="w1:p1" history={history([...fixtureTranscript, { uuid: "t9", ts: "2026-07-25T06:30:00.000Z", role: "user", parts: [{ kind: "text", text: "ship it" }] }])} loading={false} error={false} />);
    await waitFor(() => expect(screen.queryByText("Sending…")).not.toBeInTheDocument());
    expect(screen.getAllByText("ship it")).toHaveLength(1);
  });

  // Stop already counts a delivered message as a turn (use-stop-turn's awaitingTurn); the chat waited
  // for the journal row AND Herdr's status before it said Working….
  it("says Working… under a message the agent received, before the journal or Herdr shows the turn", async () => {
    const scope = localSendScope("w1:p2", undefined);
    const answered: TranscriptEntry[] = [fixtureTranscript[0]!, { ...fixtureTranscript[1]!, phase: "final_answer" }];
    const view = (entries: TranscriptEntry[], activityStatus: "idle" | "working") =>
      <LiveConversation paneId="w1:p2" history={{ paneId: "w1:p2", available: true, entries, hasMore: false, total: entries.length, fileTruncated: false }}
        activityStatus={activityStatus} loading={false} error={false} />;
    const { rerender } = render(view(answered, "idle"));
    let queued = "";
    act(() => { queued = addLocalSend(scope, "after this turn", "queued"); });
    expect(screen.queryByText("Working…")).not.toBeInTheDocument();
    act(() => { updateLocalSend(scope, queued, { state: "sent" }); });
    expect(await screen.findByText("Working…")).toBeInTheDocument();

    rerender(view([...answered, { uuid: "t9", ts: "", role: "user", parts: [{ kind: "text", text: "after this turn" }] }], "working"));
    await waitFor(() => expect(screen.getAllByText("after this turn")).toHaveLength(1));
    expect(screen.getAllByText("Working…")).toHaveLength(1);
  });

  // Measured on the bench: the journal read that takes the bubble over often lands before the read
  // that says the agent works, and Working… went out for 50-900 ms in between.
  it("keeps Working… while the journal has the message and the agent's state has not caught up", async () => {
    const scope = localSendScope("w1:p3", undefined);
    const answered: TranscriptEntry[] = [fixtureTranscript[0]!, { ...fixtureTranscript[1]!, phase: "final_answer" }];
    const asked = [...answered, { uuid: "t9", ts: "", role: "user" as const, parts: [{ kind: "text" as const, text: "check the logs" }] }];
    const view = (entries: TranscriptEntry[], activityStatus: "idle" | "working") =>
      <LiveConversation paneId="w1:p3" history={{ paneId: "w1:p3", available: true, entries, hasMore: false, total: entries.length, fileTruncated: false }}
        activityStatus={activityStatus} loading={false} error={false} />;
    const { rerender } = render(view(answered, "idle"));
    act(() => { updateLocalSend(scope, addLocalSend(scope, "check the logs"), { state: "sent" }); });
    expect(await screen.findByText("Working…")).toBeInTheDocument();

    rerender(view(asked, "idle"));
    await waitFor(() => expect(screen.getAllByText("check the logs")).toHaveLength(1));
    expect(screen.getAllByText("Working…")).toHaveLength(1);
    rerender(view(asked, "working"));
    expect(screen.getAllByText("Working…")).toHaveLength(1);
    rerender(view(asked, "idle"));
    expect(screen.queryByText("Working…")).not.toBeInTheDocument();
  });
});

// Tapping a finished step holds the thread still while the turn runs (work-turn #77's finding). The
// held turn keeps its live state: the running call still runs, and its result lands on its row.
describe("LiveConversation — a step tapped while the turn runs", () => {
  const at = (s: number) => `2026-07-25T09:0${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}Z`;
  const ask: TranscriptEntry = { uuid: "ask", ts: at(0), role: "user", parts: [{ kind: "text", text: "Run the tab strip tests." }] };
  const read: TranscriptEntry = { uuid: "read", ts: at(4), role: "assistant", turnId: "t1", turn: { status: "running", startedAt: at(0) }, parts: [{ kind: "tool", name: "Read", summary: "/repo/tab-strip.tsx", result: { text: "import" } }] };
  const run = (result?: string): TranscriptEntry => ({ uuid: "run", ts: at(9), role: "assistant", turnId: "t1", turn: { status: "running", startedAt: at(0) },
    parts: [{ kind: "tool", name: "Bash", summary: "bun run test tab-strip", ...(result ? { result: { text: result } } : {}) }] });
  const history = (entries: TranscriptEntry[]): PaneHistoryResponse => ({ paneId: "w1:p1", available: true, entries, hasMore: false, total: entries.length, fileTruncated: false });
  const view = (entries: TranscriptEntry[], status: "working" | "idle" = "working") =>
    <MemoryRouter><LiveConversation paneId="w1:p1" history={history(entries)} activityStatus={status} loading={false} error={false} /></MemoryRouter>;

  it("keeps the running call running while the reader holds the thread", () => {
    const { rerender } = render(view([ask, read, run()]));
    fireEvent.click(screen.getByRole("button", { name: /^Read / }));
    rerender(view([ask, read, run()]));
    expect(screen.getByRole("button", { name: /^Running bun run test tab-strip/ })).toBeInTheDocument();
    expect(screen.queryByText("No output recorded")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Working for/ })).toBeInTheDocument();
  });

  it("lands the call's result on its row while held, and adds nothing below it", () => {
    const { rerender } = render(view([ask, read, run()]));
    fireEvent.click(screen.getByRole("button", { name: /^Read / }));
    const next: TranscriptEntry = { uuid: "next", ts: at(20), role: "assistant", turnId: "t1", turn: { status: "running", startedAt: at(0) }, parts: [{ kind: "tool", name: "Bash", summary: "bun run build" }] };
    rerender(view([ask, read, run("14 passed"), next]));
    expect(screen.getByRole("button", { name: "Ran bun run test tab-strip" })).toBeInTheDocument();
    expect(screen.queryByText("No output recorded")).not.toBeInTheDocument();
    expect(screen.queryByText("bun run build")).not.toBeInTheDocument();
  });

  // A result that lands while an older page loads stays on its row once the page goes in above it.
  it("keeps a result that landed while an older page was loading", async () => {
    let resolvePage!: (value: PaneHistoryResponse) => void;
    vi.mocked(fetchHistory).mockImplementation(() => new Promise((resolve) => { resolvePage = resolve; }));
    const paged = (entries: TranscriptEntry[]) => <MemoryRouter><LiveConversation paneId="w1:p1" history={{ paneId: "w1:p1", available: true, entries, hasMore: true, total: entries.length, fileTruncated: false }}
      activityStatus="working" loading={false} error={false} /></MemoryRouter>;
    const { rerender } = render(paged([ask, read, run()]));
    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));
    rerender(paged([ask, read, run("14 passed")]));
    expect(screen.getByRole("button", { name: "Ran bun run test tab-strip" })).toBeInTheDocument();
    await act(async () => { resolvePage(history([olderEntry])); });
    expect(screen.getByText("An older request")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ran bun run test tab-strip" })).toBeInTheDocument();
  });

  it("neither folds the held turn nor calls its calls unrecorded once the turn ends", () => {
    const { rerender } = render(view([ask, read, run()]));
    fireEvent.click(screen.getByRole("button", { name: /^Read / }));
    const done: TranscriptEntry = { uuid: "done", ts: at(30), role: "assistant", turnId: "t1", phase: "final_answer", turn: { status: "completed", startedAt: at(0), durationMs: 30_000 }, parts: [{ kind: "text", text: "All green." }] };
    rerender(view([ask, read, run("14 passed"), done], "idle"));
    expect(screen.getByRole("button", { name: /^Read /, expanded: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ran bun run test tab-strip" })).toBeInTheDocument();
    expect(screen.queryByText("No output recorded")).not.toBeInTheDocument();
  });
});
