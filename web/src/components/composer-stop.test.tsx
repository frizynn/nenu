import { useState, type ComponentProps } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
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

// A line of its own for Stop alone took 40 px between the thread and the box for the whole turn
// (ADR 0108). Stop sits in the box beside Send instead, and Send keeps its own slot.
it("keeps Stop beside Send in the box while Claude works, draft or not, and draws no line above it", async () => {
  const { user } = setup();
  const stop = stopButton()!;
  expect(stop.closest(".composer-box")).not.toBeNull();
  expect(document.querySelector(".composer-fold")).toBeNull();
  expect(screen.queryByText(/^Working/)).not.toBeInTheDocument();
  // Send keeps its slot, waiting for a draft, so a draft never swaps the target under the thumb.
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  await user.type(screen.getByRole("textbox"), "and the tests");
  expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  expect(screen.getAllByRole("button", { name: "Stop" })).toEqual([stop]);
  await user.click(stop);
  await waitFor(() => expect(bodies).toEqual([{}]));
  await user.clear(screen.getByRole("textbox"));
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
});

it("takes Stop out of the box when the turn ends, and nothing folds", () => {
  const { rerender } = setup();
  expect(stopButton()).toBeVisible();
  rerender({ working: false });
  expect(stopButton()).not.toBeInTheDocument();
  expect(document.querySelector(".composer-fold")).toBeNull();
});

// The chips never take a line between the thread and the box (ADR 0108): they sit in the row under
// it, beside the model, whenever they arrive, so their coming and going moves nothing above the box.
it("draws the chips in the row under the box, never on a line above it", async () => {
  const none = { chips: [], open: null, onOpenChange: vi.fn() };
  const live = { ...none, chips: [{ id: "working" as const, label: "Working", count: 1, content: "bun run build" }] };
  const { rerender } = setup({ working: false, chips: none });
  rerender({ chips: live });
  const chips = await screen.findByRole("group", { name: "Status" });
  const box = document.querySelector(".composer-box")!;
  expect(screen.getByRole("group", { name: "Message tools" })).toContainElement(chips);
  // Under the box in the document, inside the dock the box opens, and nothing of it above the box.
  expect(box.compareDocumentPosition(chips) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(chips.closest(".composer-fold")).toBeNull();
  rerender({ chips: none });
  await waitFor(() => expect(screen.queryByRole("group", { name: "Status" })).not.toBeInTheDocument());
  expect(document.querySelector(".composer-box")).toBe(box);
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

// What asks nothing of you is not a chip (ADR 0108): opened from the ⋯ menu, its panel floats over the
// thread from the box's top edge.
it("never draws a tucked chip, and opens its panel without one", () => {
  const tucked = { id: "working" as const, label: "Done", title: "Finished work", count: 2, content: <p>bun run build</p>, tucked: true };
  const { rerender } = setup({ working: false, chips: { chips: [tucked], open: null, onOpenChange: vi.fn() } });
  expect(screen.queryByRole("group", { name: "Status" })).not.toBeInTheDocument();
  rerender({ chips: { chips: [tucked], open: "working", onOpenChange: vi.fn() } });
  expect(screen.getByRole("dialog", { name: "Finished work" })).toHaveTextContent("bun run build");
  expect(screen.queryByRole("group", { name: "Status" })).not.toBeInTheDocument();
  expect(document.querySelector(".composer-dock")).toContainElement(screen.getByRole("dialog", { name: "Finished work" }));
});

it("when stopping sent Claude's own queue, the new turn gets a Stop of its own", async () => {
  answers = [{ ok: true, pressed: true, queued: "sends", held: 0 }];
  const { user } = setup();
  await user.click(stopButton()!);
  expect(await screen.findByText("Claude stopped and is reading your queued message.")).toBeVisible();
  expect(screen.queryByText("Stopping…")).not.toBeInTheDocument();
  expect(stopButton()).toBeVisible();
});
