import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

import { server } from "@/test/setup";
import { loadAgent, loadPermission, saveAgent, savePermission } from "@/lib/spawn";
import { StartAgent } from "./start-agent";

const starts: Array<{ url: string; body: unknown }> = [];

beforeEach(() => {
  localStorage.clear();
  starts.length = 0;
  server.use(
    http.post("/api/pane/:paneId/start", async ({ request }) => {
      starts.push({ url: request.url, body: await request.json() });
      return HttpResponse.json({ ok: true });
    }),
  );
});

function renderStart() {
  const router = createMemoryRouter([{ path: "/", element: <><StartAgent paneId="w1:p1" session="work" disabled={false} ready /><pre>terminal</pre></>, loader: () => null }]);
  render(<RouterProvider router={router} />);
}

const permissions = () => screen.getByRole("radiogroup", { name: "Permissions" });
const options = () => screen.getByRole("button", { name: "Agent and permissions" });
const unfold = async () => userEvent.click(await screen.findByRole("button", { name: "Agent and permissions" }));

describe("StartAgent", () => {
  it("folds into one row that starts the remembered agent and level in one tap", async () => {
    saveAgent("codex");
    savePermission("codex", "auto");
    renderStart();
    const start = await screen.findByRole("button", { name: "Start Codex · Auto" });
    expect(options()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    await userEvent.click(start);
    await waitFor(() => expect(starts.map((s) => s.body)).toEqual([{ agent: "codex", permission: "auto" }]));
  });

  it("never folds a dangerous level into the row", async () => {
    savePermission("claude", "bypass");
    renderStart();
    expect(await screen.findByRole("button", { name: "Start Claude Code · Ask" })).toBeInTheDocument();
  });

  it("unfolds New's agent and permission choice, on each agent's remembered level", async () => {
    saveAgent("codex");
    savePermission("claude", "acceptEdits");
    savePermission("codex", "auto");
    renderStart();
    await unfold();
    expect(options()).toHaveAttribute("aria-expanded", "true");
    const agents = screen.getByRole("radiogroup", { name: "Agent" });
    expect(within(agents).getAllByRole("radio").map((r) => r.textContent)).toEqual(["Claude Code", "Codex"]);
    expect(within(agents).getByRole("radio", { name: "Codex" })).toHaveAttribute("aria-checked", "true");
    expect(within(permissions()).getByRole("radio", { name: "Auto" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(within(agents).getByRole("radio", { name: "Claude Code" }));
    expect(within(permissions()).getByRole("radio", { name: "Accept edits" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("button", { name: "Start Claude Code · Accept edits" })).toBeInTheDocument();
  });

  it("folds again on a tap outside it or on Escape", async () => {
    renderStart();
    await unfold();
    fireEvent.pointerDown(screen.getByText("terminal"));
    expect(screen.queryByRole("radiogroup", { name: "Agent" })).not.toBeInTheDocument();
    expect(options()).toHaveAttribute("aria-expanded", "false");
    await unfold();
    fireEvent.pointerDown(permissions());
    expect(screen.getByRole("radiogroup", { name: "Agent" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("radiogroup", { name: "Agent" })).not.toBeInTheDocument();
  });

  it("names the chosen level and never argv, remembers it the way New does, and folds when it starts", async () => {
    renderStart();
    await unfold();
    await userEvent.click(screen.getByRole("radio", { name: "Plan" }));
    await userEvent.click(screen.getByRole("button", { name: "Start Claude Code · Plan" }));
    await waitFor(() => expect(starts).toHaveLength(1));
    expect(new URL(starts[0]!.url).pathname).toBe("/api/pane/w1%3Ap1/start");
    expect(new URL(starts[0]!.url).searchParams.get("session")).toBe("work");
    expect(starts[0]!.body).toEqual({ agent: "claude", permission: "plan" });
    expect(loadPermission("claude")).toBe("plan");
    expect(loadAgent()).toBe("claude");
    expect(screen.queryByRole("radiogroup", { name: "Agent" })).not.toBeInTheDocument();
  });

  it("starts Codex with its own levels", async () => {
    renderStart();
    await unfold();
    await userEvent.click(screen.getByRole("radio", { name: "Codex" }));
    expect(within(permissions()).getAllByRole("radio").map((r) => r.textContent)).toEqual(["Ask", "Auto", "Full access"]);
    await userEvent.click(screen.getByRole("radio", { name: "Full access" }));
    expect(screen.getByText(/No sandbox and never asks/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Start Codex · Full access" }));
    await waitFor(() => expect(starts.map((s) => s.body)).toEqual([{ agent: "codex", permission: "full" }]));
  });

  it("says why a start failed under the folded row", async () => {
    server.use(http.post("/api/pane/:paneId/start", () => HttpResponse.json({ error: "timed out waiting for agent startup" }, { status: 409 })));
    renderStart();
    await userEvent.click(await screen.findByRole("button", { name: "Start Claude Code · Ask" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("timed out waiting for agent startup Check the terminal before retrying.");
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
  });
});
