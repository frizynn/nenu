import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { vi } from "vitest";

import type { AgentView, ProjectThreadView, ProjectView } from "@/lib/types";
import { server } from "@/test/setup";
import { ProjectTasks } from "./project-tasks";

const thread = (id: string, title: string, parentId: string, extra: Partial<ProjectThreadView> = {}): ProjectThreadView =>
  ({ id, title, parentId, role: "worker", status: "open", ...extra });

const project: ProjectView = {
  slug: "acme",
  name: "Acme",
  goal: "Ship the redesign",
  status: "active",
  nodeActions: true,
  threads: [
    thread("t-1", "Hotfix", "root", { paneId: "w:hot", liveStatus: "working" }),
    thread("t-2", "Mobile", "root", { role: "coordinator", paneId: "w:mob", liveStatus: "idle" }),
    thread("t-3", "Landing", "t-2", { paneId: "w:land", liveStatus: "working" }),
    thread("t-4", "Depot", "t-2", { paneId: "w:depot", liveStatus: "blocked" }),
    thread("t-5", "Old plan", "root", { role: "coordinator", status: "resolved" }),
    thread("t-6", "Old step", "t-5", { status: "resolved" }),
  ],
};

function setup(overrides: Partial<ProjectView> = {}, props: { readOnly?: boolean; panes?: Array<{ paneId: string }> } = {}) {
  const { rerender: _rerender, ...rest } = setupWith(overrides, props);
  return rest;
}

/** `panes` are the agent panes, as the route passes them; `rerender` changes the project. */
function setupWith(overrides: Partial<ProjectView> = {}, props: { readOnly?: boolean; panes?: Array<{ paneId: string }> } = {}) {
  const onChanged = vi.fn(async () => {});
  const onOpenPane = vi.fn();
  const panes = (props.panes ?? []) as AgentView[];
  const view = (changes: Partial<ProjectView>) => <ProjectTasks project={{ ...project, ...overrides, ...changes }} panes={panes} session="work" readOnly={props.readOnly ?? false}
    onOpenPane={onOpenPane} onOpenNode={vi.fn()} onChanged={onChanged} now={Date.parse("2026-10-10T14:00:00Z")} />;
  const { rerender } = render(view({}));
  return { onChanged, onOpenPane, user: userEvent.setup(), rerender: (changes: Partial<ProjectView>) => rerender(view(changes)) };
}

/** What `profile list --project acme --json` says, as the bridge passes it on. */
const CHOICES = {
  ok: true,
  available: true,
  defaultProfile: "codex",
  last: { profile: "claude", harness: "claude", model: "opus", reasoningEffort: "high" },
  harnesses: [
    { harness: "claude", profile: "claude", defaultModel: "", efforts: ["low", "medium", "high", "xhigh", "max"] },
    { harness: "codex", profile: "codex", defaultModel: "gpt-5.5", efforts: ["minimal", "low", "medium", "high", "xhigh"] },
  ],
  profiles: [
    { name: "claude", harness: "claude", model: "", reasoningEffort: "", description: "", builtin: true },
    { name: "codex", harness: "codex", model: "", reasoningEffort: "", description: "", builtin: true },
    { name: "deep", harness: "codex", model: "gpt-5.5", reasoningEffort: "xhigh", description: "Hard debugging", builtin: false },
  ],
};

/** Organizations' `open`, held until the test lets it answer. */
function holdOpen() {
  const posted: unknown[] = [];
  let answer: (body: Record<string, unknown>, status?: number) => void = () => {};
  server.use(
    http.get("/api/org/coordinator-options", () => HttpResponse.json(CHOICES)),
    http.post("/api/org/project/open", async ({ request }) => {
      posted.push(await request.json());
      return new Promise((resolve) => { answer = (body, status = 200) => resolve(HttpResponse.json(body, { status })); });
    }),
  );
  return { posted, answer: (body: Record<string, unknown>, status?: number) => answer(body, status) };
}

async function openWindow(user: ReturnType<typeof userEvent.setup>) {
  const coordinator = within(screen.getByRole("region", { name: "Project coordinator" }));
  await user.click(coordinator.getByRole("button", { name: "Start coordinator" }));
  return within(await screen.findByRole("dialog", { name: "Start the coordinator" }));
}

it("asks which harness, model and effort the coordinator starts on, the last ones preselected", async () => {
  const open = holdOpen();
  const { user } = setup();

  const window = await openWindow(user);
  expect(await window.findByRole("radio", { name: "Claude Code" })).toBeChecked();
  expect(window.getByRole("radio", { name: "Codex" })).not.toBeChecked();
  expect(window.getByLabelText("Model")).toHaveValue("opus");
  expect(window.getByLabelText("Effort")).toHaveValue("high");
  expect([...window.getByLabelText<HTMLSelectElement>("Effort").options].map((option) => option.value)).toEqual(["", "low", "medium", "high", "xhigh", "max"]);

  // Another harness: its own default model as the hint, its own effort levels.
  await user.click(window.getByRole("radio", { name: "Codex" }));
  expect(window.getByLabelText("Model")).toHaveValue("");
  expect(window.getByLabelText("Model")).toHaveAttribute("placeholder", "gpt-5.5");
  expect([...window.getByLabelText<HTMLSelectElement>("Effort").options].map((option) => option.value)).toEqual(["", "minimal", "low", "medium", "high", "xhigh"]);
  await user.type(window.getByLabelText("Model"), "gpt-5.5-codex");
  await user.selectOptions(window.getByLabelText("Effort"), "medium");
  await user.click(window.getByRole("button", { name: "Start" }));

  await waitFor(() => expect(open.posted).toEqual([{ project: "acme", harness: "codex", model: "gpt-5.5-codex", effort: "medium" }]));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("says Starting coordinator in the button's place at once, and keeps saying it until the chat opens", async () => {
  const open = holdOpen();
  const { user, rerender } = setupWith();

  const window = await openWindow(user);
  await window.findByRole("radio", { name: "Claude Code" });
  await user.click(window.getByRole("button", { name: "Start" }));
  const coordinator = within(screen.getByRole("region", { name: "Project coordinator" }));
  expect(coordinator.getByRole("button", { name: "Starting coordinator…" })).toBeDisabled();

  // Organizations recorded the coordinator's pane, but no agent runs in it yet: still starting.
  rerender({ coordinator: { paneId: "w1:p9", agent: "shell", liveStatus: "unknown" } });
  expect(within(screen.getByRole("region", { name: "Project coordinator" })).getByRole("button", { name: "Starting coordinator…" })).toBeDisabled();
  expect(screen.queryByText(/shell/)).not.toBeInTheDocument();
  open.answer({ ok: true, message: "started claude as hp-acme" });
});

it("starts on a saved profile as it is, sending only what the person changed", async () => {
  const open = holdOpen();
  const { user } = setup();

  const window = await openWindow(user);
  await user.click(await window.findByRole("button", { name: /^deep/ }));
  expect(window.getByRole("radio", { name: "Codex" })).toBeChecked();
  expect(window.getByLabelText("Model")).toHaveValue("gpt-5.5");
  expect(window.getByLabelText("Effort")).toHaveValue("xhigh");
  await user.selectOptions(window.getByLabelText("Effort"), "high");
  await user.click(window.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(open.posted).toEqual([{ project: "acme", profile: "deep", effort: "high" }]));
});

it("offers a saved profile even when its harness is not allowed on its own, and starts it as it is", async () => {
  const open = holdOpen();
  // As Organizations prints it for an allow-list of `claude` and `deep`: Codex only through `deep`.
  server.use(http.get("/api/org/coordinator-options", () => HttpResponse.json({
    ...CHOICES, last: null, defaultProfile: "claude", harnesses: [CHOICES.harnesses[0]],
    profiles: [CHOICES.profiles[0], CHOICES.profiles[2]],
  })));
  const { user } = setup();

  const window = await openWindow(user);
  await user.click(await window.findByRole("button", { name: /^deep/ }));
  expect(window.getByRole("radio", { name: "Claude Code" })).not.toBeChecked();
  expect(window.getByLabelText("Model")).toHaveValue("gpt-5.5");
  // Codex's levels are not offered for this project, so the profile keeps its own.
  expect(window.queryByLabelText("Effort")).not.toBeInTheDocument();
  await user.click(window.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(open.posted).toEqual([{ project: "acme", profile: "deep" }]));
});

it("starts plainly on the project's default when that is what the window shows", async () => {
  const open = holdOpen();
  server.use(http.get("/api/org/coordinator-options", () => HttpResponse.json({ ...CHOICES, last: null })));
  const { user } = setup();

  const window = await openWindow(user);
  expect(await window.findByRole("radio", { name: "Codex" })).toBeChecked();
  await user.click(window.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(open.posted).toEqual([{ project: "acme" }]));
});

it("refuses a model that is not one name before anything is sent", async () => {
  const open = holdOpen();
  const { user } = setup();

  const window = await openWindow(user);
  await user.clear(await window.findByLabelText("Model"));
  await user.type(window.getByLabelText("Model"), "opus --dangerously-skip-permissions");
  expect(window.getByText("One model name, like opus or gpt-5.5.")).toBeInTheDocument();
  expect(window.getByRole("button", { name: "Start" })).toBeDisabled();
  expect(open.posted).toEqual([]);
});

it("offers Start as the page's large primary, and says it is busy while the coordinator starts", async () => {
  const open = holdOpen();
  const { onChanged, user } = setup();

  const start = within(screen.getByRole("region", { name: "Project coordinator" })).getByRole("button", { name: "Start coordinator" });
  // The shared Button at the page tier (44 high, 16 px, auto width), the 404's Go to Home's size.
  expect(start).toHaveClass("ui-button-lg", "bg-foreground", "text-body");
  const window = await openWindow(user);
  await window.findByRole("radio", { name: "Claude Code" });
  await user.click(window.getByRole("button", { name: "Start" }));
  const starting = within(screen.getByRole("region", { name: "Project coordinator" })).getByRole("button", { name: "Starting coordinator…" });
  expect(starting).toHaveAttribute("aria-busy", "true");
  expect(starting).toBeDisabled();
  open.answer({ ok: true, message: "" });
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
});

it("shows why the coordinator did not start and lets the person try again", async () => {
  const open = holdOpen();
  const { onChanged, user } = setup();

  const window = await openWindow(user);
  await window.findByRole("radio", { name: "Claude Code" });
  await user.click(window.getByRole("button", { name: "Start" }));
  open.answer({ ok: false, error: "profile `claude` is not allowed for the coordinator in `acme`" }, 502);
  const coordinator = within(screen.getByRole("region", { name: "Project coordinator" }));
  expect(await coordinator.findByRole("alert")).toHaveTextContent("profile `claude` is not allowed for the coordinator in `acme`");
  expect(coordinator.getByRole("button", { name: "Start coordinator" })).toBeEnabled();
  expect(onChanged).not.toHaveBeenCalled();
});

it("passes on Organizations' line when the agent still waits on a dialog", async () => {
  const open = holdOpen();
  const message = "codex is not ready yet (agent_not_ready). If it shows a dialog, answer it in pane w1:p3; it primes itself from AGENTS.md.";
  const { onChanged, user } = setup();

  const window = await openWindow(user);
  await window.findByRole("radio", { name: "Claude Code" });
  await user.click(window.getByRole("button", { name: "Start" }));
  open.answer({ ok: true, message });
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  expect(within(screen.getByRole("region", { name: "Project coordinator" })).getByRole("status")).toHaveTextContent(message);
});

it("starts on the project's default, or a profile by name, with an Organizations that cannot choose more", async () => {
  const open = holdOpen();
  server.use(http.get("/api/org/coordinator-options", () => HttpResponse.json({
    ok: true, available: false, defaultProfile: "", last: null, harnesses: [],
    profiles: ["claude", "codex"].map((name) => ({ name, harness: "", model: "", reasoningEffort: "", description: "", builtin: false })),
  })));
  const { user } = setup();

  const window = await openWindow(user);
  const runsOn = await window.findByLabelText("Runs on");
  expect(runsOn).toHaveValue("");
  expect(window.queryByLabelText("Model")).not.toBeInTheDocument();
  await user.selectOptions(runsOn, "claude");
  await user.click(window.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(open.posted).toEqual([{ project: "acme", profile: "claude" }]));
});

it("treats a coordinator pane that is back at its shell as not running, so it can be started", () => {
  setup({ coordinator: { paneId: "w1:p9", agent: "shell", liveStatus: "unknown" } });
  const coordinator = within(screen.getByRole("region", { name: "Project coordinator" }));
  expect(coordinator.getByText("Not running")).toBeInTheDocument();
  expect(coordinator.getByRole("button", { name: "Start coordinator" })).toBeEnabled();
  expect(screen.queryByText(/shell/)).not.toBeInTheDocument();
});

it("replaces a running coordinator through the same window", async () => {
  let posted: unknown;
  server.use(
    http.get("/api/org/coordinator-options", () => HttpResponse.json(CHOICES)),
    http.post("/api/org/coordinator/replace", async ({ request }) => {
      posted = await request.json();
      return HttpResponse.json({ ok: true, message: "stopped 1 coordinator agent(s) and started a new one on codex" });
    }),
  );
  const { user, onChanged } = setup({ coordinator: { paneId: "w:coord", agent: "claude", liveStatus: "idle" } }, { panes: [{ paneId: "w:coord" }] });

  await user.click(screen.getByRole("button", { name: "Replace coordinator" }));
  const window = within(await screen.findByRole("dialog", { name: "Replace the coordinator?" }));
  await user.click(await window.findByRole("radio", { name: "Codex" }));
  await user.click(window.getByRole("button", { name: "Replace" }));
  await waitFor(() => expect(posted).toEqual({ project: "acme", harness: "codex" }));
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
});

it("offers no start, close or new on a read-only device", () => {
  setup({}, { readOnly: true });
  expect(screen.getByText("Not running")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Start coordinator" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^Close/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "New thread" })).not.toBeInTheDocument();
});

it("keeps Start but drops New in a paused project, and New coordinator under upstream herdr-projects", () => {
  const { unmount } = render(<ProjectTasks project={{ ...project, status: "paused" }} panes={[]} readOnly={false} onOpenPane={() => {}} onOpenNode={() => {}} onChanged={() => {}} />);
  expect(screen.getByText("Paused")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Start coordinator" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "New thread" })).not.toBeInTheDocument();
  unmount();

  render(<ProjectTasks project={{ ...project, nodeActions: false }} panes={[]} readOnly={false} onOpenPane={() => {}} onOpenNode={() => {}} onChanged={() => {}} />);
  expect(screen.getByRole("button", { name: "New thread" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "New coordinator" })).not.toBeInTheDocument();
});
