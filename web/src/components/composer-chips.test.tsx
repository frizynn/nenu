import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ComponentProps } from "react";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

import { declarations } from "@/test/css-rules";
import { fixtureAgents } from "@/test/handlers";
import { server } from "@/test/setup";
import { AgentChat } from "./agent-chat";

// The row under a chat's composer box: what of its background work needs you and what runs, each a
// chip whose panel opens over the thread; and beside them, where the chat runs.

const agent = { ...fixtureAgents[0]!, status: "working" as const, hasSession: true };
const reviewer = { id: "a1", parentId: "", name: "reviewer", task: "Review the diff", status: "waiting", model: "claude-opus-5-5" };
const explorer = { id: "a2", parentId: "", name: "explorer", task: "Explore the repo", status: "running" };
const subagents = (agents: unknown[]) => ({ available: true, sessionKey: "k", agents, truncated: false });

beforeAll(() => { if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {}; });
beforeEach(() => {
  server.use(
    http.get(/\/api\/pane\/[^/]+\/subagents$/, () => HttpResponse.json(subagents([reviewer, explorer]))),
    http.get(/\/api\/pane\/[^/]+\/activity$/, () => HttpResponse.json({ available: true, sessionKey: "k", workflows: [], tasks: [], artifacts: [] })),
  );
});

function renderChat(overrides: Partial<ComponentProps<typeof AgentChat>> = {}) {
  const props: ComponentProps<typeof AgentChat> = {
    paneId: agent.paneId, agent, agents: [agent], shellPanes: [], tabs: [], text: "", onBack: vi.fn(), onSelect: vi.fn(), ...overrides,
  };
  render(<RouterProvider router={createMemoryRouter([{ path: "/", element: <AgentChat {...props} /> }])} />);
  return { user: userEvent.setup() };
}

const row = () => screen.findByRole("group", { name: "Status" });

it("counts what of the session's background work needs you and what runs", async () => {
  renderChat();
  const chips = within(await row()).getAllByRole("button");
  expect(chips.map((chip) => chip.getAttribute("aria-label"))).toEqual(["Needs you, 1", "Background, 1"]);
});

it("closes the panel with Escape and hands focus back to its chip", async () => {
  const { user } = renderChat();
  const needs = within(await row()).getByRole("button", { name: "Needs you, 1" });
  await user.click(needs);
  within(screen.getByRole("dialog", { name: "Needs you" })).getByRole("button", { name: "Close" }).focus();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "Needs you" })).not.toBeInTheDocument();
  expect(needs).toHaveFocus();
});

/** A viewport whose queries match the ones named, as a phone (none) or a desk ("(min-width: 768px)", …). */
function setMedia(...matching: string[]) {
  window.matchMedia = ((query: string) => ({ matches: matching.includes(query), media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false })) as typeof window.matchMedia;
}
const originalMatchMedia = window.matchMedia;
afterEach(() => { window.matchMedia = originalMatchMedia; });

const LONG_MACHINE = "build-box-in-the-garage-under-the-stairs";

it("in a wide box, says under it which machine the chat runs on", async () => {
  renderChat();
  const place = await screen.findByRole("group", { name: "Message tools" });
  expect(within(place).getByText(window.location.hostname)).toBeInTheDocument();
});

// At 390px the place was cut mid-word ("fix/meli-contr…  r."): a narrow box (a phone) gives the row to
// the model and the chips, and keeps where it runs one tap away, whole. Which form shows is the box's width's to say (composer.css); jsdom lays nothing out, so the
// rule is read and the tap is pressed.
it("in a narrow box, keeps a long machine name behind one tap, never cut in the row", async () => {
  const css = readFileSync(resolve(import.meta.dirname, "../styles/composer.css"), "utf8");
  const narrow = ["@container composer (max-width: 479px)"];
  expect(declarations(css, ".composer-place-tap").display).toBe("none");
  expect(declarations(css, ".composer-place-whole", narrow).display).toBe("none");
  expect(declarations(css, ".composer-place-tap", narrow).display).toBe("flex");
  // After the base rules, which would override it at the same specificity.
  expect(css.lastIndexOf("@container composer (max-width: 479px)")).toBeGreaterThan(css.indexOf(".composer-place-tap { display: none; }"));
  const { user } = renderChat({ machine: LONG_MACHINE });
  const place = await screen.findByRole("group", { name: "Message tools" });
  const where = within(place).getByRole("button", { name: `Where this runs: ${LONG_MACHINE}` });
  expect(where.closest(".composer-place-tap")).not.toBeNull();
  await user.click(where);
  const detail = screen.getByRole("dialog", { name: "Where this runs" });
  expect(within(detail).getByText(LONG_MACHINE)).toBeVisible();
});

it("floats the panel over the thread: the box and the conversation stay where they were", async () => {
  const { user } = renderChat();
  const chips = await row();
  const box = document.querySelector(".composer-box")!;
  const scroller = screen.getByRole("region", { name: "Live conversation" }).querySelector<HTMLElement>(".overflow-y-auto")!;
  scroller.scrollTop = 120;
  // The chips sit under the box, in the row the model is in; nothing of theirs is above the box.
  expect(screen.getByRole("group", { name: "Message tools" })).toContainElement(chips);
  const dock = box.closest(".composer-dock")!;
  const above = dock.previousElementSibling;
  await user.click(within(chips).getByRole("button", { name: "Background, 1" }));
  const panel = screen.getByRole("dialog", { name: "Background" });
  // The panel is an overlay anchored to the box's dock, not a row of the composer.
  expect(panel.closest(".composer-dock")).toBe(dock);
  expect(dock.previousElementSibling).toBe(above);
  expect(document.querySelector(".composer-box")).toBe(box);
  expect(scroller.scrollTop).toBe(120);
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "Background" })).not.toBeInTheDocument();
  expect(dock.previousElementSibling).toBe(above);
  expect(document.querySelector(".composer-box")).toBe(box);
  expect(scroller.scrollTop).toBe(120);
});

it("closes the panel on a press outside it, and leaves focus where the press put it", async () => {
  const { user } = renderChat();
  await user.click(within(await row()).getByRole("button", { name: "Needs you, 1" }));
  expect(screen.getByRole("dialog", { name: "Needs you" })).toBeVisible();
  await user.click(screen.getByRole("textbox"));
  expect(screen.queryByRole("dialog", { name: "Needs you" })).not.toBeInTheDocument();
  expect(screen.getByRole("textbox")).toHaveFocus();
});

it("takes focus into the open panel, keeps Tab inside it, and Escape from its chip closes it too", async () => {
  const { user } = renderChat();
  const needs = within(await row()).getByRole("button", { name: "Needs you, 1" });
  await user.click(needs);
  const panel = screen.getByRole("dialog", { name: "Needs you" });
  expect(panel).toHaveFocus();
  const stops = within(panel).getAllByRole("button").concat(within(panel).queryAllByRole("link"), within(panel).queryAllByRole("checkbox"));
  for (let i = 0; i < stops.length + 2; i++) {
    await user.tab();
    expect(panel.contains(document.activeElement)).toBe(true);
  }
  await user.tab({ shift: true });
  expect(panel.contains(document.activeElement)).toBe(true);
  // Escape wherever focus sits, the chip included.
  needs.focus();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "Needs you" })).not.toBeInTheDocument();
  expect(needs).toHaveFocus();
});

it("on a phone, Back closes the panel and stays on the chat; its own ✕ steps back over the entry it took", async () => {
  setMedia("(pointer: coarse)");
  const back = vi.spyOn(window.history, "back");
  const { user } = renderChat();
  const needs = within(await row()).getByRole("button", { name: "Needs you, 1" });
  const depth = window.history.length;
  await user.click(needs);
  expect(window.history.length).toBe(depth + 1);
  // The browser's Back: the entry under the panel's is the chat's own.
  const { nenuChipPanel: _, ...chat } = window.history.state as Record<string, unknown>;
  act(() => {
    window.history.replaceState(chat, "");
    window.dispatchEvent(new PopStateEvent("popstate", { state: chat }));
  });
  expect(screen.queryByRole("dialog", { name: "Needs you" })).not.toBeInTheDocument();
  expect(needs).toHaveFocus();
  expect(screen.getByRole("textbox")).toBeInTheDocument();
  expect(back).not.toHaveBeenCalled();
  // Opened again and closed with ✕: the panel takes its entry back with it.
  await user.click(needs);
  back.mockImplementation(() => {});
  await user.click(within(screen.getByRole("dialog", { name: "Needs you" })).getByRole("button", { name: "Close" }));
  expect(back).toHaveBeenCalledTimes(1);
  back.mockRestore();
});

// With nothing running, the pages the session published still open unfolded: the menu row says
// Published, and that is what the panel opens on (ADR 0108).
it("opens Published from the ⋯ menu on its pages", async () => {
  server.use(http.get(/\/api\/pane\/[^/]+\/activity$/, () => HttpResponse.json({ available: true, sessionKey: "k", workflows: [], tasks: [],
    artifacts: [{ id: "art_1", url: "https://claude.ai/code/artifact/00000000-test", title: "Cart redesign", icon: "canvas", version: "1-a", at: Date.now() }] })));
  server.use(http.get(/\/api\/pane\/[^/]+\/subagents$/, () => HttpResponse.json(subagents([]))));
  const { user } = renderChat();
  await user.click(screen.getByRole("button", { name: "Conversation actions" }));
  await user.click(await screen.findByRole("button", { name: "Published · 1" }));
  const panel = screen.getByRole("dialog", { name: "Published" });
  expect(within(panel).getByRole("button", { name: "Published (1)" })).toHaveAttribute("aria-expanded", "true");
  expect(within(panel).getByRole("link", { name: /Cart redesign/ })).toBeVisible();
});

it("keeps every chip still: nothing in the row animates on its own", async () => {
  renderChat();
  const chips = await row();
  await act(async () => {});
  expect(chips.querySelectorAll('[class*="animate-"]')).toHaveLength(0);
});

// Stop took a line of its own above the box (ADR 0108): it sits in the box, and the line holds chips only.
it("keeps Stop in the box beside Send, never on the chips' line", async () => {
  renderChat();
  const chips = await row();
  const stop = screen.getByRole("button", { name: "Stop" });
  expect(stop.closest(".composer-box")).not.toBeNull();
  expect(chips.contains(stop)).toBe(false);
});

it("draws no row for a chat with nothing in the background", async () => {
  server.use(http.get(/\/api\/pane\/[^/]+\/subagents$/, () => HttpResponse.json(subagents([]))));
  renderChat();
  await screen.findByRole("textbox");
  await act(async () => {});
  expect(screen.queryByRole("group", { name: "Status" })).not.toBeInTheDocument();
});
