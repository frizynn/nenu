import { setLocked } from "@/lib/idle";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "@/test/setup";
import { SessionSubagents } from "./session-subagents";

const child = { id: "child", parentId: "parent", name: "Reviewer", task: "Review the session", status: "running", model: "test-model" };
const list = { available: true, sessionKey: "parent-key", agents: [child], truncated: false };

it("opens a child's transcript without sending input or navigating away", async () => {
  const user = userEvent.setup();
  const requests: string[] = [];
  server.use(
    http.get("/api/pane/parent/subagents", () => HttpResponse.json(list)),
    http.get("/api/pane/parent/subagent-history", ({ request }) => {
      requests.push(new URL(request.url).searchParams.get("id") ?? "");
      return HttpResponse.json({ sessionKey: "parent-key", agent: child, entries: [{ uuid: "reply", ts: "", role: "assistant", parts: [{ kind: "text", text: "Child result" }] }], truncated: false });
    }),
  );
  render(<SessionSubagents paneId="parent" agent="claude" />);
  await user.click(await screen.findByRole("button", { name: "Subagents (1 active, 1 total)" }));
  expect(screen.getByText("Working")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /Reviewer/ }));
  expect(await screen.findByText("Child result")).toBeInTheDocument();
  expect(requests).toEqual(["child"]);
  await user.click(screen.getByRole("button", { name: "All agents" }));
  expect(screen.queryByText("Child result")).not.toBeInTheDocument();
});

it("clears the previous session when switching panes", async () => {
  const user = userEvent.setup();
  server.use(http.get("/api/pane/:id/subagents", ({ params }) => HttpResponse.json(params.id === "parent" ? list : { ...list, sessionKey: "other", agents: [] })));
  const view = render(<SessionSubagents paneId="parent" agent="claude" />);
  await user.click(await screen.findByRole("button", { name: "Subagents (1 active, 1 total)" }));
  expect(screen.getByText("Reviewer")).toBeInTheDocument();
  view.rerender(<SessionSubagents paneId="other" agent="claude" />);
  await waitFor(() => expect(screen.queryByText("Reviewer")).not.toBeInTheDocument());
  await user.click(screen.getByRole("button", { name: "Subagents" }));
  expect(await screen.findByText(/No subagents in this session/)).toBeInTheDocument();
});

it("does not present stale running state after refresh fails", async () => {
  const user = userEvent.setup(); let fail = false;
  server.use(http.get("/api/pane/parent/subagents", () => fail ? new HttpResponse(null, { status: 503 }) : HttpResponse.json(list)));
  render(<SessionSubagents paneId="parent" agent="codex" />);
  await screen.findByRole("button", { name: "Subagents (1 active, 1 total)" });
  fail = true;
  await user.click(screen.getByRole("button", { name: "Subagents (1 active, 1 total)" }));
  expect(await screen.findByText("Status unavailable")).toBeInTheDocument();
  expect(screen.queryByText("Working")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Retry subagents" })).toBeInTheDocument();
});

it("clears an open child when the same pane connects to a different conversation", async () => {
  const user = userEvent.setup(); let changed = false;
  server.use(
    http.get("/api/pane/parent/subagents", () => HttpResponse.json(changed ? { ...list, sessionKey: "replacement", agents: [] } : list)),
    http.get("/api/pane/parent/subagent-history", () => HttpResponse.json({ sessionKey: "parent-key", agent: child, entries: [{ uuid: "reply", ts: "", role: "assistant", parts: [{ kind: "text", text: "Previous child result" }] }], truncated: false })),
  );
  render(<SessionSubagents paneId="parent" agent="claude" />);
  await user.click(await screen.findByRole("button", { name: "Subagents (1 active, 1 total)" }));
  await user.click(screen.getByRole("button", { name: /Reviewer/ }));
  await screen.findByText("Previous child result");
  changed = true;
  act(() => { window.dispatchEvent(new Event("online")); });
  await screen.findByText(/No subagents in this session/);
  expect(screen.queryByText("Previous child result")).not.toBeInTheDocument();
});

it("separates completed history from live activity and displays the readable model", async () => {
  const user = userEvent.setup();
  server.use(http.get("/api/pane/parent/subagents", () => HttpResponse.json({ ...list, agents: [{ ...child, name: "Review checkout", task: "Review checkout", status: "completed", model: "claude-opus-5-5" }] })));
  render(<SessionSubagents paneId="parent" agent="claude" />);
  await user.click(await screen.findByRole("button", { name: "Subagents (0 active, 1 total)" }));
  expect(screen.getByText("No agents running")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Finished (1)" })).toBeInTheDocument();
  expect(screen.getAllByText("Review checkout")).toHaveLength(1);
  expect(screen.getByText("Opus 5.5")).toBeInTheDocument();
});


it("does not read subagents behind the idle cover and refreshes on resume", async () => {
  let calls = 0;
  server.use(http.get("/api/pane/parent/subagents", () => { calls++; return HttpResponse.json(list); }));
  setLocked(true);
  const view = render(<SessionSubagents paneId="parent" agent="claude" />);
  try {
    await act(async () => { window.dispatchEvent(new Event("online")); });
    expect(calls).toBe(0);
    await act(async () => setLocked(false));
    await waitFor(() => expect(calls).toBe(1));
  } finally { view.unmount(); setLocked(false); }
});
