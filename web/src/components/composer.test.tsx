import { useState } from "react";
import type { ComponentProps } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

import { clearStatus, useStatus } from "@/lib/status";
import { isReloadHeld, __resetReloadGuard } from "@/lib/reload-guard";
import { loadDraft, saveDraft } from "@/lib/drafts";
import { listLocalSends, localSendScope } from "@/lib/local-sends";
import { server } from "@/test/setup";
import { recordReply } from "@/test/handlers";
import type { SendOutcome, SendRequest, SendStage } from "@/lib/types";
import { Composer, type ComposerControl } from "./composer";
import { ActionGroups } from "./conversation-actions";

// The composer's secondary controls are reached from the pane header's ⋯ menu. These tests render
// the same menu rows beside the composer, without the popover, so every control is one tap away.
function ComposerWithMenu(props: ComponentProps<typeof Composer>) {
  const [controls, setControls] = useState<ComposerControl[]>([]);
  return <>
    <div data-testid="controls"><ActionGroups groups={[{ label: "Controls", actions: controls }]} onRun={(run) => run()} /></div>
    <Composer {...props} onControlsChange={setControls} />
  </>;
}
/** A menu row by name — the Keys tray has its own "Keys" tab, so scope to the menu. */
const control = (name: string | RegExp) => within(screen.getByTestId("controls")).getByRole("button", { name });

// A guarded send is TWO reply calls: type (submit:false), then — once the text is verified on the
// input line — submit-only (empty text). Overriding the reply handler therefore has to keep the fake
// pane's input line honest via recordReply, or the verification poll never passes. Helper so each
// override says what it is asserting rather than repeating the protocol.
function replyHandler(onTyped: (text: string) => void, onSubmit?: () => void) {
  return http.post(/\/api\/pane\/[^/]+\/reply$/, async ({ request }) => {
    const body = (await request.json()) as { text: string; submit?: boolean };
    recordReply(body);
    if (body.submit) onSubmit?.();
    else onTyped(body.text);
    return HttpResponse.json({ ok: true });
  });
}

// The bridge's words for the refusals these tests stage (bridge/guarded-send.ts).
const NO_BOX = "The agent's input box isn't on screen — a menu or dialog is probably up. Nothing was typed.";
const NO_ECHO = "That's a password prompt — it shows nothing as you type, so Send can never confirm the text arrived. Nothing was typed.";
const NOT_SUBMITTED = "Typed into the pane but not submitted — check the pane before resending.";
const UNSEEN = "Your message wasn't seen in the agent's input box. Nothing was submitted; it may still be typed, so check Terminal before retrying.";
const MAYBE_SENT = "The earlier try of this message is no longer in the input box, so it may already have been sent. Nothing was typed; check Terminal.";

const accepted = (body: SendRequest): SendOutcome => ({ ok: true, requestId: body.requestId, ack: "submitted" });
function refusal(body: SendRequest, stage: SendStage, error: string, textDelivered: boolean, code?: "not_ready" | "busy"): SendOutcome {
  return { ok: false, requestId: body.requestId, stage, error, textDelivered, ...(code ? { code } : {}) };
}

/**
 * POST /send as the bridge answers it, ledger included (bridge/guarded-send.ts WriteLedger): a success
 * is replayed for its request id, a failure runs again and is handed the earlier answer, and the same
 * id with another payload is a conflict. `answer` decides each run that is not a replay.
 */
function serveSend(answer: (body: SendRequest, prior: SendOutcome | null) => SendOutcome | Promise<SendOutcome> = accepted) {
  const requests: SendRequest[] = [];
  const ledger = new Map<string, { fingerprint: string; outcome: SendOutcome }>();
  server.use(
    http.post(/\/api\/pane\/[^/]+\/send$/, async ({ request }) => {
      const body = (await request.json()) as SendRequest;
      requests.push(body);
      const fingerprint = JSON.stringify([body.text, body.paste === true, body.expectedPrompt ?? null]);
      const entry = ledger.get(body.requestId);
      if (entry && entry.fingerprint !== fingerprint) return new HttpResponse("request_id payload mismatch", { status: 409 });
      if (entry?.outcome.ok) return HttpResponse.json({ ...entry.outcome, replayed: true });
      const outcome = await answer(body, entry?.outcome ?? null);
      ledger.set(body.requestId, { fingerprint, outcome });
      if (outcome.ok) recordReply({ text: body.text, submit: true });
      return HttpResponse.json(outcome, { status: outcome.ok ? 200 : 409 });
    }),
  );
  return requests;
}

/** Every write the composer puts on the wire, by route: send, reply, keys, queue. */
function watchWrites(): string[] {
  const writes: string[] = [];
  server.events.on("request:start", ({ request }) => {
    const route = new URL(request.url).pathname.match(/^\/api\/pane\/[^/]+\/(send|reply|keys|queue)$/)?.[1];
    if (route && request.method === "POST") writes.push(route);
  });
  return writes;
}
afterEach(() => server.events.removeAllListeners());

// Composer owns the send flow (draft → api.sendReply → clear/error) plus the destructive-command
// two-tap guard. It uses useRevalidator, so it needs a data router like AgentChat's tests.

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => clearStatus());

function renderComposer(overrides: Partial<ComponentProps<typeof Composer>> = {}) {
  const props: ComponentProps<typeof Composer> = {
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
    ...overrides,
  };
  const router = createMemoryRouter([{ path: "/", element: <ComposerWithMenu {...props} /> }]);
  render(<RouterProvider router={router} />);
  return props;
}

/**
 * Wait for a send that can never verify to reach its terminal `stalled` outcome.
 *
 * A reply handler that doesn't `recordReply` leaves the fake pane's input line empty, so the
 * type-then-verify guard polls POLL_ATTEMPTS × POLL_DELAY_MS (~2.8s) and only then reports. That
 * report is a `setStatus` on a MODULE-SCOPED singleton, which outlives the test that started it: a
 * test that returns first hands its stall to whichever test is running ~2.8s later, past this file's
 * `clearStatus()`, where it reads as that test's own failure. Every test that fires a send it never
 * lets verify ends with this. Needs a status sentinel in the render (`renderComposerWithStatus`).
 */
async function awaitTerminalStall() {
  await waitFor(
    () => expect(screen.getByTestId("status")).toHaveTextContent(/wasn't seen in the agent's input box/i),
    { timeout: 5000 },
  );
}

function StatusSentinel() {
  const status = useStatus();
  return <div data-testid="status">{status?.text ?? ""}</div>;
}

/** renderComposer + the status sentinel, for cases that assert on the status line. */
function renderComposerWithStatus(overrides: Partial<ComponentProps<typeof Composer>> = {}) {
  const props: ComponentProps<typeof Composer> = {
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
    ...overrides,
  };
  const router = createMemoryRouter([
    {
      path: "/",
      element: (
        <>
          <StatusSentinel />
          <ComposerWithMenu {...props} />
        </>
      ),
    },
  ]);
  render(<RouterProvider router={router} />);
  return props;
}

describe("Composer — send", () => {
  it.each([{ isComposing: true }, { keyCode: 229 }])("does not submit an unfinished IME composition (%j)", async (event) => {
    const user = userEvent.setup();
    const sends = serveSend();
    const props = renderComposer();
    const box = screen.getByPlaceholderText(/type a reply/i);
    await user.type(box, "mensaje en composición");
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true, ...event });
    expect(box).toHaveValue("mensaje en composición");
    expect(sends).toEqual([]);
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(props.onSent).toHaveBeenCalledOnce());
    expect(sends.map((send) => send.text)).toEqual(["mensaje en composición"]);
  });

  // #34: a dialog owns the TUI's keyboard. Sending free text at one loses the message AND makes the
  // submit key answer the dialog, approving whatever was highlighted. Nothing may leave the phone.
  it("refuses to send while a dialog is on screen, and keeps the draft", async () => {
    const user = userEvent.setup();
    const wire = watchWrites();
    const props = renderComposerWithStatus({ dialogPresent: true, rawTerminalDraft: "leftover" });
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "please do not approve anything");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent(/dialog is waiting/i));
    expect(wire).toEqual([]); // nothing reached the pane at all
    expect(box).toHaveValue("please do not approve anything"); // the message survives
    expect(props.onSent).not.toHaveBeenCalled();
  });

  it("one tap is one request: the bridge types, verifies and submits", async () => {
    const user = userEvent.setup();
    const wire = watchWrites();
    const sends = serveSend();
    const props = renderComposer();
    await user.type(screen.getByPlaceholderText(/type a reply/i), "looks good");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(props.onSent).toHaveBeenCalledOnce());
    expect(wire).toEqual(["send"]);
    expect(sends).toEqual([{ text: "looks good", requestId: expect.any(String) }]);
  });

  it("sends non-destructive input on the first tap and clears the draft", async () => {
    const user = userEvent.setup();
    const props = renderComposer();
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "looks good");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(box).toHaveValue(""));
    expect(props.onSent).toHaveBeenCalled();
  });

  // The stranded host draft is the bridge's to sweep now: it reads the live box right before the keys
  // and binds them to that row (bridge/guarded-send.ts). The phone sends no keys of its own.
  it("leaves a stranded terminal draft to the bridge's own sweep", async () => {
    const user = userEvent.setup();
    const wire = watchWrites();
    serveSend();
    const props = renderComposer({ terminalDraft: null, rawTerminalDraft: "leftover" });
    await user.type(screen.getByPlaceholderText(/type a reply/i), "new message");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(props.onSent).toHaveBeenCalledOnce());
    expect(wire).toEqual(["send"]);
  });

  it("a refused pre-flight types nothing, keeps the draft and offers the override", async () => {
    const user = userEvent.setup();
    const wire = watchWrites();
    serveSend((body) => refusal(body, "preflight", NO_BOX, false, "not_ready"));
    const props = renderComposerWithStatus({ rawTerminalDraft: "leftover" });
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "please do not approve anything");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent(/input box isn't on screen/i));
    expect(wire).toEqual(["send"]);
    expect(box).toHaveValue("please do not approve anything");
    expect(screen.getByRole("button", { name: /type anyway/i })).toBeInTheDocument();
    expect(props.onSent).not.toHaveBeenCalled();
  });

  // The override tap, end to end, on an omp pane. omp lifts no interactive block kind at all, so
  // `dialogPresent` is STRUCTURALLY false for it and the reply pre-flight is the only guard there is.
  // The bridge's send cannot skip its pre-flight, so "Type anyway" goes through the browser guard,
  // which types without any sweep and still withholds the submit key until it sees the text.
  it("the `Type anyway?` retry types into the pane but never sweeps it", async () => {
    const user = userEvent.setup();
    const wire: string[] = [];
    const COLS = 189;
    const pad = (open: string, body: string, close: string, filler: string) =>
      open + body + filler.repeat(COLS - open.length - body.length - close.length) + close;
    // omp with a `/model` picker up: no `╰─ … ─╯` anywhere, so `composerReady` is false.
    const ompModal = [
      pad("╭──", " Select a model ", "╮", "─"),
      pad("│ ", " ❯ 1. claude-opus  ", " │", " "),
      pad("╰──", "", "──╯", "─"),
    ].join("\n");
    const sends = serveSend((body) => refusal(body, "preflight", NO_BOX, false, "not_ready"));
    server.use(
      http.get(/\/api\/pane\/[^/]+$/, () =>
        HttpResponse.json({ paneId: "w1:p1", text: ompModal, truncated: false, revision: 2 }),
      ),
      http.post(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => {
        const body = (await request.json()) as { keys: string[] };
        wire.push(`keys:${body.keys[0]}×${body.keys.length}`);
        return HttpResponse.json({ ok: true });
      }),
      replyHandler(
        (text) => wire.push(`type:${text}`),
        () => wire.push("submit"),
      ),
    );
    renderComposerWithStatus({ agent: "omp", rawTerminalDraft: "leftover" });
    const box = screen.getByPlaceholderText(/type a reply/i);
    await user.type(box, "please do not approve anything");

    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent(/Tap Send again to type anyway/i),
    );
    expect(sends).toHaveLength(1);
    expect(wire).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Type anyway?" }));
    await waitFor(() => expect(wire).toContain("type:please do not approve anything"));
    // The picker never turns into an input box, so type-then-verify polls out and reports `stalled`.
    // Wait for that terminal outcome INSIDE the test: it lands on the module-scoped status singleton.
    await awaitTerminalStall();
    expect(wire.some((w) => w.startsWith("keys:"))).toBe(false);
    expect(wire).not.toContain("submit");
    expect(sends).toHaveLength(1);
    expect(box).toHaveValue("please do not approve anything");
  }, 15000);

  // The ledger: a failed submit's text is still in the box, so the same request id lets the bridge
  // submit it rather than type a second copy.
  it("retries a failed submit under the same request id, and the bridge submits what is typed", async () => {
    const user = userEvent.setup();
    const sends = serveSend((body, prior) => (prior ? accepted(body) : refusal(body, "submit", NOT_SUBMITTED, true)));
    const props = renderComposerWithStatus();
    const box = screen.getByPlaceholderText(/type a reply/i);
    await user.type(box, "keep this message");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent(/typed into the pane but not submitted/i));
    expect(screen.getByText(/check the terminal before sending again/i)).toBeInTheDocument();
    expect(box).toHaveValue("keep this message");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(props.onSent).toHaveBeenCalledOnce());
    expect(sends).toHaveLength(2);
    expect(sends[1]!.requestId).toBe(sends[0]!.requestId);
    expect(box).toHaveValue("");
  });

  it("a retry after a failure that typed nothing gets a fresh request id", async () => {
    const user = userEvent.setup();
    let first = true;
    const sends = serveSend((body) => {
      if (!first) return accepted(body);
      first = false;
      return refusal(body, "type", "herdr send_text failed: socket closed", false);
    });
    const props = renderComposerWithStatus();
    const box = screen.getByPlaceholderText(/type a reply/i);
    await user.type(box, "try again");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent(/send_text failed/i));
    expect(screen.getByText(/tap send to try again/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(props.onSent).toHaveBeenCalledOnce());
    expect(sends).toHaveLength(2);
    expect(sends[1]!.requestId).not.toBe(sends[0]!.requestId);
  });

  // The bridge looked at the box and the earlier try is gone from it: it may have been submitted. The
  // same id would be refused forever, so the operator's next deliberate try gets a fresh one.
  it("stops reusing a request id once the bridge says the earlier try left the input box", async () => {
    const user = userEvent.setup();
    const sends = serveSend((body, prior) =>
      prior ? refusal(body, "preflight", MAYBE_SENT, true) : sends.length > 2 ? accepted(body) : refusal(body, "submit", NOT_SUBMITTED, true),
    );
    renderComposerWithStatus();
    const box = screen.getByPlaceholderText(/type a reply/i);
    await user.type(box, "only once");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent(/may already have been sent/i));
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends).toHaveLength(3));
    expect(sends[1]!.requestId).toBe(sends[0]!.requestId);
    expect(sends[2]!.requestId).not.toBe(sends[0]!.requestId);
  });

  it("two identical messages are two requests, each answered on its own", async () => {
    const user = userEvent.setup();
    const sends = serveSend();
    const props = renderComposer();
    const box = screen.getByPlaceholderText(/type a reply/i);
    await user.type(box, "ok");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(props.onSent).toHaveBeenCalledTimes(1));
    await user.type(box, "ok");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(props.onSent).toHaveBeenCalledTimes(2));
    expect(sends.map((send) => send.text)).toEqual(["ok", "ok"]);
    expect(sends[1]!.requestId).not.toBe(sends[0]!.requestId);
  });

  it("does not send when preparation refuses, and the next tap is one fresh request", async () => {
    const user = userEvent.setup();
    const sends = serveSend();
    const prepareSend = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const props = renderComposer({ prepareSend });
    const box = screen.getByPlaceholderText(/type a reply/i);
    await user.type(box, "same message");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(prepareSend).toHaveBeenCalledOnce());
    expect(sends).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(props.onSent).toHaveBeenCalledOnce());
    expect(sends).toHaveLength(1);
    expect(box).toHaveValue("");
  });

  it("sends nothing when the pane locks while the send is being prepared", async () => {
    const user = userEvent.setup();
    const sends = serveSend();
    let release!: (ready: boolean) => void;
    const prepareSend = () => new Promise<boolean>((resolve) => { release = resolve; });
    let lock: ((gone: boolean) => void) | null = null;
    function Harness() {
      const [gone, setGone] = useState(false);
      lock = setGone;
      return (
        <Composer paneId="w1:p1" agent="claude" isShell={false} gone={gone} readOnly={false} dialogPresent={false}
          text="pane output" terminalDraft={null} rawTerminalDraft={null} prepareSend={prepareSend}
          prefs={{ wrap: true, fontSize: 11, rawTerminal: false, tapToFocus: true }}
          setWrap={vi.fn()} stepFontSize={vi.fn()} setRawTerminal={vi.fn()} setTapToFocus={vi.fn()} onSent={vi.fn()} />
      );
    }
    render(<RouterProvider router={createMemoryRouter([{ path: "/", element: <Harness /> }])} />);
    await user.type(screen.getByPlaceholderText(/type a reply/i), "please do not send");
    await user.click(screen.getByRole("button", { name: "Send" }));
    act(() => lock?.(true));
    await act(async () => release(true));
    expect(screen.getByPlaceholderText(/pane is gone/i)).toBeTruthy();
    expect(sends).toEqual([]);
  });

  it("keeps the draft and points at Terminal when the text may already be typed", async () => {
    const user = userEvent.setup();
    serveSend((body) => refusal(body, "verify", UNSEEN, true));
    const props = renderComposerWithStatus();
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "almost sent");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent(UNSEEN));
    expect(box).toHaveValue("almost sent");
    expect(screen.getByText(/check the terminal before sending again/i)).toBeInTheDocument();
    expect(props.onSent).not.toHaveBeenCalled();
  });

  it("says a send to an agent Nenu cannot read back went out unverified", async () => {
    const user = userEvent.setup();
    serveSend();
    const props = renderComposerWithStatus({ agent: "pi" });
    await user.type(screen.getByPlaceholderText(/type a reply/i), "hello pi");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(props.onSent).toHaveBeenCalledOnce());
    expect(screen.getByTestId("status")).toHaveTextContent(/sent, not verified/i);
  });
});

describe("Composer — typing into the terminal", () => {
  /** The entry point: the named "Type into terminal" row in the ⋯ menu, beside Keys. */
  function startDirectTyping() {
    fireEvent.click(control(/^type into terminal$/i));
    return screen.getByPlaceholderText(/type into the terminal/i);
  }

  it("focuses the textarea synchronously so the activation gesture opens the phone keyboard", () => {
    renderComposer();

    expect(startDirectTyping()).toHaveFocus();
  });

  // The entry point must be a deliberate press and nothing else: it sits in a row of dock toggles,
  // so it must not send, and it must not leave a half-open dock covering the keyboard it needs.
  it("arms from the menu without sending, and closes an open dock", async () => {
    let replyCalls = 0;
    server.use(replyHandler(() => replyCalls++));
    renderComposer();
    fireEvent.click(control(/^keys$/i));
    expect(screen.getByRole("button", { name: /close keys/i })).toBeInTheDocument();

    fireEvent.click(control(/^type into terminal$/i));

    expect(screen.getByPlaceholderText(/type into the terminal/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /close keys/i })).toBeNull();
    expect(replyCalls).toBe(0);
    expect(control(/^type into terminal$/i)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("shows the armed strip and stops from it", async () => {
    renderComposer();
    startDirectTyping();

    const strip = screen.getByText(/typing into terminal/i);
    expect(strip).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^stop$/i }));

    await waitFor(() =>
      expect(screen.queryByPlaceholderText(/type into the terminal/i)).toBeNull(),
    );
  });

  // The other half of the same rule: the composer locking (pane gone, device demoted to read-only,
  // or the idle pause) means the view is no longer live either.
  it("stops when the composer locks under it", async () => {
    function Harness() {
      const [gone, setGone] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setGone(true)}>
            lock it
          </button>
          <ComposerWithMenu
            paneId="w1:p1"
            agent="claude"
            isShell={false}
            gone={gone}
            readOnly={false}
            dialogPresent={false}
            text="pane output"
            terminalDraft={null}
            rawTerminalDraft={null}
            prefs={{ wrap: true, fontSize: 11, rawTerminal: false, tapToFocus: true }}
            setWrap={vi.fn()}
            stepFontSize={vi.fn()}
            setRawTerminal={vi.fn()}
            setTapToFocus={vi.fn()}
            onSent={vi.fn()}
          />
        </>
      );
    }
    const router = createMemoryRouter([{ path: "/", element: <Harness /> }]);
    render(<RouterProvider router={router} />);

    fireEvent.click(control(/^type into terminal$/i));
    expect(screen.getByPlaceholderText(/type into the terminal/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "lock it" }));

    await waitFor(() =>
      expect(screen.queryByPlaceholderText(/type into the terminal/i)).toBeNull(),
    );
  });

  // The mirror stops tracking the pane when the page is backgrounded, so the next keystroke would
  // go into a terminal the user is not looking at.
  it("stops when the page is hidden", async () => {
    renderComposer();
    startDirectTyping();

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    fireEvent(document, new Event("visibilitychange"));

    await waitFor(() =>
      expect(screen.queryByPlaceholderText(/type into the terminal/i)).toBeNull(),
    );
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  // The disarm above is invisible while the page is hidden — lib/status.ts expires a non-error in
  // 2.5s, so a message published on the way out is gone before anyone can read it. Coming back to a
  // focused field with the mode silently off is how keystrokes meant for the terminal end up in the
  // reply draft instead, so the message has to wait for the return trip.
  it("says the mode stopped once the page comes back", async () => {
    renderComposerWithStatus();
    startDirectTyping();

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() =>
      expect(screen.queryByPlaceholderText(/type into the terminal/i)).toBeNull(),
    );
    expect(screen.getByTestId("status")).not.toHaveTextContent(/backgrounded/i);

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent(/stopped typing into the terminal/i),
    );
  });

  // The notice above expires; a focused field does not. Handing the composer back with the keyboard
  // still up is what turns "the mode stopped" into keystrokes buffered as a reply, so the disarm
  // puts the keyboard away — same as the blur on a failed batch.
  it("puts the keyboard away when the page is hidden, rather than leaving the field primed", async () => {
    renderComposerWithStatus();
    const box = startDirectTyping();
    box.focus();
    expect(document.activeElement).toBe(box);

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(document.activeElement).not.toBe(box));
    expect(screen.queryByPlaceholderText(/type into the terminal/i)).toBeNull();

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent(/stopped typing into the terminal/i),
    );
    // Still not focused on the way back: the reply field must be entered on purpose.
    expect(document.activeElement).not.toBe(box);
  });

  // The blur above is deferred, so it can outlive the disarm that scheduled it. Re-arming is the
  // ordinary way that happens: you come back, tap Type again, and the old timer must not fire into
  // the session that replaced it and drop the keyboard you just asked for. What prevents it is
  // activate()'s cancelPendingBlur() — remove that one line and this test fails, which is the whole
  // reason it runs the timers by hand instead of waiting them out.
  it("does not blur a re-armed session with the disarm it already superseded", () => {
    renderComposerWithStatus();
    const box = startDirectTyping();
    const blurred = vi.spyOn(box, "blur");

    // Fake timers only for the race itself: the deferred blur must be held, not waited out.
    vi.useFakeTimers();
    try {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      fireEvent(document, new Event("visibilitychange")); // schedules the blur
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      fireEvent(document, new Event("visibilitychange"));
      fireEvent.click(control(/^type into terminal$/i)); // re-arm
      act(() => vi.runOnlyPendingTimers());
    } finally {
      vi.useRealTimers();
    }

    expect(blurred).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText(/type into the terminal/i)).toBeInTheDocument();
  });

  // The notice is owed by the pane that was armed, and a pane can change WHILE the page is hidden —
  // a push notification deep-links straight into another one. Delivering it on arrival would tell
  // you the mode stopped on a pane where it was never running.
  it("does not announce the background disarm over a pane it was never armed on", async () => {
    function Harness() {
      const [paneId, setPaneId] = useState("w1:p1");
      return (
        <>
          <StatusSentinel />
          <button type="button" onClick={() => setPaneId("w1:p2")}>
            Switch pane
          </button>
          <ComposerWithMenu
            paneId={paneId}
            agent="claude"
            isShell={false}
            gone={false}
            readOnly={false}
            dialogPresent={false}
            text="pane output"
            terminalDraft={null}
            rawTerminalDraft={null}
            prefs={{ wrap: true, fontSize: 11, rawTerminal: false, tapToFocus: true }}
            setWrap={vi.fn()}
            stepFontSize={vi.fn()}
            setRawTerminal={vi.fn()}
            setTapToFocus={vi.fn()}
            onSent={vi.fn()}
          />
        </>
      );
    }
    const router = createMemoryRouter([{ path: "/", element: <Harness /> }]);
    render(<RouterProvider router={router} />);
    startDirectTyping();

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    fireEvent(document, new Event("visibilitychange"));
    fireEvent.click(screen.getByRole("button", { name: "Switch pane" }));
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    fireEvent(document, new Event("visibilitychange"));

    await waitFor(() => expect(screen.getByPlaceholderText(/type a reply/i)).toBeInTheDocument());
    expect(screen.getByTestId("status")).not.toHaveTextContent(/backgrounded/i);
  });

  it("sends committed keyboard text as literal ordered keys with no implicit Enter", async () => {
    const keyCalls: string[][] = [];
    let replyCalls = 0;
    server.use(
      http.post(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => {
        keyCalls.push(((await request.json()) as { keys: string[] }).keys);
        return HttpResponse.json({ ok: true });
      }),
      replyHandler(() => replyCalls++),
    );
    renderComposerWithStatus({ dialogPresent: true });

    const box = startDirectTyping();
    expect(control(/^type into terminal$/i)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.change(box, { target: { value: "b a" } });

    await waitFor(() => expect(keyCalls).toEqual([["b", "Space", "a"]]));
    expect(keyCalls.flat()).not.toContain("Enter");
    expect(replyCalls).toBe(0);
    expect(box).toHaveValue("");
    expect(screen.getByTestId("status")).toHaveTextContent(/typing into the terminal/i);
  });

  it("sends a swiped/IME-composed word once when composition commits", async () => {
    const keyCalls: string[][] = [];
    server.use(
      http.post(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => {
        keyCalls.push(((await request.json()) as { keys: string[] }).keys);
        return HttpResponse.json({ ok: true });
      }),
    );
    renderComposer();
    const box = startDirectTyping();

    fireEvent.compositionStart(box);
    fireEvent.input(box, {
      target: { value: "swipe" },
      data: "swipe",
      inputType: "insertCompositionText",
      isComposing: true,
    });
    expect(keyCalls).toEqual([]);
    fireEvent.compositionEnd(box, { data: "swipe" });

    await waitFor(() => expect(keyCalls).toEqual([["s", "w", "i", "p", "e"]]));
    // Gboard may emit the committed value once more as an ordinary input after compositionend.
    fireEvent.input(box, {
      target: { value: "swipe" },
      data: "swipe",
      inputType: "insertText",
      isComposing: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(keyCalls).toEqual([["s", "w", "i", "p", "e"]]);
  });

  it("sends terminal keys that do not change the textarea value", async () => {
    const keyCalls: string[][] = [];
    server.use(
      http.post(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => {
        keyCalls.push(((await request.json()) as { keys: string[] }).keys);
        return HttpResponse.json({ ok: true });
      }),
    );
    renderComposer();
    const box = startDirectTyping();

    fireEvent.keyDown(box, { key: "Backspace" });
    await waitFor(() => expect(keyCalls).toEqual([["Backspace"]]));
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(keyCalls).toEqual([["Backspace"], ["Enter"]]));

    // Android can omit keydown for its virtual Backspace and expose only beforeinput.
    fireEvent(
      box,
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "deleteContentBackward",
      }),
    );
    await waitFor(() =>
      expect(keyCalls).toEqual([["Backspace"], ["Enter"], ["Backspace"]]),
    );

    // Gboard can mark its virtual Enter as composing while it commits the current candidate.
    fireEvent(
      box,
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertParagraph",
        isComposing: true,
      }),
    );
    await waitFor(() =>
      expect(keyCalls).toEqual([["Backspace"], ["Enter"], ["Backspace"], ["Enter"]]),
    );
  });

  it("exits on a tap of the highlighted keyboard button", async () => {
    const user = userEvent.setup();
    renderComposer();
    const box = startDirectTyping();

    fireEvent.blur(box); // dismissing the Android keyboard does not silently disarm the mode
    expect(screen.getByPlaceholderText(/type into the terminal/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /stop typing into terminal/i }));

    expect(screen.getByPlaceholderText(/type a reply/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("stops direct typing when a key batch is refused", async () => {
    server.use(
      http.post(/\/api\/pane\/[^/]+\/keys$/, () =>
        HttpResponse.json({ ok: false, error: "pane unavailable" }, { status: 500 }),
      ),
    );
    renderComposerWithStatus();
    const box = startDirectTyping();

    fireEvent.change(box, { target: { value: "b" } });

    const replyBox = await screen.findByPlaceholderText(/type a reply/i);
    await waitFor(() => expect(replyBox).not.toHaveFocus());
    expect(screen.getByTestId("status")).toHaveTextContent(/pane unavailable/i);
  });

  it("refuses activation while a buffered reply exists", async () => {
    const user = userEvent.setup();
    renderComposerWithStatus();
    const box = screen.getByPlaceholderText(/type a reply/i);
    await user.type(box, "keep this draft");

    // The refusal belongs on the named choice, where there is somewhere to explain it.
    fireEvent.click(control(/^type into terminal$/i));

    expect(screen.getByPlaceholderText(/type a reply/i)).toHaveValue("keep this draft");
    expect(screen.queryByPlaceholderText(/type into the terminal/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("status")).toHaveTextContent(/send or clear the draft/i);
  });

  it("resets when the composer changes panes", () => {
    function Harness() {
      const [paneId, setPaneId] = useState("w1:p1");
      return (
        <>
          <button type="button" onClick={() => setPaneId("w1:p2")}>
            Switch pane
          </button>
          <ComposerWithMenu
            paneId={paneId}
            agent="claude"
            isShell={false}
            gone={false}
            readOnly={false}
            dialogPresent={false}
            text="pane output"
            terminalDraft={null}
            rawTerminalDraft={null}
            prefs={{ wrap: true, fontSize: 11, rawTerminal: false, tapToFocus: true }}
            setWrap={vi.fn()}
            stepFontSize={vi.fn()}
            setRawTerminal={vi.fn()}
            setTapToFocus={vi.fn()}
            onSent={vi.fn()}
          />
        </>
      );
    }
    const router = createMemoryRouter([{ path: "/", element: <Harness /> }]);
    render(<RouterProvider router={router} />);
    startDirectTyping();

    fireEvent.click(screen.getByRole("button", { name: "Switch pane" }));

    expect(screen.getByPlaceholderText(/type a reply/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/type keys/i)).not.toBeInTheDocument();
  });
});

// .adr/0009: a modal that owns the keyboard has no input box, so the reply path's PRE-FLIGHT refuses
// before typing anything. The composer's job is to keep the draft, say why, and offer one deliberate
// override — which still runs the type-then-verify guard behind it.
describe("Composer — blocked pre-flight override", () => {
  // A pane with no input box at all: the /model picker's shape.
  const PICKER = [
    "▔".repeat(60),
    "   Select model",
    "   ❯ 1. Default",
    "     2. Opus",
    "",
    "   Enter to set as default · s to use this session only · Esc to cancel",
  ].join("\n");

  function servePicker(calls: string[]) {
    serveSend((body) => refusal(body, "preflight", NO_BOX, false, "not_ready"));
    server.use(
      http.get(/\/api\/pane\/[^/]+$/, () =>
        HttpResponse.json({ paneId: "w1:p1", text: PICKER, truncated: false, revision: 1 }),
      ),
      http.post(/\/api\/pane\/[^/]+\/reply$/, async ({ request }) => {
        const body = (await request.json()) as { text: string; submit?: boolean };
        calls.push(body.submit ? "submit" : "type");
        return HttpResponse.json({ ok: true });
      }),
    );
  }

  it("keeps the draft, explains, and types nothing on the first tap", async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    servePicker(calls);
    const props = renderComposerWithStatus();
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "use fable please");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent(/input box isn't on screen/i),
    );
    expect(screen.getByTestId("status")).toHaveTextContent(/tap send again to type anyway/i);
    expect(calls).toEqual([]); // nothing was typed into the picker
    expect(box).toHaveValue("use fable please"); // the message survives
    expect(props.onSent).not.toHaveBeenCalled();
    // The button names what the override actually does — type, not send.
    expect(screen.getByRole("button", { name: /type anyway/i })).toBeInTheDocument();
  });

  it("the second tap types anyway, but STILL withholds the submit key", async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    servePicker(calls);
    renderComposerWithStatus();
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "use fable please");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("button", { name: /type anyway/i });

    await user.click(screen.getByRole("button", { name: /type anyway/i }));

    // The text goes in (the user overruled the pre-flight) — but the pane never echoes it onto an
    // input line, so the verify step never passes and Enter is never fired. THE #34 invariant.
    await waitFor(() => expect(calls).toContain("type"));
    expect(calls).not.toContain("submit");
    expect(box).toHaveValue("use fable please");
    await awaitTerminalStall(); // see the helper: an unawaited stall lands in a later test
  }, 15000);
});

// A draft too big for the disk tier survives a pane switch but not the app closing, and the only
// thing that makes that difference visible is this row. Before it, the oversize write was skipped
// and a remount silently restored an OLDER, SHORTER draft — text the user never wrote.
describe("Composer — oversize draft notice", () => {
  it("says an oversize draft won't survive the app closing, and stops saying it when it fits", async () => {
    const props = renderComposerWithStatus();
    const box = screen.getByPlaceholderText(/type a reply/i);

    expect(screen.queryByText(/too long to keep as a saved draft/i)).not.toBeInTheDocument();

    // Paste, rather than type: 8 KiB of userEvent keystrokes would take minutes.
    fireEvent.change(box, { target: { value: "# heading\n".repeat(1200) } });
    expect(await screen.findByText(/too long to keep as a saved draft/i)).toBeInTheDocument();
    // …and the whole paste is still what the store hands back, which is the actual fix.
    expect(loadDraft(undefined, props.paneId)).toHaveLength(12000);

    fireEvent.change(box, { target: { value: "short again" } });
    await waitFor(() =>
      expect(screen.queryByText(/too long to keep as a saved draft/i)).not.toBeInTheDocument(),
    );
  });
});

// #103. A password prompt is the one refusal that never becomes a success: `sudo` turns echo off, so
// the evidence Send needs is exactly what the screen is refusing to show, and the reporter tapped Send
// at it for three days. These pin the two halves of the answer — say what it is, and get the operator
// into the mode that works without leaving the secret behind.
describe("Composer — password prompt", () => {
  const SUDO = "$ sudo systemctl restart collie\n[sudo] password for altan:";

  function serveSudo(calls: string[]) {
    serveSend((body) => refusal(body, "preflight", NO_ECHO, false, "not_ready"));
    server.use(
      http.get(/\/api\/pane\/[^/]+$/, () =>
        HttpResponse.json({ paneId: "w1:p1", text: SUDO, truncated: false, revision: 1 }),
      ),
      http.post(/\/api\/pane\/[^/]+\/reply$/, async ({ request }) => {
        const body = (await request.json()) as { text: string; submit?: boolean };
        calls.push(body.submit ? "submit" : "type");
        return HttpResponse.json({ ok: true });
      }),
    );
  }

  it("names the prompt and offers Type, without replacing the override", async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    serveSudo(calls);
    renderComposerWithStatus({ text: SUDO });
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "hunter2hunter2");
    await user.click(screen.getByRole("button", { name: "Send" }));

    // The refusal names the mechanism, not "a menu or dialog is probably up".
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent(/password prompt/i),
    );
    // The prompt is quoted off the mirror, so the claim is checkable against the screen.
    expect(screen.getByText("[sudo] password for altan:")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /use type/i })).toBeInTheDocument();
    // The pre-existing override is untouched — a false positive costs a dismissal, not an action.
    expect(screen.getByRole("button", { name: /type anyway/i })).toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it("the handoff clears the draft before arming Type", async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    serveSudo(calls);
    renderComposerWithStatus({ text: SUDO });
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "hunter2hunter2");
    // The write-through has already put the secret in the 48h store, before any send was attempted —
    // the leak #103 asked about. Asserted here so the assertion below isn't vacuously true.
    expect(localStorage.getItem("collie:draft:default:w1:p1")).toContain("hunter2hunter2");

    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.click(await screen.findByRole("button", { name: /use type/i }));

    // Armed, and the secret is gone from the field (and from its localStorage copy with it) — which
    // is also what lets it arm at all: useDirectTyping refuses while any draft is present.
    await waitFor(() =>
      expect(screen.getByPlaceholderText(/type into the terminal/i)).toHaveValue(""),
    );
    expect(localStorage.getItem("collie:draft:default:w1:p1")).toBeNull();
    expect(screen.queryByRole("button", { name: /use type/i })).not.toBeInTheDocument();
    expect(calls).toEqual([]); // nothing was ever typed by the reply path
  });

  it("drops the stored draft the moment it recognises the prompt, button or no button", async () => {
    // The reporter's actual behaviour: tap Send, give up, walk to a laptop. No button is ever pressed,
    // so a handoff that clears on its way through would never have run — and the pane-leave save would
    // have written the password back out. The store has to be empty from the refusal onwards.
    const user = userEvent.setup();
    const calls: string[] = [];
    serveSudo(calls);
    renderComposerWithStatus({ text: SUDO });
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "hunter2hunter2");
    expect(localStorage.getItem("collie:draft:default:w1:p1")).toContain("hunter2hunter2");

    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("button", { name: /use type/i });
    expect(localStorage.getItem("collie:draft:default:w1:p1")).toBeNull();
    // Through the store's own reader, not just the storage key: the draft store has a second,
    // in-memory tier (lib/drafts.ts) and a secret surviving in a tier this assertion cannot see
    // would be #103 all over again, invisibly. clearDraft must empty both.
    expect(loadDraft(undefined, "w1:p1")).toBeNull();

    // Dismissing keeps the text on screen — the operator may still need to read it — but the typing
    // that happened while the notice was up was never stored either.
    await user.click(screen.getByRole("button", { name: /dismiss password-prompt notice/i }));
    expect(box).toHaveValue("hunter2hunter2");
    expect(localStorage.getItem("collie:draft:default:w1:p1")).toBeNull();
  });
});

describe("Composer — destructive-input confirm", () => {
  it("holds a destructive command for a second tap, then sends", async () => {
    const user = userEvent.setup();
    const props = renderComposer();
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "rm -rf node_modules");

    // First tap: the Send button flips to a "Really send?" confirm — nothing is sent yet.
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByRole("button", { name: /really send/i })).toBeInTheDocument();
    expect(box).toHaveValue("rm -rf node_modules"); // draft kept
    expect(props.onSent).not.toHaveBeenCalled();

    // Second tap confirms: now it actually sends and clears.
    await user.click(screen.getByRole("button", { name: /really send/i }));
    await waitFor(() => expect(box).toHaveValue(""));
    expect(props.onSent).toHaveBeenCalled();
  });

  it("does not arm the confirm for innocent input", async () => {
    const user = userEvent.setup();
    renderComposer();
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "run the sudoku solver"); // "sudo" look-alike must not trip the guard
    await user.click(screen.getByRole("button", { name: "Send" }));

    // Sent straight away — no "Really send?" ever appeared, and the draft cleared.
    expect(screen.queryByRole("button", { name: /really send/i })).not.toBeInTheDocument();
    await waitFor(() => expect(box).toHaveValue(""));
  });
});

// Drives the composer's TWO draft props the way the parent does across polls: `rawTerminalDraft` is
// the live per-poll line, `terminalDraft` is its 1.5s-stabilised twin (useStableTerminalDraft). Two
// hidden controls set them independently (empty string → null), so a test can model a raw-only blip,
// a stabilised draft, live host typing (raw changes while stable lags), and the line clearing — all
// without real timers. `initialDraft` seeds a fully-stranded draft (raw + stable) at mount.
function renderDraftHarness(overrides: Partial<ComponentProps<typeof Composer>> = {}) {
  const { terminalDraft: initialDraft = null, ...rest } = overrides;
  function Harness() {
    const [raw, setRaw] = useState<string | null>(initialDraft);
    const [stable, setStable] = useState<string | null>(initialDraft);
    const props: ComponentProps<typeof Composer> = {
      paneId: "w1:p1",
      agent: "claude",
      isShell: false,
      gone: false,
      readOnly: false,
      dialogPresent: false,
      text: "pane output",
      prefs: { wrap: true, fontSize: 11, rawTerminal: false, tapToFocus: true },
      setWrap: vi.fn(),
      stepFontSize: vi.fn(),
      setRawTerminal: vi.fn(),
      setTapToFocus: vi.fn(),
      onSent: vi.fn(),
      ...rest,
      terminalDraft: stable,
      rawTerminalDraft: raw,
    };
    return (
      <>
        <input
          data-testid="raw-control"
          defaultValue={initialDraft ?? ""}
          onChange={(e) => setRaw(e.target.value === "" ? null : e.target.value)}
        />
        <input
          data-testid="stable-control"
          defaultValue={initialDraft ?? ""}
          onChange={(e) => setStable(e.target.value === "" ? null : e.target.value)}
        />
        <Composer {...props} />
      </>
    );
  }
  const router = createMemoryRouter([{ path: "/", element: <Harness /> }]);
  render(<RouterProvider router={router} />);
}

// The raw line updated this poll (may differ from the stabilised value while the host is typing).
const setRawDraft = (value: string) =>
  fireEvent.change(screen.getByTestId("raw-control"), { target: { value } });
// The stabilised value promoting/clearing (what gates the preview's appearance).
const setStableDraft = (value: string) =>
  fireEvent.change(screen.getByTestId("stable-control"), { target: { value } });
// A draft that has BOTH appeared and passed the 1.5s stability gate — raw and stable carry it.
const strandDraft = (value: string) => {
  setRawDraft(value);
  setStableDraft(value);
};

// The composer input is EXCLUSIVELY phone-owned: a terminal draft is never written into it by a poll.
// The reported bug was the reverse — b9603e9's auto-adopt kept re-syncing the field to the draft, so
// while the host was typing the input flickered fill→clear→fill. These pin that it can never happen.
describe("Composer — input is phone-owned (never auto-written by the terminal draft)", () => {
  it("never writes the draft into the input across appear → stabilise → live typing → vanish", async () => {
    renderDraftHarness();
    const box = screen.getByPlaceholderText(/type a reply/i);
    expect(box).toHaveValue("");

    setRawDraft("d"); // a raw draft appears (one poll) — input untouched
    expect(box).toHaveValue("");

    setStableDraft("d"); // it stabilises (the preview may show) — input still untouched
    await screen.findByText(/draft in terminal/i);
    expect(box).toHaveValue("");

    // Live host typing: a distinct raw draft every poll. The input never oscillates.
    for (const t of ["dr", "dra", "draf", "draft", "draft "]) {
      setRawDraft(t);
      expect(box).toHaveValue("");
    }

    setRawDraft(""); // the host line clears — input stays empty
    expect(box).toHaveValue("");
  });

  it("leaves the user's own typed text intact while a draft appears, streams, and vanishes", async () => {
    const user = userEvent.setup();
    renderDraftHarness();
    const box = screen.getByPlaceholderText(/type a reply/i);
    await user.type(box, "my mobile message");

    strandDraft("host draft"); // a draft strands while the user is mid-compose
    await screen.findByText(/draft in terminal/i);
    expect(box).toHaveValue("my mobile message");

    setRawDraft("host draft grows"); // host keeps typing — preview follows, input does not
    expect(box).toHaveValue("my mobile message");

    setRawDraft(""); // host line clears
    expect(box).toHaveValue("my mobile message");
  });
});

describe("Composer — terminal-draft preview", () => {
  it("does not render the preview when there is no stranded draft", () => {
    renderComposer({ terminalDraft: null, rawTerminalDraft: null });
    expect(screen.queryByText(/draft in terminal/i)).not.toBeInTheDocument();
  });

  it("appears only after the draft stabilises — a raw-only blip never flashes it", async () => {
    renderDraftHarness();
    expect(screen.queryByText(/draft in terminal/i)).not.toBeInTheDocument();

    setRawDraft("blip"); // raw only (not yet stable) → no preview
    expect(screen.queryByText(/draft in terminal/i)).not.toBeInTheDocument();

    setStableDraft("blip"); // stabilised → the preview promotes
    expect(await screen.findByText(/draft in terminal/i)).toBeInTheDocument();
    expect(screen.getByText("blip")).toBeInTheDocument();
  });

  it("tracks the raw draft live once shown — host typing streams into the preview text", async () => {
    renderDraftHarness();
    strandDraft("foo");
    expect(await screen.findByText("foo")).toBeInTheDocument();

    // Raw updates every poll; the stabilised value lags, but the preview text follows the raw line.
    setRawDraft("foobar");
    expect(await screen.findByText("foobar")).toBeInTheDocument();
    expect(screen.queryByText("foo")).not.toBeInTheDocument();

    setRawDraft("foobar baz");
    expect(await screen.findByText("foobar baz")).toBeInTheDocument();
  });

  it("unmounts when the raw draft goes null (submitted or cleared on the host)", async () => {
    renderDraftHarness();
    strandDraft("gone soon");
    await screen.findByText(/draft in terminal/i);

    setRawDraft(""); // → null: the host line was cleared/submitted
    await waitFor(() => expect(screen.queryByText(/draft in terminal/i)).not.toBeInTheDocument());
  });

  it("renders no dismiss button — the preview has no user-facing dismiss", async () => {
    renderDraftHarness();
    strandDraft("no dismiss here");
    await screen.findByText(/draft in terminal/i);

    expect(screen.queryByLabelText(/dismiss terminal draft/i)).not.toBeInTheDocument();
  });

  it("persists across subsequent polls of the same text with no user action", async () => {
    renderDraftHarness();
    strandDraft("still here");
    await screen.findByText(/draft in terminal/i);

    // Repeated polls that just re-report the SAME raw text (no take-over, no send, no change) must
    // never hide the preview — it's honest state, not a one-shot notice.
    for (let i = 0; i < 3; i++) {
      setRawDraft("still here");
      expect(screen.getByText(/draft in terminal/i)).toBeInTheDocument();
      expect(screen.getByText("still here")).toBeInTheDocument();
    }
  });

  it("Take over copies the CURRENT draft into the composer, marks it handled, and hides the preview", async () => {
    const user = userEvent.setup();
    const keyCalls: string[] = [];
    server.use(
      http.post(/\/api\/pane\/[^/]+\/keys$/, async () => {
        keyCalls.push("keys");
        return HttpResponse.json({ ok: true });
      }),
    );
    renderDraftHarness();
    strandDraft("take me over");
    await screen.findByText(/draft in terminal/i);
    const box = screen.getByPlaceholderText(/type a reply/i);
    expect(box).toHaveValue(""); // never auto-written before the deliberate takeover

    await user.click(screen.getByRole("button", { name: /take over/i }));
    expect(box).toHaveValue("take me over"); // the text lands, one-shot
    expect(screen.queryByText(/draft in terminal/i)).not.toBeInTheDocument(); // preview hidden
    expect(keyCalls).toEqual([]); // takeover writes NOTHING to the terminal
  });

  it("after Take over, a divergent host draft honestly re-shows the preview with the new text", async () => {
    const user = userEvent.setup();
    renderDraftHarness();
    strandDraft("original");
    await screen.findByText(/draft in terminal/i);

    await user.click(screen.getByRole("button", { name: /take over/i }));
    expect(screen.queryByText(/draft in terminal/i)).not.toBeInTheDocument();

    // The host keeps typing → a DIFFERENT draft → the preview returns with the new text.
    strandDraft("original plus more");
    expect(await screen.findByText(/draft in terminal/i)).toBeInTheDocument();
    expect(screen.getByText("original plus more")).toBeInTheDocument();
  });

  it("re-stranding the SAME text after the line cleared is a fresh draft — the preview returns", async () => {
    // Regression: the handled key used to persist past the line clearing, so taking over "continue"
    // once muted every future "continue" in the pane until a navigation reset the component.
    const user = userEvent.setup();
    renderDraftHarness();
    strandDraft("continue");
    await screen.findByText(/draft in terminal/i);

    await user.click(screen.getByRole("button", { name: /take over/i }));
    expect(screen.queryByText(/draft in terminal/i)).not.toBeInTheDocument();

    strandDraft(""); // the host line empties (submitted/wiped on the host)
    strandDraft("continue"); // …and later the very same text strands again
    const label = await screen.findByText(/draft in terminal/i);
    // Scope to the preview block — "continue" also sits in the composer input from the take-over.
    expect(label.parentElement).toHaveTextContent("continue");
  });

  it("send after Take over is one request for the adopted text, then clears the composer", async () => {
    const user = userEvent.setup();
    const wire = watchWrites();
    const sends = serveSend();
    renderDraftHarness();
    strandDraft("adopted line");
    await screen.findByText(/draft in terminal/i);

    await user.click(screen.getByRole("button", { name: /take over/i }));
    const box = screen.getByPlaceholderText(/type a reply/i);
    expect(box).toHaveValue("adopted line");

    // The host line still holds the draft (takeover never touched it); the bridge sweeps it before typing.
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(box).toHaveValue("")); // cleared after send
    expect(wire).toEqual(["send"]);
    expect(sends.map((send) => send.text)).toEqual(["adopted line"]);
  });

  it("read-only device: shows the preview and allows Take over (local copy), writing nothing to the terminal", async () => {
    const user = userEvent.setup();
    const keyCalls: string[] = [];
    server.use(
      http.post(/\/api\/pane\/[^/]+\/keys$/, async () => {
        keyCalls.push("keys");
        return HttpResponse.json({ ok: true });
      }),
    );
    renderDraftHarness({ readOnly: true });
    strandDraft("read only draft");
    expect(await screen.findByText(/draft in terminal/i)).toBeInTheDocument();
    const box = screen.getByPlaceholderText(/read-only/i);
    expect(box).toHaveValue(""); // never auto-written

    await user.click(screen.getByRole("button", { name: /take over/i }));
    expect(box).toHaveValue("read only draft"); // local copy landed
    expect(box).toBeDisabled(); // still locked — can't edit or send
    expect(keyCalls).toEqual([]); // no terminal writes at all
  });
});

// Mitigation A for the in-flight self-race: the composer knows what it just sent, so when the SAME
// text shows up on the terminal's "❯" line moments later (our own reply before the bridge's pending
// Enter lands), it must NOT be treated as a stranded draft — no chip, and no destructive clear-prefix
// on the next Send. A harness lets the test flip `terminalDraft` after a send, the way the parent
// would once the mirror echoes the in-flight text back.
describe("Composer — in-flight echo suppression (match-last-sent)", () => {
  function EchoHarness({ echoValue }: { echoValue: string }) {
    // The echo lands on BOTH the raw and the stabilised line at once (a persistent echo is stable).
    const [draft, setDraft] = useState<string | null>(null);
    const props: ComponentProps<typeof Composer> = {
      paneId: "w1:p1",
      agent: "claude",
      isShell: false,
      gone: false,
      readOnly: false,
      dialogPresent: false,
      text: "pane output",
      terminalDraft: draft,
      rawTerminalDraft: draft,
      prefs: { wrap: true, fontSize: 11, rawTerminal: false, tapToFocus: true },
      setWrap: vi.fn(),
      stepFontSize: vi.fn(),
      setRawTerminal: vi.fn(),
      setTapToFocus: vi.fn(),
      onSent: vi.fn(),
    };
    return (
      <>
        <button onClick={() => setDraft(echoValue)}>__set-draft</button>
        <Composer {...props} />
      </>
    );
  }

  function renderEcho(echoValue: string) {
    const router = createMemoryRouter([
      { path: "/", element: <EchoHarness echoValue={echoValue} /> },
    ]);
    render(<RouterProvider router={router} />);
  }

  it("suppresses the chip when the draft matches what we just sent", async () => {
    const user = userEvent.setup();
    const wire = watchWrites();
    const sends = serveSend();
    renderEcho("/rename");
    const box = screen.getByPlaceholderText(/type a reply/i);

    // Send "/rename"; the composer remembers it.
    await user.type(box, "/rename");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends.map((send) => send.text)).toEqual(["/rename"]));

    // The mirror now echoes the in-flight "/rename" back onto the ❯ line — no stranded-draft chip.
    await user.click(screen.getByRole("button", { name: "__set-draft" }));
    expect(screen.queryByText(/draft in terminal/i)).not.toBeInTheDocument();

    await user.type(box, "next message");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends.map((send) => send.text)).toEqual(["/rename", "next message"]));
    expect(wire).toEqual(["send", "send"]);
  });

  it("still treats a genuinely different stranded draft as real (previews it; Take over sends it)", async () => {
    const user = userEvent.setup();
    const sends = serveSend();
    renderEcho("someone else's leftover");
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "hello");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends.map((send) => send.text)).toEqual(["hello"]));

    // A draft that is NOT what we just sent is a real stranded draft — not suppressed. It shows in the
    // preview (never auto-written into the now-empty input).
    await user.click(screen.getByRole("button", { name: "__set-draft" }));
    expect(await screen.findByText(/draft in terminal/i)).toBeInTheDocument();
    expect(box).toHaveValue("");

    await user.click(screen.getByRole("button", { name: /take over/i }));
    expect(box).toHaveValue("someone else's leftover");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends.map((send) => send.text)).toEqual(["hello", "someone else's leftover"]));
  });
});

// The no-service-worker self-updater must never reload over unsent work. The composer holds a reload
// (lib/reload-guard) while its phone-owned input has REAL text or an upload is in flight — but a
// terminal draft alone is SAFE (it lives on the "❯" line and its preview re-derives after a reload),
// so it must NOT hold, or a stranded draft would wedge the update forever.
describe("Composer — reload-guard hold (no-SW self-update safety gate)", () => {
  beforeEach(() => __resetReloadGuard());

  it("holds a reload while the composer has unsent text, releases when it's cleared", async () => {
    const user = userEvent.setup();
    renderComposer();
    const box = screen.getByPlaceholderText(/type a reply/i);
    expect(isReloadHeld()).toBe(false);

    await user.type(box, "half-written thought");
    expect(isReloadHeld()).toBe(true);

    await user.clear(box);
    expect(isReloadHeld()).toBe(false);
  });

  it("a terminal draft alone (preview only, empty input) does NOT hold — it re-derives after a reload", async () => {
    renderDraftHarness();
    strandDraft("just a preview");
    await screen.findByText(/draft in terminal/i);
    expect(screen.getByPlaceholderText(/type a reply/i)).toHaveValue(""); // nothing phone-owned to lose
    expect(isReloadHeld()).toBe(false);
  });

  it("holds while an image upload is in flight, releases once it settles", async () => {
    // A failing upload leaves only an error chip (a successful one is a real unsent attachment and
    // legitimately holds) — so the release is observable in isolation.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.post(/\/api\/pane\/[^/]+\/upload$/, async () => {
        await gate;
        return HttpResponse.json({ ok: false, error: "upload failed" });
      }),
    );
    renderComposer();
    expect(isReloadHeld()).toBe(false);

    const file = new File(["x"], "shot.png", { type: "image/png" });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => expect(isReloadHeld()).toBe(true)); // uploading → held
    release();
    await waitFor(() => expect(isReloadHeld()).toBe(false)); // settled, input still empty → released
  });
});

describe("Composer — quick keys / image attach", () => {
  it("shows the attach button on the reply-input row without the quick-key strip being visible", async () => {
    const user = userEvent.setup();
    renderComposer();

    // The quick-key strip only renders once composerFocused && keyboardOpen — keyboardOpen defaults
    // to false in jsdom (no visualViewport resize fires), so none of its keys are present here.
    expect(screen.queryByRole("button", { name: "Esc" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Tab" })).not.toBeInTheDocument();

    // The attach button now lives on the always-visible reply-input row instead of the strip.
    const attach = screen.getByRole("button", { name: "Attach image" });
    expect(attach).toBeEnabled();
    await user.click(attach); // clickable without throwing (opens the hidden file input)
  });

  it("does not render digit shortcut buttons in the composer (they live on the Keys dock's 123 tab)", () => {
    renderComposer();
    for (const d of ["1", "2", "3", "4", "5"]) {
      expect(screen.queryByRole("button", { name: d })).not.toBeInTheDocument();
    }
  });
});

describe("Composer — clipboard image paste", () => {
  it("attaches a pasted image as a chip, never as a path in the text", async () => {
    server.use(
      http.post(/\/api\/pane\/[^/]+\/upload$/, () => HttpResponse.json({ ok: true, path: "/tmp/shot.png" })),
    );
    renderComposer();
    const box = screen.getByPlaceholderText(/type a reply/i);
    const file = new File(["x"], "shot.png", { type: "image/png" });
    const item = { kind: "file", type: "image/png", getAsFile: () => file };

    fireEvent.paste(box, { clipboardData: { items: [item] } });

    expect(await screen.findByRole("button", { name: "Remove Image 1" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Uploading…")).not.toBeInTheDocument());
    expect(box).toHaveValue("");
  });

  it("leaves a plain-text paste alone — no upload, nothing written by the paste handler", () => {
    renderComposer();
    const box = screen.getByPlaceholderText(/type a reply/i);
    const item = { kind: "string", type: "text/plain", getAsFile: () => null };

    fireEvent.paste(box, { clipboardData: { items: [item] } });

    expect(box).toHaveValue("");
    expect(screen.queryByText(/Image added/i)).not.toBeInTheDocument();
  });
});

describe("Composer — keys dock (in-flow, not an overlay)", () => {
  it("tapping Keys docks the NavTray in the normal flow (no fixed overlay) and toggles it closed", async () => {
    const user = userEvent.setup();
    renderComposer();

    const keys = control("Keys");
    expect(keys).toHaveAttribute("aria-pressed", "false");
    // Closed by default — the tray isn't mounted.
    expect(screen.queryByRole("button", { name: "Esc" })).not.toBeInTheDocument();

    await user.click(keys);
    expect(keys).toHaveAttribute("aria-pressed", "true");

    // The NavTray is now mounted (its Esc key is a good witness)…
    const esc = screen.getByRole("button", { name: "Esc" });
    expect(esc).toBeInTheDocument();
    // …and it is IN-FLOW, not inside a fixed overlay/dialog (the BottomSheet's covering role="dialog").
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(esc.closest('[aria-modal="true"]')).toBeNull();
    expect(esc.closest(".fixed")).toBeNull();

    // Tapping Keys again closes the dock (single-valued drawer toggle).
    await user.click(keys);
    expect(keys).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("button", { name: "Esc" })).not.toBeInTheDocument();
  });

  it("the dock's own X close button dismisses it", async () => {
    const user = userEvent.setup();
    renderComposer();

    await user.click(control("Keys"));
    expect(screen.getByRole("button", { name: "Esc" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close Keys" }));
    expect(screen.queryByRole("button", { name: "Esc" })).not.toBeInTheDocument();
  });

  it("routes a docked key press through pane.send_keys", async () => {
    const user = userEvent.setup();
    let sentKeys: string[] | null = null;
    server.use(
      http.post(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => {
        const body = (await request.json()) as { keys: string[] };
        sentKeys = body.keys;
        return HttpResponse.json({ ok: true });
      }),
    );
    renderComposer();

    await user.click(control("Keys"));
    await user.click(screen.getByRole("button", { name: "Esc" }));

    await waitFor(() => expect(sentKeys).toEqual(["Escape"]));
  });
});

describe("Composer — quick dock (in-flow, matches the keys dock)", () => {
  it("tapping Quick docks the reply grids in the normal flow (no fixed overlay) and toggles it closed", async () => {
    const user = userEvent.setup();
    renderComposer();

    const quick = control("Quick replies");
    expect(quick).toHaveAttribute("aria-pressed", "false");
    // Closed by default — none of the quick replies are mounted.
    expect(screen.queryByRole("button", { name: "yes" })).not.toBeInTheDocument();

    await user.click(quick);
    expect(quick).toHaveAttribute("aria-pressed", "true");

    // The reply grid is now mounted ("yes" is a good witness)…
    const yes = screen.getByRole("button", { name: "yes" });
    expect(yes).toBeInTheDocument();
    // …and it is IN-FLOW like the keys dock, not inside a BottomSheet's covering role="dialog".
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(yes.closest('[aria-modal="true"]')).toBeNull();
    expect(yes.closest(".fixed")).toBeNull();

    // Tapping Quick again closes the dock (single-valued drawer toggle).
    await user.click(quick);
    expect(quick).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("button", { name: "yes" })).not.toBeInTheDocument();
  });

  it("opening Quick closes an open Keys dock (shared single-valued drawer)", async () => {
    const user = userEvent.setup();
    renderComposer();

    await user.click(control("Keys"));
    expect(screen.getByRole("button", { name: "Esc" })).toBeInTheDocument();

    await user.click(control("Quick replies"));
    // Keys unmounts, Quick mounts — only one dock at the single placement site.
    expect(screen.queryByRole("button", { name: "Esc" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "yes" })).toBeInTheDocument();
  });

  it("the dock's own X close button dismisses it", async () => {
    const user = userEvent.setup();
    renderComposer();

    await user.click(control("Quick replies"));
    expect(screen.getByRole("button", { name: "yes" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close Quick" }));
    expect(screen.queryByRole("button", { name: "yes" })).not.toBeInTheDocument();
  });

  it("a quick-action tap sends its text through the reply path, then closes the dock", async () => {
    const user = userEvent.setup();
    const sends = serveSend();
    const props = renderComposer();

    await user.click(control("Quick replies"));
    await user.click(screen.getByRole("button", { name: "continue" }));

    await waitFor(() => expect(sends.map((send) => send.text)).toEqual(["continue"]));
    expect(props.onSent).toHaveBeenCalled();
    // The dock deliberately OUTLIVES the send — the ✓ has to land somewhere the user is still
    // looking — and closes itself once the echo has been seen.
    await waitFor(
      () => expect(screen.queryByRole("button", { name: "continue" })).not.toBeInTheDocument(),
      { timeout: 3000 },
    );
  });

  it("a quick reply echoes on its OWN button and locks its siblings while in flight", async () => {
    const user = userEvent.setup();
    // Hold the send open, so the in-flight state is observable rather than
    // a race against a handler that resolves instantly.
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    serveSend(async (body) => {
      await gate;
      return accepted(body);
    });
    renderComposer();

    await user.click(control("Quick replies"));
    await user.click(screen.getByRole("button", { name: "continue" }));

    // The tapped reply is busy; an untapped sibling is locked out so a second send can't race it.
    await waitFor(() => expect(screen.getByRole("button", { name: "continue" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "skip" })).toBeDisabled();

    release();
    // Once it settles the dock closes itself — proof the flight actually resolved.
    await waitFor(
      () => expect(screen.queryByRole("button", { name: "continue" })).not.toBeInTheDocument(),
      { timeout: 3000 },
    );
  });

  it("a failed quick reply keeps the dock open and re-enables the grid", async () => {
    const user = userEvent.setup();
    server.use(
      http.post(/\/api\/pane\/[^/]+\/send$/, () =>
        HttpResponse.json({ ok: false, error: "nope" }, { status: 500 }),
      ),
    );
    renderComposer();

    await user.click(control("Quick replies"));
    await user.click(screen.getByRole("button", { name: "continue" }));

    // No ✓, no close — the reply never landed, so the dock stays put for a retry.
    await waitFor(() => expect(screen.getByRole("button", { name: "continue" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "skip" })).toBeEnabled();
  });
});

describe("Composer — display prefs behind the gear", () => {
  it("the View row is gone; persistent mirror prefs live behind the Display gear", async () => {
    const user = userEvent.setup();
    renderComposer();

    // Nothing display-related is on the permanent rows any more.
    expect(screen.queryByRole("button", { name: "Decrease font size" })).not.toBeInTheDocument();

    await user.click(control("Display"));

    // Named controls, not bare glyphs — the whole point of the move.
    expect(screen.getByRole("switch", { name: "Wrap lines" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Tap to type" })).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Raw terminal" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Decrease font size" })).toBeInTheDocument();
  });

  it("the Display dock shares the single drawer slot with Keys", async () => {
    const user = userEvent.setup();
    renderComposer();

    await user.click(control("Display"));
    expect(screen.getByRole("switch", { name: "Wrap lines" })).toBeInTheDocument();

    await user.click(control("Keys"));
    expect(screen.queryByRole("switch", { name: "Wrap lines" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Esc" })).toBeInTheDocument();
  });

  it("display prefs stay reachable on a read-only device", async () => {
    const user = userEvent.setup();
    renderComposer({ readOnly: true });

    // Keys/Quick are write affordances and lock; the gear is local view state and must not.
    expect(control("Keys")).toBeDisabled();
    await user.click(control("Display"));
    expect(screen.getByRole("switch", { name: "Wrap lines" })).toBeInTheDocument();
  });
});

describe("Composer — a composed key queue is guarded on the way out", () => {
  /** Open Keys and stage one chord, so the queue is genuinely dirty. */
  async function stageAKey(user: ReturnType<typeof userEvent.setup>) {
    await user.click(control("Keys"));
    await user.click(screen.getByRole("button", { name: "Ctrl" }));
    await user.click(screen.getByRole("button", { name: "Tab" }));
    expect(screen.getByRole("button", { name: "Remove Ctrl Tab" })).toBeInTheDocument();
  }

  it("the dock's X needs a second tap while keys are staged", async () => {
    const user = userEvent.setup();
    renderComposerWithStatus();
    await stageAKey(user);

    await user.click(screen.getByRole("button", { name: "Close Keys" }));
    // Still open — the composed sequence is not thrown away on one tap.
    expect(screen.getByRole("button", { name: "Remove Ctrl Tab" })).toBeInTheDocument();
    expect(screen.getByTestId("status")).toHaveTextContent(/discard 1 queued key/i);

    await user.click(screen.getByRole("button", { name: "Close Keys" }));
    expect(screen.queryByRole("button", { name: "Esc" })).not.toBeInTheDocument();
  });

  // The ✕ is not the only exit — the Keys toggle and the other drawer buttons unmount the tray just
  // as effectively, which is why the guard lives on the drawer transition rather than the button.
  // The menu's "Keys" row and the tray's own "Keys" segmented tab share an accessible name.
  const controlsToggle = (name: string) => control(name);

  it.each([
    ["the Keys toggle", () => controlsToggle("Keys")],
    ["the Quick toggle", () => controlsToggle("Quick replies")],
    ["the Display gear", () => control("Display")],
  ])("%s also needs a second tap while keys are staged", async (_label, getButton) => {
    const user = userEvent.setup();
    renderComposerWithStatus();
    await stageAKey(user);

    await user.click(getButton());
    expect(screen.getByRole("button", { name: "Remove Ctrl Tab" })).toBeInTheDocument();

    await user.click(getButton());
    expect(screen.queryByRole("button", { name: "Remove Ctrl Tab" })).not.toBeInTheDocument();
  });

  // Over-guarding trains you to double-tap through the confirm reflexively, which kills its value
  // where it matters. One tap of setup is not work worth protecting.
  it("an armed modifier with NO staged keys closes on the first tap", async () => {
    const user = userEvent.setup();
    renderComposer();

    await user.click(control("Keys"));
    await user.click(screen.getByRole("button", { name: "Ctrl" })); // armed, but nothing staged
    await user.click(screen.getByRole("button", { name: "Close Keys" }));

    expect(screen.queryByRole("button", { name: "Esc" })).not.toBeInTheDocument();
  });

  it("a clean Keys dock closes on the first tap", async () => {
    const user = userEvent.setup();
    renderComposer();

    await user.click(control("Keys"));
    await user.click(screen.getByRole("button", { name: "Close Keys" }));

    expect(screen.queryByRole("button", { name: "Esc" })).not.toBeInTheDocument();
  });

  // The count must not outlive the tray: a stale value would arm a phantom confirm on a later,
  // perfectly clean close.
  it("does not arm a phantom confirm on a later clean open", async () => {
    const user = userEvent.setup();
    renderComposer();
    await stageAKey(user);

    await user.click(screen.getByRole("button", { name: "Close Keys" })); // arm
    await user.click(screen.getByRole("button", { name: "Close Keys" })); // discard

    await user.click(control("Keys")); // reopen, empty
    await user.click(screen.getByRole("button", { name: "Close Keys" }));
    expect(screen.queryByRole("button", { name: "Esc" })).not.toBeInTheDocument();
  });
});

describe("Composer — quick replies follow the pane kind", () => {
  it("an agent pane gets the agent set", async () => {
    const user = userEvent.setup();
    renderComposer({ agent: "claude", isShell: false });
    await user.click(control("Quick replies"));

    expect(screen.getByRole("button", { name: "continue" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "commit and push" })).toBeInTheDocument();
  });

  it("a shell pane gets y/n, not the agent phrases", async () => {
    const user = userEvent.setup();
    renderComposer({ agent: "shell", isShell: true });
    await user.click(control("Quick replies"));

    expect(screen.getByRole("button", { name: "y" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "n" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "commit and push" })).not.toBeInTheDocument();
  });
});

// The draft is the message you are in the middle of writing — and the whole reason you leave a pane
// mid-reply is to go read another tab. The composer unmounts when you do (DetailRoute keys AgentChat
// by paneId), so without persistence the message is simply gone. These pin the round trip, the
// per-pane isolation (pane A's text must never appear in pane B), and the clear-on-send.
describe("Composer — draft persistence", () => {
  function draftProps(
    overrides: Partial<ComponentProps<typeof Composer>> = {},
  ): ComponentProps<typeof Composer> {
    return {
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
      ...overrides,
    };
  }

  /** Mounts the composer under a harness that can swap `paneId` IN PLACE (no remount) — the harder
   *  of the two realities the component has to survive. */
  function renderSwitchable(initialPane: string) {
    let swap: ((id: string) => void) | null = null;
    function Harness() {
      const [paneId, setPaneId] = useState(initialPane);
      swap = setPaneId;
      return <Composer {...draftProps({ paneId })} />;
    }
    const router = createMemoryRouter([{ path: "/", element: <Harness /> }]);
    const view = render(<RouterProvider router={router} />);
    return { view, swap: (id: string) => act(() => swap?.(id)) };
  }

  function mount(paneId = "w1:p1") {
    const router = createMemoryRouter([
      { path: "/", element: <Composer {...draftProps({ paneId })} /> },
    ]);
    return render(<RouterProvider router={router} />);
  }

  it("restores the draft after a remount", async () => {
    const user = userEvent.setup();
    const first = mount();
    await user.type(screen.getByPlaceholderText(/type a reply/i), "half a thought");
    first.unmount();

    mount();
    expect(screen.getByPlaceholderText(/type a reply/i)).toHaveValue("half a thought");
  });

  it("keeps drafts per pane — pane A's text never shows in pane B", async () => {
    const user = userEvent.setup();
    const { swap } = renderSwitchable("w1:p1");
    const box = () => screen.getByPlaceholderText(/type a reply/i);

    await user.type(box(), "for pane A");
    swap("w1:p2");
    expect(box()).toHaveValue(""); // no bleed
    await user.type(box(), "for pane B");

    swap("w1:p1");
    expect(box()).toHaveValue("for pane A");
    swap("w1:p2");
    expect(box()).toHaveValue("for pane B");
  });

  it("forgets the draft once the user empties the box", async () => {
    const user = userEvent.setup();
    const first = mount();
    const box = screen.getByPlaceholderText(/type a reply/i);
    await user.type(box, "never mind");
    await user.clear(box);
    first.unmount();

    mount();
    expect(screen.getByPlaceholderText(/type a reply/i)).toHaveValue("");
  });

  it("clears the stored draft on a verified send", async () => {
    const user = userEvent.setup();
    const first = mount();
    await user.type(screen.getByPlaceholderText(/type a reply/i), "looks good");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByPlaceholderText(/type a reply/i)).toHaveValue(""));
    first.unmount();

    mount();
    expect(screen.getByPlaceholderText(/type a reply/i)).toHaveValue("");
  });
});


describe("conversation composer", () => {
  it("keeps attach, model and send in the toolbar, and saves Send while a dialog owns the keyboard", async () => {
    const adds: string[] = [];
    server.use(
      http.get(/\/api\/pane\/[^/]+\/queue$/, () => HttpResponse.json({available:true,scope:"scope",messages:[]})),
      http.post(/\/api\/pane\/[^/]+\/queue$/, async ({request}) => {
        const body = await request.json() as {text:string}; adds.push(body.text);
        return HttpResponse.json({available:true,scope:"scope",messages:[]});
      }),
    );
    renderComposer({nativeWorkbench:true,dialogPresent:true,modelControl:<button>Choose model</button>,usageControls:<button>Usage</button>});
    // The model chip sits in the toolbar under the draft; usage stays behind the ⋯ menu.
    const row = screen.getByRole("group",{name:"Message tools"});
    expect(within(row).getByRole("button",{name:"Choose model"})).toBeInTheDocument();
    expect(within(row).getByRole("button",{name:"Attach image"})).toBeInTheDocument();
    expect(screen.queryByRole("button",{name:"Usage"})).not.toBeInTheDocument();
    expect(screen.queryByRole("button",{name:"More message actions"})).not.toBeInTheDocument();
    expect(screen.queryByRole("button",{name:"Add to queue"})).not.toBeInTheDocument();
    expect(screen.getByRole("button",{name:"Attach image"})).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox"),"keep this message");
    await userEvent.click(screen.getByRole("button",{name:"Send"}));
    await waitFor(() => expect(adds).toEqual(["keep this message"]));
    expect(screen.getByRole("textbox")).toHaveValue("");
  });
});


it.each([true, false])("resumes live following only when the queued message is saved (%s)", async (saved) => {
  server.use(
    http.get(/\/api\/pane\/[^/]+\/queue$/, () => HttpResponse.json({ available: true, scope: "test-conversation", messages: [] })),
    http.post(/\/api\/pane\/[^/]+\/queue$/, () => saved
      ? HttpResponse.json({ available: true, scope: "test-conversation", messages: [] })
      : HttpResponse.json({ error: "Queue unavailable" }, { status: 503 })),
  );
  const props = renderComposer({ nativeWorkbench: true, agent: "codex", working: true });
  const input = screen.getByRole("textbox");
  await userEvent.type(input, "Continue this investigation");
  await userEvent.click(screen.getByRole("button", { name: /^Send$/ }));
  await userEvent.click(await screen.findByRole("button", { name: /queue for later/i }));
  if (saved) {
    await waitFor(() => expect(input).toHaveValue(""));
    expect(props.onSent).toHaveBeenCalledOnce();
  } else {
    await screen.findByText(/Queue unavailable/);
    expect(input).toHaveValue("Continue this investigation");
    expect(props.onSent).not.toHaveBeenCalled();
  }
});

describe("Composer — images and the pending bubble", () => {
  const UPLOAD = "/home/you/.local/state/collie/uploads/w1-p1-mabc123-1234abcd.png";

  function serveQueue(add: (body: { id: string; text: string }) => Response | Promise<Response>) {
    const adds: string[] = [];
    server.use(
      http.post(/\/api\/pane\/[^/]+\/upload$/, () => HttpResponse.json({ ok: true, path: UPLOAD })),
      http.get(/\/api\/pane\/[^/]+\/queue$/, () => HttpResponse.json({ available: true, scope: "scope", messages: [] })),
      http.post(/\/api\/pane\/[^/]+\/queue$/, async ({ request }) => {
        const body = (await request.json()) as { id: string; text: string };
        adds.push(body.text);
        return add(body);
      }),
    );
    return adds;
  }

  async function attachAndType(text: string) {
    const box = screen.getByRole("textbox");
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [new File(["x"], "shot.png", { type: "image/png" })] },
    });
    await screen.findByRole("button", { name: "Remove Image 1" });
    await waitFor(() => expect(screen.queryByText("Uploading…")).not.toBeInTheDocument());
    await userEvent.type(box, text);
    return box;
  }

  it("sends the path with the text, clears the composer at once and shows a pending bubble", async () => {
    let accept!: () => void;
    const sends = serveSend((body) => new Promise((resolve) => { accept = () => resolve(accepted(body)); }));
    serveQueue(() => HttpResponse.json({ available: true, scope: "scope", messages: [] }));
    renderComposer({ nativeWorkbench: true });
    const box = await attachAndType("see the edge");
    // The path never appears in the textarea; it is only on the wire.
    expect(box).toHaveValue("see the edge");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(sends.map((send) => send.text)).toEqual([`see the edge ${UPLOAD}`]));
    expect(box).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Remove Image 1" })).not.toBeInTheDocument();
    const scope = localSendScope("w1:p1", undefined);
    expect(listLocalSends(scope)).toEqual([expect.objectContaining({ text: `see the edge ${UPLOAD}`, state: "sending" })]);

    await act(async () => accept());
    await waitFor(() => expect(listLocalSends(scope)).toEqual([expect.objectContaining({ state: "sent" })]));
    expect(loadDraft(undefined, "w1:p1")).toBeNull();
  });

  it("queues for later behind a busy agent, and the bubble follows its own row", async () => {
    let accept!: () => void;
    const adds = serveQueue((body) => new Promise((resolve) => {
      accept = () => resolve(HttpResponse.json({ available: true, scope: "scope", messages: [{ id: body.id, text: body.text, state: "queued", createdAt: 0, revision: 1, deliveryMode: "afterTurn", waitingFor: "working" }] }));
    }));
    renderComposer({ nativeWorkbench: true, working: true });
    const box = await attachAndType("see the edge");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await userEvent.click(await screen.findByRole("button", { name: /queue for later/i }));

    await waitFor(() => expect(adds).toEqual([`see the edge ${UPLOAD}`]));
    expect(box).toHaveValue("");
    const scope = localSendScope("w1:p1", undefined);
    await act(async () => accept());
    await waitFor(() => expect(listLocalSends(scope)).toEqual([expect.objectContaining({ state: "queued", queueState: "queued", waitingFor: "working", deliveryMode: "afterTurn" })]));
    // The queued message lives on its bubble, so the queue strip does not list it a second time.
    expect(screen.queryByRole("region", { name: "Queued messages" })).not.toBeInTheDocument();
    expect(loadDraft(undefined, "w1:p1")).toBeNull();
  });

  it("puts the text and the image back when the queue refuses the message", async () => {
    serveQueue(() => HttpResponse.json({ error: "down" }, { status: 503 }));
    renderComposer({ nativeWorkbench: true, working: true });
    const box = await attachAndType("keep me");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await userEvent.click(await screen.findByRole("button", { name: /queue for later/i }));

    await waitFor(() => expect(box).toHaveValue("keep me"));
    expect(screen.getByRole("button", { name: "Remove Image 1" })).toBeInTheDocument();
    // Back in the box, so no "Not sent" bubble doubles it.
    expect(listLocalSends(localSendScope("w1:p1", undefined))).toEqual([]);
    expect(loadDraft(undefined, "w1:p1")).toBe(`keep me ${UPLOAD}`);
  });

  it("restores a saved draft's upload as a chip, not as text", () => {
    saveDraft(undefined, "w1:p1", `half a thought ${UPLOAD}`);
    renderComposer({ nativeWorkbench: true });
    expect(screen.getByRole("textbox")).toHaveValue("half a thought");
    expect(screen.getByRole("button", { name: "Remove Image 1" })).toBeInTheDocument();
  });

  it("will not send while an image is still uploading", async () => {
    server.use(http.post(/\/api\/pane\/[^/]+\/upload$/, () => new Promise<Response>(() => {})));
    renderComposer({ nativeWorkbench: true });
    await userEvent.type(screen.getByRole("textbox"), "wait for it");
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [new File(["x"], "shot.png", { type: "image/png" })] },
    });
    expect(await screen.findByText("Uploading…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });
});

describe("Composer — a busy agent gets a choice at send time (ADR 0056)", () => {
  type Row = { id: string; text: string; state: "queued" | "sending" | "paused"; createdAt: number; revision: number; deliveryMode?: string; waitingFor?: string; stranded?: { reason: string; since: number }; device?: string | null };
  type Delivered = { id: string; text: string; sentAt: number; deliveryMode?: string; native?: string };
  /** The bridge's queue route, stateful: rows added here are listed until a test moves them. */
  function serveQueueRoute() {
    const state = { rows: [] as Row[], delivered: [] as Delivered[], posts: [] as Array<Record<string, unknown>>, reads: 0 };
    const page = () => ({ available: true, scope: "scope", messages: state.rows, delivered: state.delivered });
    server.use(
      http.get(/\/api\/pane\/[^/]+\/queue$/, () => {
        state.reads++;
        return HttpResponse.json(page());
      }),
      http.post(/\/api\/pane\/[^/]+\/queue$/, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        state.posts.push(body);
        if (body.action === "add") state.rows.push({ id: String(body.id), text: String(body.text), state: "queued", createdAt: 1, revision: 1, deliveryMode: String(body.deliveryMode), waitingFor: "working" });
        return HttpResponse.json(page());
      }),
    );
    return state;
  }

  it("an idle agent gets the message directly: one send, no queue write, no question", async () => {
    const user = userEvent.setup();
    const queue = serveQueueRoute();
    const wire = watchWrites();
    const props = renderComposer({ nativeWorkbench: true });
    await waitFor(() => expect(queue.reads).toBeGreaterThan(0)); // the queue is there, and still unused
    await user.type(screen.getByRole("textbox"), "go ahead");
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(props.onSent).toHaveBeenCalledOnce());
    expect(wire).toEqual(["send"]);
    expect(screen.queryByRole("group", { name: /is working/i })).not.toBeInTheDocument();
  });

  it.each([
    ["claude", "Send now", "asap", /claude's queue/i],
    ["claude", "Queue for later", "afterTurn", /until claude finishes this turn/i],
    ["codex", "Send now", "steer", /steers this turn/i],
    ["codex", "Queue for later", "afterTurn", /codex's queue and runs as the next turn/i],
  ] as const)("a busy %s: %s stores mode %s", async (agent, choice, mode, hint) => {
    const user = userEvent.setup();
    const queue = serveQueueRoute();
    const wire = watchWrites();
    renderComposer({ nativeWorkbench: true, agent, working: true });
    await user.type(screen.getByRole("textbox"), "one more thing");
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Send" }));
    const panel = await screen.findByRole("group", { name: /is working/i });
    expect(within(panel).getByText(hint)).toBeInTheDocument();
    expect(wire).toEqual([]); // the question alone sends nothing
    await user.click(within(panel).getByRole("button", { name: new RegExp(choice, "i") }));
    await waitFor(() => expect(queue.posts).toEqual([expect.objectContaining({ action: "add", text: "one more thing", deliveryMode: mode })]));
    expect(wire).toEqual(["queue"]);
    expect(screen.queryByRole("group", { name: /is working/i })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue(""));
  });

  it("Cancel keeps the draft and sends nothing", async () => {
    const user = userEvent.setup();
    serveQueueRoute();
    const wire = watchWrites();
    renderComposer({ nativeWorkbench: true, working: true });
    await user.type(screen.getByRole("textbox"), "not yet");
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("textbox")).toHaveValue("not yet");
    expect(wire).toEqual([]);
  });

  it("without the queue (terminal view), a busy agent's Send types now, as at the keyboard", async () => {
    const user = userEvent.setup();
    const wire = watchWrites();
    const props = renderComposer({ working: true });
    await user.type(screen.getByRole("textbox"), "steer it");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(props.onSent).toHaveBeenCalledOnce());
    expect(wire).toEqual(["send"]);
  });

  it("two identical messages follow their own rows, matched by id", async () => {
    const user = userEvent.setup();
    const queue = serveQueueRoute();
    renderComposer({ nativeWorkbench: true, working: true });
    const scope = localSendScope("w1:p1", undefined);
    for (let n = 0; n < 2; n++) {
      await user.type(screen.getByRole("textbox"), "ok");
      await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled());
      await user.click(screen.getByRole("button", { name: "Send" }));
      await user.click(await screen.findByRole("button", { name: /queue for later/i }));
      await waitFor(() => expect(queue.posts).toHaveLength(n + 1));
    }
    const [first, second] = queue.rows;
    expect(first!.id).not.toBe(second!.id);
    await waitFor(() => expect(listLocalSends(scope).map((echo) => echo.queueId)).toEqual([first!.id, second!.id]));
    // The bridge delivers the first one; Claude's journal shows it read. The second still waits.
    queue.rows = [second!];
    queue.delivered = [{ id: first!.id, text: "ok", sentAt: 2, deliveryMode: "afterTurn", native: "absorbed" }];
    await user.type(screen.getByRole("textbox"), "x");
    await user.click(screen.getByRole("button", { name: "Send" })); // any queue write re-reads the page
    await user.click(await screen.findByRole("button", { name: /queue for later/i }));
    await waitFor(() =>
      expect(listLocalSends(scope).slice(0, 2)).toEqual([
        expect.objectContaining({ queueId: first!.id, state: "sent", native: "absorbed" }),
        expect.objectContaining({ queueId: second!.id, state: "queued", queueState: "queued" }),
      ]),
    );
  });

  it("Read it now takes a second tap, then asks the bridge with an explicit confirm", async () => {
    const user = userEvent.setup();
    const queue = serveQueueRoute();
    queue.delivered = [{ id: "row-1", text: "from the laptop", sentAt: 1, deliveryMode: "asap", native: "enqueued" }];
    renderComposerWithStatus({ nativeWorkbench: true, working: true });
    const strip = await screen.findByRole("region", { name: "Queued messages" });
    expect(within(strip).getByText(/in claude's queue/i)).toBeInTheDocument();
    await user.click(within(strip).getByRole("button", { name: "Read it now" }));
    expect(queue.posts).toEqual([]);
    expect(screen.getByTestId("status")).toHaveTextContent(/moves a running command to the background/i);
    await user.click(within(strip).getByRole("button", { name: /tap again to read it now/i }));
    await waitFor(() => expect(queue.posts).toEqual([{ scope: "scope", action: "now", id: "row-1", confirm: true }]));
  });
});
