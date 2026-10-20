import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import fixture from "./activity.fixture.json";
import type { ActivityResponse, ActivityWorkflow, WorkflowDetailResponse } from "@/lib/activity";
import { ArtifactList } from "./artifact-list";
import { WorkflowAgentList, WorkflowDetail } from "./workflow-detail";

// The fixture is what the bridge reader answers for this repo's own (redacted) Claude session:
// bridge/test-support/claude-activity run through bridge/claude-activity.ts.
const list = fixture.list as ActivityResponse & { available: true };
const detail = fixture.detail as WorkflowDetailResponse;
const now = fixture.now;
const running = list.workflows.find((w) => w.status === "running")!;

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
  test("shows totals, phases and a row per agent", () => {
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
