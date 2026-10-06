import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { fixtureTranscript } from "@/test/handlers";
import type { PaneHistoryResponse, TranscriptEntry } from "@/lib/types";
import { LiveConversation } from "./live-conversation";
import { fetchHistory } from "@/lib/api";
import { TranscriptView } from "./transcript-view";
import { addLocalSend, localSendScope } from "@/lib/local-sends";

vi.mock("@/lib/api", () => ({ fetchHistory: vi.fn() }));
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
    fireEvent.click(screen.getByRole("button", { name: /1 tool call · Bash/ }));
    fireEvent.click(screen.getByRole("button", { name: /Bash.*git log/ }));
    expect(screen.getByText("abc1234 fix")).toBeInTheDocument();
  });

  it("preserves the reading window and draft when work is expanded during live updates", () => {
    const initial: PaneHistoryResponse = { paneId: "w1:p1", available: true, entries: fixtureTranscript, hasMore: false, total: 2, fileTruncated: false };
    const view = (history: PaneHistoryResponse) => <><LiveConversation paneId="w1:p1" history={history} loading={false} error={false} /><textarea aria-label="Draft" defaultValue="Still writing" /></>;
    const { rerender } = render(view(initial));
    const draft = screen.getByRole("textbox", { name: "Draft" });
    fireEvent.click(screen.getByRole("button", { name: /1 tool call · Bash/ }));
    fireEvent.click(screen.getByRole("button", { name: /Bash.*git log/ }));
    rerender(view({ ...initial, entries: [{ uuid: "new", ts: "", role: "assistant", parts: [{ kind: "text", text: "New latest turn" }] }] }));
    expect(screen.getByText("abc1234 fix")).toBeInTheDocument();
    expect(screen.queryByText("New latest turn")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Draft" })).toBe(draft);
    expect(draft).toHaveValue("Still writing");
    fireEvent.click(screen.getByRole("button", { name: "Scroll to latest" }));
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
    const scroller = container.querySelector(".overflow-y-auto")!;
    Object.defineProperties(scroller, { scrollHeight: { value: 1000 }, clientHeight: { value: 100 } });
    fireEvent.scroll(scroller, { target: { scrollTop: 0 } });
    rerender(view({ ...initial, entries: [{ uuid: "new", ts: "", role: "assistant", parts: [{ kind: "text", text: "New latest turn" }] }] }));
    expect(screen.getByText("what changed today?")).toBeInTheDocument();
    expect(screen.queryByText("New latest turn")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Scroll to latest" }));
    expect(screen.getByText("New latest turn")).toBeInTheDocument();
    expect(screen.queryByText("what changed today?")).not.toBeInTheDocument();
  });
});


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
    expect(screen.getByRole("button", { name: "Scroll to latest" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load older messages" })).not.toBeInTheDocument();
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
    expect(screen.queryByRole("button", { name: "Scroll to latest" })).not.toBeInTheDocument();
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
  Element.prototype.scrollIntoView = vi.fn();
  const view = (history: PaneHistoryResponse) => <LiveConversation paneId="w1:p1" history={history} loading={false} error={false} searching query="changed" onMatchCount={count} />;
  const { container, rerender } = render(view(initialHistory));
  expect(count).toHaveBeenLastCalledWith(1);
  expect(container.querySelector("mark")).toHaveTextContent("changed");
  expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  rerender(view({ ...initialHistory, available: true, entries: [olderEntry] }));
  expect(container.querySelector("mark")).toHaveTextContent("changed");
  expect(screen.queryByText("An older request")).not.toBeInTheDocument();
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
});
