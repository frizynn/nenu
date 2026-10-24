import type { ComponentProps } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

import { server } from "@/test/setup";
import { fixtureAgents } from "@/test/handlers";
import { setLocked } from "@/lib/idle";
import type { ActivityResponse, WorkflowDetailResponse } from "@/lib/activity";
import fixture from "./activity/activity.fixture.json";
import { AgentChat } from "./agent-chat";
import { SubagentConversation } from "./subagent-conversation";

// Background work as the operator meets it in a working Claude's chat: what waits on you behind the
// Needs you chip and what runs behind Background, both in the row above the composer, each a list whose
// rows open in place in a panel over the row, and details that never cover the whole screen.

const list = fixture.list as ActivityResponse & { available: true };
const detail = fixture.detail as WorkflowDetailResponse;
const runningRun = list.workflows.find((w) => w.status === "running")!;
const reviewer = { id: "a1", parentId: "", name: "reviewer", task: "Review the diff", status: "waiting", model: "claude-opus-5-5" };
const explorer = { id: "a2", parentId: "", name: "explorer", task: "Explore the repo", status: "running" };
const subagents = (agents: unknown[]) => ({ available: true, sessionKey: "parent-key", agents, truncated: false });

let subagentList: object | number = subagents([reviewer, explorer]);
let activityList: object = list;
let subagentCalls = 0;
beforeAll(() => { if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {}; });
beforeEach(() => {
  subagentList = subagents([reviewer, explorer]);
  activityList = list;
  subagentCalls = 0;
  server.use(
    http.get(/\/api\/pane\/[^/]+\/subagents$/, () => { subagentCalls++; return typeof subagentList === "number" ? new HttpResponse(null, { status: subagentList }) : HttpResponse.json(subagentList); }),
    http.get(/\/api\/pane\/[^/]+\/activity$/, ({ request }) => {
      const params = new URL(request.url).searchParams;
      if (params.get("run")) return HttpResponse.json(params.get("run") === detail.workflow.runId ? detail : { sessionKey: "s", workflow: runningRun, results: {} });
      if (params.get("task")) return HttpResponse.json({ sessionKey: "s", id: params.get("task"), text: "412 pass", truncated: false, updatedAt: 0 });
      return HttpResponse.json(activityList);
    }),
    http.get(/\/api\/pane\/[^/]+\/subagent-history$/, () => HttpResponse.json({ sessionKey: "parent-key", agent: reviewer,
      entries: [{ uuid: "child", ts: "", role: "assistant", parts: [{ kind: "text", text: "Child result" }] }], truncated: false })),
  );
});

function setDesktop(desktop: boolean) {
  window.matchMedia = ((query: string) => ({ matches: desktop && query === "(min-width: 1024px)", media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false })) as typeof window.matchMedia;
}
const originalMatchMedia = window.matchMedia;
afterEach(() => { window.matchMedia = originalMatchMedia; });

function renderChat(overrides: Partial<ComponentProps<typeof AgentChat>> = {}) {
  const agent = { ...fixtureAgents[0]!, status: "working" as const, hasSession: true };
  const props: ComponentProps<typeof AgentChat> = {
    paneId: agent.paneId, agent, agents: [agent], shellPanes: [], tabs: [], text: "", onBack: vi.fn(), onSelect: vi.fn(), ...overrides,
  };
  render(<RouterProvider router={createMemoryRouter([{ path: "/", element: <AgentChat {...props} /> }])} />);
  return { user: userEvent.setup() };
}

const row = () => screen.findByRole("group", { name: "Status" });
const chip = async (name: RegExp) => within(await row()).getByRole("button", { name });
const working = () => chip(/^Background, \d+$/);
// Finished work asks nothing of you: it leaves the line for the ⋯ menu (ADR 0108).
const lineGone = () => waitFor(() => expect(screen.queryByRole("group", { name: "Status" })).not.toBeInTheDocument());
const fromMenu = async (user: ReturnType<typeof userEvent.setup>, name: RegExp) => {
  await user.click(screen.getByRole("button", { name: "Conversation actions" }));
  await user.click(await screen.findByRole("button", { name }));
};
const needs = () => chip(/^Needs you, \d+$/);

it("names what waits on you and what runs in two chips, each listing only its own", async () => {
  const { user } = renderChat();
  const ask = await needs();
  expect(ask).toHaveAccessibleName("Needs you, 1");
  expect(await working()).toHaveAccessibleName(/^Background, \d+$/);
  await user.click(ask);
  expect(ask).toHaveAttribute("aria-expanded", "true");
  const asking = screen.getByRole("dialog", { name: "Needs you" });
  expect(within(within(asking).getByRole("list", { name: "In progress" })).getAllByRole("button", { name: /^Expand / }).map((r) => r.getAttribute("aria-label"))).toEqual(["Expand reviewer"]);
  // One panel at a time: Background takes Needs you's place.
  await user.click(await working());
  expect(screen.queryByRole("dialog", { name: "Needs you" })).not.toBeInTheDocument();
  const sheet = screen.getByRole("dialog", { name: "Background" });
  const rows = within(within(sheet).getByRole("list", { name: "In progress" })).getAllByRole("button", { name: /^Expand / });
  expect(rows.map((r) => r.getAttribute("aria-label"))).toContain(`Expand ${runningRun.name}`);
  expect(rows.map((r) => r.getAttribute("aria-label"))).not.toContain("Expand reviewer");
  expect(within(sheet).queryByRole("list", { name: "Done" })).not.toBeInTheDocument();
  await user.click(within(sheet).getByRole("button", { name: /^Done \(\d+\)$/ }));
  expect(within(sheet).getByRole("list", { name: "Done" })).toBeVisible();
  // What the session published on claude.ai stays reachable from the same list.
  await user.click(within(sheet).getByRole("button", { name: "Published (1)" }));
  expect(within(sheet).getByRole("link", { name: /Rediseño Nenu sobre Herdr/ })).toHaveAttribute("target", "_blank");
  // The cards that used to duplicate this list inside the chat are gone.
  expect(screen.queryByRole("dialog", { name: /^Workflow / })).not.toBeInTheDocument();
});

it("keeps finished work one tap away once nothing waits or runs", async () => {
  activityList = { ...list, workflows: list.workflows.filter((w) => w.status !== "running"), tasks: [] };
  subagentList = subagents([{ ...explorer, status: "completed" }]);
  const { user } = renderChat();
  await waitFor(() => expect(subagentCalls).toBeGreaterThan(0));
  await act(async () => {});
  // Nothing runs, so nothing takes the line above the box: finished work is a row of the ⋯ menu.
  expect(screen.queryByRole("group", { name: "Status" })).not.toBeInTheDocument();
  await fromMenu(user, /^Finished work · \d+$/);
  const sheet = screen.getByRole("dialog", { name: "Finished work" });
  // It opens on what was asked for: the finished rows, unfolded, with nothing about what runs.
  expect(within(sheet).queryByText("Nothing running in the background.")).not.toBeInTheDocument();
  expect(within(sheet).getByRole("button", { name: /^Done \(\d+\)$/ })).toHaveAttribute("aria-expanded", "true");
  expect(within(within(sheet).getByRole("list", { name: "Done" })).getByRole("button", { name: "Expand explorer" })).toBeVisible();
});

// No chip on the line takes focus back: the ⋯ trigger the panel was opened from does.
it("opens finished work from the ⋯ menu with focus in its panel, and Escape gives it back to ⋯", async () => {
  activityList = { ...list, workflows: list.workflows.filter((w) => w.status !== "running"), tasks: [] };
  subagentList = subagents([{ ...explorer, status: "completed" }]);
  const { user } = renderChat();
  await waitFor(() => expect(subagentCalls).toBeGreaterThan(0));
  await fromMenu(user, /^Finished work · \d+$/);
  const sheet = screen.getByRole("dialog", { name: "Finished work" });
  await waitFor(() => expect(sheet.contains(document.activeElement)).toBe(true));
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "Finished work" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Conversation actions" })).toHaveFocus();
});

it("says Published when all the session left is pages it published", async () => {
  activityList = { ...list, workflows: [], tasks: [] };
  subagentList = subagents([]);
  const { user } = renderChat();
  await waitFor(() => expect(subagentCalls).toBeGreaterThan(0));
  await fromMenu(user, /^Published · 1$/);
  expect(within(screen.getByRole("dialog", { name: "Published" })).getByRole("button", { name: "Published (1)" })).toHaveAttribute("aria-expanded", "true");
});

it("shows no chip when the session has nothing at all", async () => {
  activityList = { ...list, workflows: [], tasks: [], artifacts: [] };
  subagentList = subagents([]);
  renderChat();
  await waitFor(() => expect(subagentCalls).toBeGreaterThan(0));
  await act(async () => {});
  expect(screen.queryByRole("group", { name: "Status" })).not.toBeInTheDocument();
});

it("on a desk, the list stays open while you read it when the last process ends", async () => {
  setDesktop(true);
  const { user } = renderChat();
  await user.click(await working());
  await user.click(screen.getByRole("button", { name: /^Done \(\d+\)$/ }));
  activityList = { ...list, workflows: list.workflows.map((w) => ({ ...w, status: w.status === "running" ? "completed" : w.status, durationMs: w.durationMs ?? 1 })), tasks: [] };
  subagentList = subagents([]);
  act(() => { window.dispatchEvent(new Event("online")); });
  await lineGone();
  expect(screen.getByRole("dialog", { name: "Finished work" })).toBeVisible();
  expect(screen.getByRole("list", { name: "Done" })).toBeVisible();
});

it("on a desk, Esc closes the details panel instead of stopping the turn", async () => {
  setDesktop(true);
  const keys: string[] = [];
  server.use(http.post(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => { keys.push(JSON.stringify(await request.json())); return HttpResponse.json({ ok: true }); }));
  const { user } = renderChat();
  await user.click(await working());
  await user.click(screen.getByRole("button", { name: `Expand ${runningRun.name}` }));
  await user.click(screen.getByRole("button", { name: `Details of ${runningRun.name}` }));
  await screen.findByRole("complementary", { name: `Details: ${runningRun.name}` });
  await user.click(screen.getByRole("textbox"));
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("complementary", { name: /^Details/ })).not.toBeInTheDocument();
  expect(keys).toEqual([]);
  // Focus inside the panel: Esc closes it too.
  await user.click(await working());
  await user.click(screen.getByRole("button", { name: `Expand ${runningRun.name}` }));
  await user.click(screen.getByRole("button", { name: `Details of ${runningRun.name}` }));
  const panel = await screen.findByRole("complementary", { name: `Details: ${runningRun.name}` });
  within(panel).getByRole("button", { name: "Close details" }).focus();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("complementary", { name: /^Details/ })).not.toBeInTheDocument();
});

it("keeps the last known subagents while the pane reconnects", async () => {
  activityList = { ...list, workflows: [], tasks: [] };
  const agent = { ...fixtureAgents[0]!, status: "working" as const, hasSession: true };
  const props: ComponentProps<typeof AgentChat> = { paneId: agent.paneId, agent, agents: [agent], shellPanes: [], tabs: [], text: "", onBack: vi.fn(), onSelect: vi.fn() };
  const view = (bridge: ComponentProps<typeof AgentChat>["bridge"]) => <RouterProvider router={createMemoryRouter([{ path: "/", element: <AgentChat {...props} bridge={bridge} /> }])} />;
  const { rerender } = render(view("connected"));
  expect(await needs()).toHaveAccessibleName("Needs you, 1");
  rerender(view("disconnected"));
  await act(async () => {});
  expect(screen.queryByText("Couldn’t refresh. Showing last known activity.")).not.toBeInTheDocument();
  expect(await needs()).toHaveAccessibleName("Needs you, 1");
});

it("on a phone, details replace the panel's content: one panel, named once, with the header's Back", async () => {
  const { user } = renderChat();
  await user.click(await working());
  await user.click(screen.getByRole("button", { name: `Expand ${runningRun.name}` }));
  await user.click(screen.getByRole("button", { name: `Details of ${runningRun.name}` }));
  expect(screen.queryByRole("dialog", { name: "Background" })).not.toBeInTheDocument();
  const sheet = screen.getByRole("dialog", { name: runningRun.name });
  // Once the details have drawn, the run is named once, by the panel's own title.
  expect(await within(sheet).findByText("agents done")).toBeVisible();
  expect(within(sheet).getAllByRole("heading", { name: runningRun.name })).toHaveLength(1);
  // The way back is the header's chevron before that title, not a second control in the body.
  const backs = within(sheet).getAllByRole("button", { name: "Back" });
  expect(backs).toHaveLength(1);
  const title = within(sheet).getByRole("heading", { name: runningRun.name });
  expect(backs[0]!.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await user.click(backs[0]!);
  expect(screen.getByRole("dialog", { name: "Background" })).toBeVisible();
});

it("on a desk, details open in a side panel and the chat stays usable", async () => {
  setDesktop(true);
  const { user } = renderChat();
  await user.click(await working());
  expect(screen.getByRole("dialog", { name: "Background" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: `Expand ${runningRun.name}` }));
  await user.click(screen.getByRole("button", { name: `Details of ${runningRun.name}` }));
  const panel = screen.getByRole("complementary", { name: `Details: ${runningRun.name}` });
  expect(await within(panel).findByRole("heading", { name: runningRun.name })).toBeVisible();
  expect(screen.queryByRole("dialog", { name: "Background" })).not.toBeInTheDocument();
  const box = screen.getByRole("textbox");
  await user.type(box, "still typing");
  expect(box).toHaveValue("still typing");
  await user.click(within(panel).getByRole("button", { name: "Close details" }));
  expect(screen.queryByRole("complementary", { name: /^Details/ })).not.toBeInTheDocument();
});

it("a command's output opens as details in the same panel", async () => {
  activityList = { ...list, tasks: [{ id: "b1", kind: "bash", title: "bun test --watch", status: "running", at: 0, hasOutput: true }] };
  const { user } = renderChat();
  await user.click(await working());
  await user.click(screen.getByRole("button", { name: "Expand bun test --watch" }));
  await user.click(screen.getByRole("button", { name: "Details of bun test --watch" }));
  expect(screen.getByRole("dialog", { name: "bun test --watch" })).toBeVisible();
  expect(await screen.findByText("412 pass")).toBeVisible();
});

it("opens a subagent's conversation in place of the chat, and Back to Main returns", async () => {
  const { user } = renderChat();
  await user.click(await needs());
  await user.click(screen.getByRole("button", { name: "Expand reviewer" }));
  expect(screen.getByText("Review the diff")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Open conversation: reviewer" }));
  expect(await screen.findByText("Child result")).toBeVisible();
  expect(screen.queryByRole("dialog", { name: "Needs you" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Back to Main" }));
  expect(screen.queryByText("Child result")).not.toBeInTheDocument();
});

it("says a Claude subagent takes messages only through Main, and Write through Main returns addressed to it", async () => {
  const { user } = renderChat();
  await user.click(await needs());
  await user.click(screen.getByRole("button", { name: "Expand reviewer" }));
  await user.click(screen.getByRole("button", { name: "Open conversation: reviewer" }));
  const view = screen.getByRole("region", { name: "reviewer conversation" });
  await within(view).findByText("Child result");
  expect(within(view).getByText(/Claude Code takes messages for a subagent only from its main chat/)).toBeVisible();
  expect(within(view).queryByRole("textbox")).not.toBeInTheDocument();
  await user.click(within(view).getByRole("button", { name: "Write to reviewer through Main" }));
  expect(screen.queryByRole("region", { name: "reviewer conversation" })).not.toBeInTheDocument();
  // Main's own composer, focused, with the message addressed to the subagent: the operator writes the rest.
  await waitFor(() => expect(document.activeElement?.closest(".workbench-composer")).not.toBeNull());
  expect(document.activeElement).toHaveValue('Send to subagent "reviewer" (a1) with SendMessage: ');
});

it("offers no way to write to a subagent from a read-only device", async () => {
  const { user } = renderChat({ device: { enforced: true, device: "phone", authorized: false } });
  await user.click(await needs());
  await user.click(screen.getByRole("button", { name: "Expand reviewer" }));
  await user.click(screen.getByRole("button", { name: "Open conversation: reviewer" }));
  const view = screen.getByRole("region", { name: "reviewer conversation" });
  await within(view).findByText("Child result");
  expect(within(view).queryByRole("button", { name: /through Main/ })).not.toBeInTheDocument();
});

it("tells a Codex sub-agent's reader the same, in Codex's words", async () => {
  render(<SubagentConversation paneId="parent" harness="codex" selection={{ parentKey: "parent-key", agent: { ...reviewer, status: "running" } }} onWrite={() => {}} />);
  await screen.findByText("Child result");
  expect(screen.getByRole("button", { name: "Write to reviewer through Main" })).toBeInTheDocument();
  expect(screen.getByText(/Nenu does not write to a Codex sub-agent directly yet/)).toBeVisible();
});

it("does not present a stale subagent as running after a refresh fails", async () => {
  activityList = { ...list, workflows: [], tasks: [] };
  renderChat();
  await needs();
  subagentList = 503;
  act(() => { window.dispatchEvent(new Event("online")); });
  // Nothing it cannot vouch for still counts as waiting or working: what is left is finished work.
  await lineGone();
  expect(screen.queryByRole("button", { name: /^Needs you/ })).not.toBeInTheDocument();
});

it("discards a child's cached transcript when access is revoked", async () => {
  let denied = false;
  server.use(http.get(/\/api\/pane\/[^/]+\/subagent-history$/, () => denied ? new HttpResponse(null, { status: 403 })
    : HttpResponse.json({ sessionKey: "parent-key", agent: reviewer, entries: [{ uuid: "c", ts: "", role: "assistant", parts: [{ kind: "text", text: "Private child" }] }], truncated: false })));
  render(<SubagentConversation paneId="parent" selection={{ parentKey: "parent-key", agent: { ...reviewer, status: "running" } }} />);
  await screen.findByText("Private child");
  denied = true;
  act(() => { window.dispatchEvent(new Event("online")); });
  await waitFor(() => expect(screen.queryByText("Private child")).not.toBeInTheDocument());
  expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
});

it("does not read subagents behind the idle cover and reads again on resume", async () => {
  setLocked(true);
  try {
    renderChat();
    await act(async () => { window.dispatchEvent(new Event("online")); });
    expect(subagentCalls).toBe(0);
    await act(async () => setLocked(false));
    await waitFor(() => expect(subagentCalls).toBeGreaterThan(0));
  } finally { setLocked(false); }
});

it("keeps a run's details open on a phone when the last process ends, and the line goes", async () => {
  const { user } = renderChat();
  await user.click(await working());
  await user.click(screen.getByRole("button", { name: `Expand ${runningRun.name}` }));
  await user.click(screen.getByRole("button", { name: `Details of ${runningRun.name}` }));
  activityList = { ...list, workflows: [{ ...runningRun, status: "completed", durationMs: 1 }], tasks: [] };
  subagentList = subagents([]);
  act(() => { window.dispatchEvent(new Event("online")); });
  await lineGone();
  expect(screen.getByRole("dialog", { name: runningRun.name })).toBeVisible();
});
