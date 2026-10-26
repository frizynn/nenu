import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { onTestFinished } from "vitest";

import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { openNewAgent } from "@/lib/spawn";
import { server } from "@/test/setup";
import { NewAgentHost, openNewDialog } from "./new-agent-sheet";
import NewDialog, { newContext } from "./new-dialog";

const HOME = "/home/me";
const base: HomeData = {
  bridge: "connected", device: undefined, session: "work", sessions: [],
  error: false, authError: false, snoozedUntil: null, update: undefined, tabs: [], shellPanes: [],
  workspaces: [
    { workspaceId: "w:1", number: 1, label: "Nenu", focused: true, activeTabId: "t1", tabCount: 1, paneCount: 1 },
    { workspaceId: "w:2", number: 2, label: "rediseño mobile", focused: false, activeTabId: "t2", tabCount: 1, paneCount: 1 },
  ],
  agents: [
    { paneId: "w:2:p1", workspaceId: "w:2", workspaceLabel: "rediseño mobile", workspaceNumber: 2, tabId: "t2", agent: "codex", status: "idle", cwd: `${HOME}/code/acme`, focused: true },
  ],
};

const posts: Record<string, unknown[]> = {};
beforeEach(() => {
  localStorage.clear();
  for (const key of Object.keys(posts)) delete posts[key];
  const record = (path: string, reply: Record<string, unknown>) => http.post(path, async ({ request }) => {
    (posts[path] ??= []).push(await request.json());
    return HttpResponse.json(reply);
  });
  const pane = { paneId: "w:9:p1", workspaceId: "w:9", workspaceLabel: "new", tabId: "t9", cwd: HOME };
  server.use(
    http.get("/api/dirs", () => HttpResponse.json({ path: HOME, home: HOME, entries: ["code"], truncated: false })),
    record("/api/tab", { ok: true, pane }),
    record("/api/workspace", { ok: true, pane }),
    record("/api/pane/:paneId/start", { ok: true }),
  );
});

function setup({ data = base, entry = "/pane/w%3A2%3Ap1?s=work", host = false }: { data?: HomeData; entry?: string; host?: boolean } = {}) {
  const onClose = vi.fn();
  const router = createMemoryRouter([{
    id: ROOT_ROUTE_ID,
    path: "/",
    loader: () => data,
    element: <>{host ? <NewAgentHost /> : <NewDialog open onClose={onClose} />}<Outlet /></>,
    children: [
      { path: "pane/:paneId", element: <p>Pane page</p> },
      { path: "space/:spaceId", element: <p>Space page</p> },
    ],
  }], { initialEntries: [entry] });
  render(<RouterProvider router={router} />);
  return { router, onClose, user: userEvent.setup() };
}

function desktop() {
  const matchMedia = window.matchMedia;
  window.matchMedia = (query) => ({
    matches: query === "(min-width: 1024px)" || query === "(pointer: fine)", media: query,
    addEventListener: () => {}, removeEventListener: () => {},
  }) as unknown as MediaQueryList;
  onTestFinished(() => { window.matchMedia = matchMedia; });
}

/** The kind rows of the list, by the name each one starts with. */
const kinds = (create: { getAllByRole: (role: "button") => HTMLElement[] }) => create.getAllByRole("button").map((row) => row.textContent);

it("lists what it starts, naming the workspace on screen", async () => {
  setup();
  const create = within(await screen.findByRole("navigation", { name: "Create" }));
  expect(create.getAllByRole("heading").map((h) => h.textContent)).toEqual(["Start an agent"]);
  expect(kinds(create)).toEqual([
    expect.stringMatching(/^Here in rediseño mobile/),
    expect.stringMatching(/^In a new folder/),
    expect.stringMatching(/^Quick question/),
  ]);
  expect(create.queryByLabelText("In")).toBeNull();
});

it("lists no Here in until there is a workspace", async () => {
  setup({ data: { ...base, workspaces: [], agents: [] }, entry: "/?s=work" });
  const create = within(await screen.findByRole("navigation", { name: "Create" }));
  expect(kinds(create)).toEqual([expect.stringMatching(/^In a new folder/), expect.stringMatching(/^Quick question/)]);
});

it("names each step in the sheet's one title, and steps back from its header", async () => {
  const { user } = setup();
  expect(await screen.findByRole("dialog", { name: "New" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /^Here in/ }));
  expect(screen.getByRole("dialog", { name: "New tab" })).toBeInTheDocument();
  expect(screen.getAllByRole("heading", { name: /^New/ }).map((h) => h.textContent)).toEqual(["New tab"]);
  await user.click(screen.getByRole("button", { name: /^Directory/ }));
  expect(await screen.findByRole("dialog", { name: "Choose a folder" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(screen.getByRole("dialog", { name: "New tab" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^Directory/ })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(screen.getByRole("dialog", { name: "New" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
});

it("draws one header, the sheet's own, at every step", async () => {
  const { user } = setup();
  const dialog = await screen.findByRole("dialog", { name: "New" });
  const header = () => ({
    headings: within(dialog).getAllByRole("heading", { level: 2 }).map((h) => h.textContent),
    closes: within(dialog).getAllByRole("button", { name: "Close" }).length,
  });
  expect(header()).toEqual({ headings: ["New"], closes: 1 });
  await user.click(screen.getByRole("button", { name: /^Here in/ }));
  expect(header()).toEqual({ headings: ["New tab"], closes: 1 });
  await user.click(screen.getByRole("button", { name: /^Directory/ }));
  await screen.findByRole("dialog", { name: "Choose a folder" });
  expect(header()).toEqual({ headings: ["Choose a folder"], closes: 1 });
});

it("steps back on a desk only from the folder picker, where the list of kinds stays in view", async () => {
  desktop();
  const { user } = setup({ entry: "/?s=work" });
  expect(await screen.findByRole("dialog", { name: "New tab" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  await user.click(screen.getByRole("button", { name: /^Directory/ }));
  await user.click(await screen.findByRole("button", { name: "Back" }));
  expect(screen.getByRole("dialog", { name: "New tab" })).toBeInTheDocument();
});

it("moves focus to each step as it opens, so a keyboard never drops out of the sheet", async () => {
  const { user } = setup();
  const dialog = await screen.findByRole("dialog", { name: "New" });
  screen.getByRole("button", { name: /^Here in/ }).focus();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("heading", { name: "New tab" })).toHaveFocus();
  screen.getByRole("button", { name: /^Directory/ }).focus();
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("heading", { name: "Choose a folder" })).toHaveFocus();
  screen.getByRole("button", { name: "Back" }).focus();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("heading", { name: "New tab" })).toHaveFocus();
  screen.getByRole("button", { name: "Back" }).focus();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("heading", { name: "New" })).toHaveFocus();
  expect(dialog).toContainElement(document.activeElement as HTMLElement);
});

it("puts the caret in the first thing to type on a desk", async () => {
  desktop();
  const { user } = setup({ entry: "/?s=work" });
  expect(await screen.findByRole("heading", { name: "New tab" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /^Quick question/ }));
  expect(screen.getByLabelText("Message")).toHaveFocus();
});

it("opens from a tab's + on New tab in that workspace, one Back from the list", async () => {
  const { user } = setup({ host: true });
  onTestFinished(() => openNewAgent(null));
  act(() => openNewAgent({ kind: "tab", workspaceId: "w:1" }));
  expect(await screen.findByRole("dialog", { name: "New tab" })).toBeInTheDocument();
  expect(screen.getByLabelText("Workspace")).toHaveValue("w:1");
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(screen.getByRole("dialog", { name: "New" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^Here in Nenu/ })).toBeInTheDocument();
});

it("opens from Home's composer on New workspace with the message already written", async () => {
  setup({ host: true, entry: "/?s=work" });
  onTestFinished(() => openNewAgent(null));
  act(() => openNewAgent({ kind: "workspace", message: "Audit the auth flow" }));
  expect(await screen.findByRole("dialog", { name: "New workspace" })).toBeInTheDocument();
  expect(screen.getByLabelText("First message (optional)")).toHaveValue("Audit the auth flow");
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
});

it("opens from New on the list, and closes from its header", async () => {
  const { user } = setup({ host: true, entry: "/?s=work" });
  onTestFinished(() => openNewDialog(false));
  act(() => openNewDialog());
  expect(await screen.findByRole("dialog", { name: "New" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("slides away showing its last step when closed, then is gone", async () => {
  let end!: () => void;
  const finished = new Promise<void>((resolve) => { end = resolve; });
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [{ animationName: "exit", finished }] });
  onTestFinished(() => { delete (Element.prototype as { getAnimations?: unknown }).getAnimations; openNewAgent(null); });
  const { user } = setup({ host: true });
  onTestFinished(() => openNewDialog(false));
  act(() => openNewDialog());
  await user.click(await screen.findByRole("button", { name: /^Quick question/ }));
  expect(screen.getByRole("dialog", { name: "Quick question" })).toBeInTheDocument();
  act(() => openNewDialog(false));
  // Out of reach while it leaves, still the step that was on screen.
  expect(screen.getByRole("dialog", { name: "Quick question", hidden: true })).toHaveAttribute("inert");
  end();
  await act(async () => { await finished; });
  expect(screen.queryByRole("dialog", { hidden: true })).toBeNull();
});

it("starts over when New is asked for again over an open flow", async () => {
  setup({ host: true });
  onTestFinished(() => { openNewAgent(null); openNewDialog(false); });
  act(() => openNewAgent({ kind: "tab", workspaceId: "w:1" }));
  expect(await screen.findByRole("dialog", { name: "New tab" })).toBeInTheDocument();
  act(() => openNewDialog());
  expect(await screen.findByRole("dialog", { name: "New" })).toBeInTheDocument();
});

it("opens a tab with the chosen agent in the workspace on screen, then opens its pane", async () => {
  const { user, router, onClose } = setup();
  await user.click(await screen.findByRole("button", { name: /^Here in/ }));
  expect(screen.getByLabelText("Workspace")).toHaveValue("w:2");
  await user.click(screen.getByRole("radio", { name: "Codex" }));
  await user.click(screen.getByRole("button", { name: "Start Codex" }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(posts["/api/tab"]).toEqual([{ workspaceId: "w:2", cwd: `${HOME}/code/acme` }]);
  expect(router.state.location.pathname).toBe("/pane/w%3A9%3Ap1");
  await waitFor(() => expect(posts["/api/pane/:paneId/start"]).toEqual([{ agent: "codex", permission: "ask" }]));
});

it("opens beside a tab's panes in that workspace, on the model chosen", async () => {
  const splits: unknown[] = [];
  server.use(http.post("/api/tab/:tabId/split", async ({ request }) => {
    splits.push(await request.json());
    return HttpResponse.json({ ok: true, pane: { paneId: "w:2:p7", workspaceId: "w:2", workspaceLabel: "rediseño mobile", tabId: "t2", cwd: `${HOME}/code/acme` } });
  }));
  const { user, router } = setup({ data: { ...base, tabs: [{ tabId: "t2", workspaceId: "w:2", number: 1, label: "1", focused: true, paneCount: 1 }] } });
  await user.click(await screen.findByRole("button", { name: /^Here in/ }));
  await user.selectOptions(screen.getByLabelText("Opens in"), "Beside Tab 1");
  await user.click(screen.getByRole("button", { name: /^Model: Claude Code/ }));
  expect(screen.queryByRole("group", { name: "Codex" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("menuitemradio", { name: /^Opus 1M/ }));
  await user.click(screen.getByRole("button", { name: "Start Claude Code" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/pane/w%3A2%3Ap7"));
  expect(splits).toEqual([{ cwd: `${HOME}/code/acme` }]);
  expect(posts["/api/tab"]).toBeUndefined();
  await waitFor(() => expect(posts["/api/pane/:paneId/start"]).toEqual([{ agent: "claude", permission: "ask", model: "opus[1m]" }]));
});

it("makes the scratch workspace on the bridge's home for the first quick chat, then reuses it", async () => {
  localStorage.setItem("collie.spawn.dirs", JSON.stringify([`${HOME}/code/acme`]));
  const first = setup();
  await first.user.click(await screen.findByRole("button", { name: /^Quick question/ }));
  await first.user.type(await screen.findByLabelText("Message"), "what is 2+2");
  await first.user.click(screen.getByRole("button", { name: "Ask Claude Code" }));
  // No cwd: the bridge puts a new workspace on its home, and ~ never becomes the last folder picked.
  await waitFor(() => expect(posts["/api/workspace"]).toEqual([{ label: "scratch" }]));
  expect(JSON.parse(localStorage.getItem("collie.spawn.dirs")!)).toEqual([`${HOME}/code/acme`]);
  first.router.dispose();
  document.body.innerHTML = "";

  const scratch = { workspaceId: "w:5", number: 5, label: "scratch", focused: false, activeTabId: "t5", tabCount: 1, paneCount: 1 };
  const second = setup({ data: { ...base, workspaces: [...base.workspaces, scratch] } });
  await second.user.click(await screen.findByRole("button", { name: /^Quick question/ }));
  expect(await screen.findByText(/Opens in the/)).toHaveTextContent("Opens in the scratch workspace on ~.");
  await second.user.click(screen.getByRole("button", { name: "Ask Claude Code" }));
  await waitFor(() => expect(posts["/api/tab"]).toEqual([{ workspaceId: "w:5" }]));
});

it("opens on Tab on a desk in the workspace on screen", async () => {
  desktop();
  setup({ entry: "/space/w%3A1?s=work" });
  expect(await screen.findByRole("heading", { name: "New tab" })).toBeInTheDocument();
  expect(screen.getByLabelText("Workspace")).toHaveValue("w:1");
});

it("marks a create in flight as busy, not as unavailable", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  server.use(http.post("/api/workspace", async () => { await held; return HttpResponse.json({ ok: false, error: "held" }); }));
  const chat = setup();
  await chat.user.click(await screen.findByRole("button", { name: /^Quick question/ }));
  expect(screen.getByRole("button", { name: "Ask Claude Code" })).not.toHaveAttribute("aria-busy");
  await chat.user.click(await screen.findByRole("button", { name: "Ask Claude Code" }));
  expect(await screen.findByRole("button", { name: "Starting…" })).toHaveAttribute("aria-busy", "true");
  release();
});

it("creates nothing from a read-only device", async () => {
  const { user } = setup({ data: { ...base, device: { enforced: true, authorized: false } as HomeData["device"] } });
  await user.click(await screen.findByRole("button", { name: /^Quick question/ }));
  expect(await screen.findByRole("button", { name: "Ask Claude Code" })).toBeDisabled();
});

describe("newContext", () => {
  it("takes the workspace of the pane or space on screen, else the focused one", () => {
    expect(newContext(base, { paneId: "w:2:p1" })).toEqual({ workspaceId: "w:2" });
    expect(newContext(base, { spaceId: "w:1" })).toEqual({ workspaceId: "w:1" });
    expect(newContext(base, {})).toEqual({ workspaceId: "w:1" });
  });
});

it("with more than one machine, a chat in a new folder starts on the machine picked, its folders read there", async () => {
  const dirSessions: string[] = [];
  const createSessions: string[] = [];
  const pane = { paneId: "w:9:p1", workspaceId: "w:9", workspaceLabel: "new", tabId: "t9", cwd: HOME };
  server.use(
    http.get("/api/dirs", ({ request }) => {
      dirSessions.push(new URL(request.url).searchParams.get("session") ?? "");
      return HttpResponse.json({ path: HOME, home: HOME, entries: ["code"], truncated: false });
    }),
    http.post("/api/workspace", ({ request }) => {
      createSessions.push(new URL(request.url).searchParams.get("session") ?? "");
      return HttpResponse.json({ ok: true, pane });
    }),
  );
  const machines: HomeData["machines"] = [
    { label: "studio", state: "connected" },
    { session: "@build-box", label: "build-box", state: "connected", herd: { bridge: "connected", agents: [], shellPanes: [], workspaces: [], tabs: [] } },
    { session: "@lab", label: "lab", state: "offline", detail: "ssh: connect to host lab port 22: Connection refused" },
  ];
  const { user, router } = setup({ data: { ...base, session: undefined, machines }, entry: "/" });
  await user.click(await screen.findByRole("button", { name: /^In a new folder/ }));
  const picker = within(screen.getByRole("radiogroup", { name: "Machine" }));
  expect(picker.getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["studio", "build-box"]);
  await user.click(picker.getByRole("radio", { name: "build-box" }));
  await user.click(screen.getByRole("button", { name: /^Start/ }));
  await waitFor(() => expect(router.state.location.search).toBe("?s=%40build-box"));
  expect(createSessions).toEqual(["@build-box"]);
  expect(dirSessions).toContain("@build-box");
});

it("with one machine there is nothing to pick", async () => {
  const { user } = setup({ entry: "/" });
  await user.click(await screen.findByRole("button", { name: /^In a new folder/ }));
  expect(screen.queryByRole("radiogroup", { name: "Machine" })).toBeNull();
});
