import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "@/test/setup";
import fixture from "./activity.fixture.json";
import type { ActivityResponse, ActivityWorkflow, WorkflowDetailResponse } from "@/lib/activity";
import { ActivityPanel } from "./activity-panel";
import { ArtifactList } from "./artifact-list";
import { RunningWorkflows } from "./running-workflows";
import { WorkflowCard } from "./workflow-card";
import { WorkflowAgentList, WorkflowDetail } from "./workflow-detail";

// The fixture is what the bridge reader answers for this repo's own (redacted) Claude session:
// bridge/test-support/claude-activity run through bridge/claude-activity.ts.
const list = fixture.list as ActivityResponse & { available: true };
const detail = fixture.detail as WorkflowDetailResponse;
const now = fixture.now;
const running = list.workflows.find((w) => w.status === "running")!;
const finished = list.workflows.find((w) => w.status === "completed")!;

describe("WorkflowCard", () => {
  test("a running run shows progress without totals that only exist at the end", () => {
    const onOpen = vi.fn();
    render(<WorkflowCard workflow={running} now={now} onOpen={onOpen} />);
    const card = screen.getByRole("region", { name: "Workflow nenu-wave" });
    expect(within(card).getByText("running")).toBeInTheDocument();
    expect(within(card).getByText("0 of 3 agents")).toBeInTheDocument();
    expect(within(card).queryByText(/tool calls/)).toBeNull();
    expect(within(card).getAllByText("Bash · Keep waiting for gate")).toHaveLength(3);
    expect(within(card).getByText(/Claude gets the result when it finishes/)).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: /View workflow/ }));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  test("a finished run shows its totals and phases", () => {
    render(<WorkflowCard workflow={finished} now={now} />);
    expect(screen.getByText("done")).toBeInTheDocument();
    expect(screen.getByText("114 tool calls")).toBeInTheDocument();
    expect(screen.getByText("17m 23s")).toBeInTheDocument();
    expect(screen.getByText("Research")).toBeInTheDocument();
    expect(screen.getByText("2/2")).toBeInTheDocument();
  });
});

describe("ActivityPanel", () => {
  test("groups running work, finished work and artifacts", () => {
    const onOpenWorkflow = vi.fn();
    render(<ActivityPanel data={list} now={now} onOpenWorkflow={onOpenWorkflow} />);
    expect(screen.getByRole("button", { name: /Running/ })).toHaveTextContent("Running2");
    expect(screen.getByText("impl:B1")).toBeInTheDocument();
    fireEvent.click(screen.getByText("impl:B3"));
    expect(onOpenWorkflow).toHaveBeenCalledWith("wf_fe5d5046-9d2", "a5ecc06a0363074c3");
    expect(screen.getByText("Typecheck bridge through the gate")).toBeInTheDocument();
    expect(screen.getByText("failed · exit 144")).toBeInTheDocument();
    fireEvent.click(screen.getByText("nenu-workflows-view-design"));
    expect(onOpenWorkflow).toHaveBeenLastCalledWith("wf_58bd2e6c-e80");
    expect(screen.getByRole("link", { name: /Rediseño Nenu sobre Herdr/ })).toHaveAttribute("href", "https://claude.ai/code/artifact/00000000-redacted");
  });

  test("the filters narrow what is listed", () => {
    render(<ActivityPanel data={list} now={now} onOpenWorkflow={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /^Tasks/ }));
    expect(screen.getByRole("button", { name: /^Tasks/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("nenu-wave")).toBeNull();
    expect(screen.getByText("Run CI gates: fmt, clippy, tests, release build")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Artifacts/ }));
    expect(screen.queryByText("Run CI gates: fmt, clippy, tests, release build")).toBeNull();
    expect(screen.getByRole("link", { name: /Rediseño/ })).toBeInTheDocument();
  });

  test("a command with output opens it", () => {
    const onOpenTask = vi.fn();
    render(<ActivityPanel data={list} now={now} onOpenWorkflow={() => {}} onOpenTask={onOpenTask} />);
    fireEvent.click(screen.getByRole("button", { name: "Output of Typecheck bridge through the gate" }));
    expect(onOpenTask).toHaveBeenCalledWith("b3f8meozt");
    expect(screen.queryByRole("button", { name: "Output of F1 gate progress" })).toBeNull();
  });

  test("says why a pane has no activity", () => {
    const { rerender } = render(<ActivityPanel data={{ available: false, reason: "unsupported" }} now={now} onOpenWorkflow={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent("Claude Code sessions");
    rerender(<ActivityPanel data={{ available: true, sessionKey: "k", workflows: [], tasks: [], artifacts: [], truncated: false }} now={now} onOpenWorkflow={() => {}} />);
    expect(screen.getByText("Nothing running in the background.")).toBeInTheDocument();
  });

  test("a failed refresh keeps the last list and offers a retry", () => {
    const onRetry = vi.fn();
    render(<ActivityPanel data={list} stale now={now} onOpenWorkflow={() => {}} onRetry={onRetry} />);
    expect(screen.getByText("Couldn’t refresh. Showing last known activity.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe("ArtifactList", () => {
  test("renders only claude.ai links, opened in a new tab without an opener", () => {
    render(<ArtifactList artifacts={[...list.artifacts, { id: "x", url: "https://evil.example/a", title: "Evil" }]} />);
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.queryByText("Evil")).toBeNull();
  });
});

describe("WorkflowDetail", () => {
  test("shows totals, phases and a timeline row per agent", () => {
    render(<WorkflowDetail workflow={detail.workflow} results={detail.results} now={now} />);
    expect(screen.getByRole("heading", { name: "nenu-workflows-view-design" })).toBeInTheDocument();
    expect(screen.getByText("3/3")).toBeInTheDocument();
    expect(screen.getByText("440k")).toBeInTheDocument();
    for (const label of ["research:claude-data", "research:nenu-today", "design:activity"]) {
      expect(screen.getByRole("button", { name: new RegExp(label) })).toBeInTheDocument();
    }
  });

  test("selecting an agent shows its returned value laid out generically", () => {
    const onSelectAgent = vi.fn();
    const { rerender } = render(<WorkflowDetail workflow={detail.workflow} results={detail.results} now={now} onSelectAgent={onSelectAgent} />);
    fireEvent.click(screen.getByRole("button", { name: /research:claude-data/ }));
    expect(onSelectAgent).toHaveBeenCalledWith("a62346b3ec68b1323");
    rerender(<WorkflowDetail workflow={detail.workflow} results={detail.results} now={now} selectedAgentId="a62346b3ec68b1323" onSelectAgent={onSelectAgent} />);
    const panel = screen.getByRole("complementary", { name: "Agent research:claude-data" });
    expect(within(panel).getByText("Facts")).toBeInTheDocument();
    expect(within(panel).getAllByRole("button", { name: /more$/ }).length).toBeGreaterThan(0);
    expect(within(panel).getByRole("button", { name: /Copy result/ })).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "Close agent" }));
    expect(onSelectAgent).toHaveBeenLastCalledWith(null);
  });

  test("a running agent without a result says what it is doing", () => {
    const wf: ActivityWorkflow = running;
    render(<WorkflowDetail workflow={wf} now={now} selectedAgentId="a2755e6a129ea042e" />);
    expect(screen.getByText("Still working · Bash · Keep waiting for gate.")).toBeInTheDocument();
    expect(screen.getByText("Now " + new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }))).toBeInTheDocument();
  });
});

describe("WorkflowAgentList", () => {
  test("lists each agent with what it is doing and its duration, and selects on tap", () => {
    const onSelectAgent = vi.fn();
    render(<WorkflowAgentList workflow={running} now={now} onSelectAgent={onSelectAgent} />);
    const rows = screen.getAllByRole("button");
    expect(rows).toHaveLength(running.phases.flatMap((p) => p.agents).length);
    expect(screen.getAllByText("Bash · Keep waiting for gate").length).toBeGreaterThan(0);
    fireEvent.click(rows[0]!);
    expect(onSelectAgent).toHaveBeenCalledWith(running.phases[0]!.agents[0]!.id);
  });
});

describe("RunningWorkflows", () => {
  test("shows a card per running workflow in the chat, and View workflow opens it full screen", async () => {
    server.use(
      http.get(/\/api\/pane\/[^/]+\/activity$/, ({ request }) =>
        HttpResponse.json(new URL(request.url).searchParams.get("run") ? detail : list),
      ),
    );
    render(<RunningWorkflows paneId="w1:p1" />);
    const card = await screen.findByRole("region", { name: "Workflow nenu-wave" });
    expect(screen.getAllByRole("region", { name: /^Workflow / })).toHaveLength(list.workflows.filter((w) => w.status === "running").length);
    expect(screen.queryByRole("region", { name: `Workflow ${finished.name}` })).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: /View workflow/ }));
    const dialog = await screen.findByRole("dialog", { name: detail.workflow.name });
    fireEvent.click(within(dialog).getByRole("button", { name: "Back" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("renders nothing when no workflow runs", async () => {
    let served = false;
    server.use(
      http.get(/\/api\/pane\/[^/]+\/activity$/, () => {
        served = true;
        return HttpResponse.json({ ...list, workflows: [finished] });
      }),
    );
    const { container } = render(<RunningWorkflows paneId="w1:p1" />);
    await waitFor(() => expect(served).toBe(true));
    expect(container).toBeEmptyDOMElement();
  });
});
