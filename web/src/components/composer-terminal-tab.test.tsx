import { useState, type ComponentProps } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

import { server } from "@/test/setup";
import { clearStatus, useStatus } from "@/lib/status";
import { Composer } from "./composer";

// On a desk the session panel's Terminal tab holds the "Type into terminal" switch under the mirror,
// and the desk's own keyboard is the keys; the + menu keeps the message-side rows only. The composer
// still owns the switch: the tab is a place it draws into while the tab is on screen (agent-chat.tsx
// hands it over as `sessionPanel`). The tab on screen makes the box the terminal (ADR 0114); the
// switch turns that off for as long as the tab stays.

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => clearStatus());

function Status() {
  return <div data-testid="status">{useStatus()?.text ?? ""}</div>;
}

const base: ComponentProps<typeof Composer> = {
  paneId: "w1:p1",
  agent: "claude",
  isShell: false,
  gone: false,
  readOnly: false,
  dialogPresent: false,
  text: "pane output",
  terminalDraft: null,
  rawTerminalDraft: null,
  prefs: { wrap: true, fontSize: 11, rawTerminal: false, tapToFocus: true },
  setWrap: vi.fn(),
  stepFontSize: vi.fn(),
  setRawTerminal: vi.fn(),
  setTapToFocus: vi.fn(),
  onSent: vi.fn(),
  usageControls: <span>usage</span>,
};

/** A desk: the composer beside a stand-in for the panel's Terminal tab, which the buttons put away. */
function Desk(props: Partial<ComponentProps<typeof Composer>>) {
  const [shown, setShown] = useState(true);
  const [paneId, setPaneId] = useState("w1:p1");
  const [gone, setGone] = useState(false);
  const [mirror, setMirror] = useState<HTMLElement | null>(null);
  const [controls, setControls] = useState<HTMLElement | null>(null);
  return <>
    <button type="button" onClick={() => setShown((on) => !on)}>toggle tab</button>
    <button type="button" onClick={() => setPaneId("w1:p2")}>other pane</button>
    <button type="button" onClick={() => setGone(true)}>lock it</button>
    {shown && <section aria-label="Terminal tab"><div ref={setMirror} /><div ref={setControls} /></section>}
    <Composer {...base} {...props} paneId={paneId} gone={gone}
      sessionPanel={{ terminal: shown && mirror && controls ? { mirror, controls } : null, showTerminal: () => setShown(true), report: () => {} }} />
    <Status />
  </>;
}

function renderDesk(props: Partial<ComponentProps<typeof Composer>> = {}) {
  const router = createMemoryRouter([{ path: "/", element: <Desk {...props} /> }]);
  return render(<RouterProvider router={router} />);
}

function renderPhone() {
  const router = createMemoryRouter([{ path: "/", element: <Composer {...base} /> }]);
  render(<RouterProvider router={router} />);
}

function recordKeys(): string[][] {
  const sent: string[][] = [];
  server.use(http.post(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => {
    sent.push(((await request.json()) as { keys: string[] }).keys);
    return HttpResponse.json({ ok: true });
  }));
  return sent;
}

const tab = () => within(screen.getByRole("region", { name: "Terminal tab" }));
const typeSwitch = () => tab().getByRole("switch", { name: /Type into terminal/ });
const armed = () => screen.queryByText(/typing into terminal/i) !== null;

function menuRows(): string[] {
  fireEvent.click(screen.getByRole("button", { name: "Message actions" }));
  const rows = within(screen.getByRole("dialog", { name: "Message actions" })).getAllByRole("button").map((row) => row.textContent?.trim() ?? "")
    .filter(Boolean); // the popover's own close button has no text
  fireEvent.click(screen.getByRole("button", { name: "Message actions" }));
  return rows;
}

describe("Composer on a desk — the session panel's Terminal tab", () => {
  it("keeps the + menu to Files and photos, Commands and Context; the tab holds the switch and no keys", () => {
    renderDesk();
    expect(menuRows()).toEqual(["Files and photos", "Commands", "Context and usage"]);
    expect(typeSwitch()).toHaveAttribute("aria-checked", "true");
    expect(tab().queryByRole("region", { name: "Keys" })).not.toBeInTheDocument();
    expect(tab().queryByRole("button", { name: "Esc" })).not.toBeInTheDocument();
    expect(tab().queryByText(/Quick replies/)).not.toBeInTheDocument();
  });

  it("leaves the phone's + menu as it was", () => {
    renderPhone();
    expect(menuRows()).toEqual(["Files and photos", "Quick replies", "Commands", "Keys", "Type into terminal", "Context and usage"]);
  });

  // What the tray's keys did, the desk's keyboard does once the switch is armed.
  it("sends the desk's keyboard to the pane while armed: Esc, Ctrl chords, arrows, Tab, Shift+Tab, Enter, Backspace, F-keys", async () => {
    const sent = recordKeys();
    renderDesk();
    const field = screen.getByPlaceholderText(/type into the terminal/i);
    const presses: Array<[Parameters<typeof fireEvent.keyDown>[1], string]> = [
      [{ key: "Escape" }, "Escape"],
      [{ key: "c", ctrlKey: true }, "ctrl+c"],
      [{ key: "d", ctrlKey: true }, "ctrl+d"],
      [{ key: "R", ctrlKey: true, shiftKey: true }, "ctrl+shift+r"],
      [{ key: "ArrowUp" }, "Up"],
      [{ key: "ArrowDown" }, "Down"],
      [{ key: "ArrowLeft", altKey: true }, "alt+Left"],
      [{ key: "ArrowRight" }, "Right"],
      [{ key: "Tab" }, "Tab"],
      [{ key: "Tab", shiftKey: true }, "shift+Tab"],
      [{ key: "Enter" }, "Enter"],
      [{ key: "Backspace" }, "Backspace"],
      [{ key: "F5" }, "F5"],
      [{ key: "F12" }, "F12"],
    ];
    for (const [press] of presses) expect(fireEvent.keyDown(field, press)).toBe(false);
    await waitFor(() => expect(sent.flat()).toEqual(presses.map(([, wire]) => wire)));
  });

  // A phone keyboard's Shift (auto-capitals after a full stop) must not turn Return into another key.
  it("keeps Enter and Backspace bare under Shift; Option still rides along", async () => {
    const sent = recordKeys();
    renderDesk();
    const field = screen.getByPlaceholderText(/type into the terminal/i);
    fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(field, { key: "Backspace", shiftKey: true });
    fireEvent.keyDown(field, { key: "Enter", altKey: true });
    await waitFor(() => expect(sent.flat()).toEqual(["Enter", "Backspace", "alt+Enter"]));
  });

  it("leaves Command, and Ctrl+V outside Apple keyboards, to the browser: a paste still reaches the pane as text", async () => {
    const sent = recordKeys();
    renderDesk();
    const field = screen.getByPlaceholderText(/type into the terminal/i);
    expect(fireEvent.keyDown(field, { key: "c", metaKey: true })).toBe(true);
    expect(fireEvent.keyDown(field, { key: "v", ctrlKey: true })).toBe(true);
    fireEvent.change(field, { target: { value: "ls" } });
    await waitFor(() => expect(sent.flat()).toEqual(["l", "s"]));
  });

  it("makes the box the terminal while the tab is on screen, focused; the switch turns it off and it stays off", async () => {
    renderDesk();
    await waitFor(() => expect(armed()).toBe(true));
    expect(typeSwitch()).toHaveAttribute("aria-checked", "true");
    expect(screen.getByPlaceholderText(/type into the terminal/i)).toHaveFocus();
    fireEvent.click(typeSwitch());
    expect(typeSwitch()).toHaveAttribute("aria-checked", "false");
    expect(armed()).toBe(false);
    // Nothing arms it again behind the operator's back while the tab stays.
    fireEvent(document, new Event("visibilitychange"));
    expect(armed()).toBe(false);
    fireEvent.click(typeSwitch());
    expect(armed()).toBe(true);
  });

  it("gives the box back to the chat when the tab leaves, quietly, and the tab coming back is the terminal again", async () => {
    renderDesk();
    await waitFor(() => expect(armed()).toBe(true));
    fireEvent.click(typeSwitch());
    fireEvent.click(screen.getByRole("button", { name: "toggle tab" }));
    await waitFor(() => expect(armed()).toBe(false));
    expect(screen.getByTestId("status")).toHaveTextContent("");
    expect(screen.getByRole("textbox")).toHaveAttribute("placeholder", expect.not.stringMatching(/terminal/i));
    fireEvent.click(screen.getByRole("button", { name: "toggle tab" }));
    await waitFor(() => expect(armed()).toBe(true));
  });

  it("keeps the chat's draft aside while the box is the terminal, and brings it back with the chat", async () => {
    localStorage.clear();
    renderDesk();
    await waitFor(() => expect(armed()).toBe(true));
    fireEvent.click(typeSwitch());
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "half a message" } });
    fireEvent.click(typeSwitch());
    expect(armed()).toBe(true);
    expect(screen.getByPlaceholderText(/type into the terminal/i)).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "toggle tab" }));
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("half a message"));
  });

  it("never carries typing across panes: the next pane's tab arms afresh", async () => {
    const sent = recordKeys();
    renderDesk();
    await waitFor(() => expect(armed()).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "other pane" }));
    await waitFor(() => expect(armed()).toBe(true));
    fireEvent.change(screen.getByPlaceholderText(/type into the terminal/i), { target: { value: "x" } });
    await waitFor(() => expect(sent.flat()).toEqual(["x"]));
  });

  it("disarms when the composer locks, and the switch cannot arm a locked composer", async () => {
    renderDesk();
    await waitFor(() => expect(armed()).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "lock it" }));
    await waitFor(() => expect(armed()).toBe(false));
    expect(typeSwitch()).toBeDisabled();
  });

  it("disarms when the page is hidden, and the tab arms it again on the way back without a notice", async () => {
    renderDesk();
    await waitFor(() => expect(armed()).toBe(true));
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(armed()).toBe(false));
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(armed()).toBe(true));
    expect(screen.getByTestId("status")).toHaveTextContent("");
  });

  it("disarms when a key batch fails, and stays off", async () => {
    server.use(http.post(/\/api\/pane\/[^/]+\/keys$/, () => HttpResponse.json({ ok: false, error: "gone" }, { status: 502 })));
    renderDesk();
    await waitFor(() => expect(armed()).toBe(true));
    fireEvent.change(screen.getByPlaceholderText(/type into the terminal/i), { target: { value: "x" } });
    await waitFor(() => expect(armed()).toBe(false));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(armed()).toBe(false);
  });

  it("is never stored: only the tab on screen arms it", () => {
    const view = renderDesk();
    view.unmount();
    expect(Object.keys(localStorage).join(" ")).not.toMatch(/type|direct|armed/i);
  });
});
