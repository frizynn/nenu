import { useState, type ComponentProps } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { clearStatus } from "@/lib/status";
import { server } from "@/test/setup";
import type { InterruptResponse } from "@/lib/types";
import { Composer } from "./composer";
import { StatusArea } from "./status-area";

// Stop (ADR 0066), as the operator meets it in the composer on a phone or a desk.

let answers: InterruptResponse[] = [];
let bodies: unknown[] = [];
beforeEach(() => {
  clearStatus();
  bodies = [];
  answers = [];
  server.use(
    http.post(/\/api\/pane\/[^/]+\/interrupt$/, async ({ request }) => {
      bodies.push(await request.json());
      return HttpResponse.json(answers.shift() ?? { ok: true, pressed: true, queued: null, held: 0 });
    }),
  );
});

type Props = ComponentProps<typeof Composer>;

function setup(overrides: Partial<Props> = {}) {
  const props: Props = {
    paneId: "w1:p1", session: "work", agent: "claude", isShell: false, working: true,
    gone: false, readOnly: false, disconnected: false, nativeWorkbench: false, dialogPresent: false,
    text: "pane output", terminalDraft: null, rawTerminalDraft: null,
    prefs: { wrap: true, fontSize: 11, rawTerminal: false, tapToFocus: true },
    setWrap: vi.fn(), stepFontSize: vi.fn(), setRawTerminal: vi.fn(), setTapToFocus: vi.fn(),
    onSent: vi.fn(), ...overrides,
  };
  // The same mounted composer across prop changes, as a poll would deliver them.
  let update: (next: Partial<Props>) => void = () => {};
  function Host() {
    const [next, setNext] = useState<Partial<Props>>({});
    update = setNext;
    return <><Composer {...props} {...next} /><StatusArea /></>;
  }
  render(<RouterProvider router={createMemoryRouter([{ path: "/", element: <Host /> }])} />);
  return { user: userEvent.setup(), rerender: (next: Partial<Props>) => act(() => update(next)) };
}

const stopButton = () => screen.queryByRole("button", { name: "Stop" });

it("keeps Stop in one place on the Working row while Claude works, draft or not; the round button is only Send", async () => {
  const { user } = setup();
  const row = screen.getByRole("group", { name: "Agent working" });
  expect(within(row).getByText(/^Working/)).toBeVisible();
  const stop = within(row).getByRole("button", { name: "Stop" });
  // Send keeps its slot, waiting for a draft, so nothing else ever sits under the thumb there.
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  await user.type(screen.getByRole("textbox"), "and the tests");
  expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  // The same Stop, in the same row: typing never moves it.
  expect(screen.getByRole("group", { name: "Agent working" })).toBe(row);
  expect(screen.getAllByRole("button", { name: "Stop" })).toEqual([stop]);
  await user.click(stop);
  await waitFor(() => expect(bodies).toEqual([{}]));
  await user.clear(screen.getByRole("textbox"));
  expect(screen.getByRole("group", { name: "Agent working" })).toBe(row);
});

// The row comes and goes with every turn; appearing or vanishing at once jerked the thread 40 px.
it("folds the Working row shut when the turn ends, out of reach while it goes", async () => {
  const { rerender } = setup();
  const row = screen.getByRole("group", { name: "Agent working" });
  rerender({ working: false });
  // Still on screen while it folds, but nothing in it can be pressed or announced.
  expect(row).toBeInTheDocument();
  expect(row.closest("[inert]")).not.toBeNull();
  expect(stopButton()).not.toBeInTheDocument();
  await waitFor(() => expect(row).not.toBeInTheDocument());
});

it("stops once: the second tap meets 'Stopping…', and idle hands Send back", async () => {
  const { user, rerender } = setup();
  await user.click(stopButton()!);
  expect(await screen.findByText("Stopping…")).toBeVisible();
  expect(stopButton()).not.toBeInTheDocument();
  await user.click(screen.getByText("Stopping…"));
  expect(bodies).toEqual([{}]);
  rerender({ working: false });
  await waitFor(() => expect(screen.queryByText("Stopping…")).not.toBeInTheDocument());
  expect(stopButton()).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
});

it("Esc in the empty composer stops; Esc over a draft leaves the turn alone", async () => {
  const { user } = setup();
  const box = screen.getByRole("textbox");
  await user.type(box, "draft");
  await user.keyboard("{Escape}");
  expect(bodies).toEqual([]);
  await user.clear(box);
  await user.keyboard("{Escape}");
  await waitFor(() => expect(bodies).toEqual([{}]));
});

it("asks before a Stop that would send Claude's own queue, and the next tap confirms", async () => {
  answers = [{ ok: false, code: "confirm_required", error: "Claude sends its queued message as soon as it stops. Tap Stop again to stop anyway." }];
  const { user } = setup();
  await user.click(stopButton()!);
  expect(await screen.findByText(/sends its queued message as soon as it stops/)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Really stop?" }));
  await waitFor(() => expect(bodies).toEqual([{}, { confirm: true }]));
});

it("says what happened to queued messages", async () => {
  answers = [{ ok: true, pressed: true, queued: null, held: 2 }];
  const { user } = setup();
  await user.click(stopButton()!);
  expect(await screen.findByText("2 messages queued in Nenu wait until you send them.")).toBeVisible();
});

it("offers Stop right after a message goes out, before Herdr reports the turn", async () => {
  server.use(http.post(/\/api\/pane\/[^/]+\/send$/, async () => HttpResponse.json({ ok: true, requestId: "r", ack: "submitted" })));
  const { user } = setup({ working: false });
  expect(stopButton()).not.toBeInTheDocument();
  await user.type(screen.getByRole("textbox"), "fix the build");
  await user.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByRole("button", { name: "Stop" })).toBeVisible();
});

it("a refused Stop gives the button back with the reason", async () => {
  answers = [{ ok: false, code: "not_running", error: "Claude isn't running a turn Nenu can stop." }];
  const { user } = setup();
  await user.click(stopButton()!);
  expect(await screen.findByText("Claude isn't running a turn Nenu can stop.")).toBeVisible();
  expect(screen.queryByText("Stopping…")).not.toBeInTheDocument();
  expect(stopButton()).toBeVisible();
});

it.each([
  ["a shell", { agent: null, isShell: true }],
  ["an agent without a measured key", { agent: "pi" }],
  ["a read-only device", { readOnly: true }],
] as const)("offers no Stop to %s", (_name, props) => {
  setup(props);
  expect(stopButton()).not.toBeInTheDocument();
});

it("a Stop the bridge answers after the pane went idle does not leave 'Stopping…' up", async () => {
  const { user } = setup({ working: false });
  // Sent, then stopped before this view ever saw the turn running.
  server.use(http.post(/\/api\/pane\/[^/]+\/send$/, async () => HttpResponse.json({ ok: true, requestId: "r", ack: "submitted" })));
  await user.type(screen.getByRole("textbox"), "go");
  await user.click(screen.getByRole("button", { name: "Send" }));
  await user.click(await screen.findByRole("button", { name: "Stop" }));
  await act(async () => {});
  await waitFor(() => expect(screen.queryByText("Stopping…")).not.toBeInTheDocument());
  expect(stopButton()).not.toBeInTheDocument();
});

// Beside the chips the line stays for them: when the turn ends only Stop leaves, at once, and nothing folds.
it("shares the line with the chips, and when the turn ends only Stop leaves it", async () => {
  const chips = { chips: [{ id: "working" as const, label: "Working", count: 1, content: <p>bun run build</p> }], open: null, onOpenChange: vi.fn() };
  const { rerender } = setup({ nativeWorkbench: true, chips });
  const status = screen.getByRole("group", { name: "Status" });
  expect(screen.getByRole("group", { name: "Agent working" }).parentElement).toBe(status.parentElement);
  rerender({ working: false });
  expect(stopButton()).not.toBeInTheDocument();
  expect(screen.queryByRole("group", { name: "Agent working" })).not.toBeInTheDocument();
  expect(screen.getByRole("group", { name: "Status" })).toBe(status);
  expect(status.closest("[inert]")).toBeNull();
});

it("when stopping sent Claude's own queue, the new turn gets a Stop of its own", async () => {
  answers = [{ ok: true, pressed: true, queued: "sends", held: 0 }];
  const { user } = setup();
  await user.click(stopButton()!);
  expect(await screen.findByText("Claude stopped and is reading your queued message.")).toBeVisible();
  expect(screen.queryByText("Stopping…")).not.toBeInTheDocument();
  expect(stopButton()).toBeVisible();
});

it("leaves the elapsed time to the conversation's own live turn, so the row above the box holds only Stop", () => {
  setup({ nativeWorkbench: true });
  const row = screen.getByRole("group", { name: "Agent working" });
  expect(within(row).getByRole("button", { name: "Stop" })).toBeVisible();
  expect(within(row).queryByText(/^Working/)).not.toBeInTheDocument();
});
