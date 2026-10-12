import { useState, type ComponentProps } from "react";
import { readFileSync } from "node:fs";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider, useLoaderData, useParams } from "react-router";

import { __resetConnectionHealth, CONNECTION_LOST_MS, markLive } from "@/lib/connection-health";

// Mock the race guard at AgentChat's seam so the frozen-revision tests can observe exactly what
// `detectedRevision` the tap handler passes (the guard's own behaviour is covered in
// prompt-select-block.test.tsx). The other tests in this file never reach it.
vi.mock("@/lib/prompt-action", () => ({
  submitPromptOption: vi.fn(),
}));
vi.mock("@/lib/wizard-action", () => ({
  submitWizardKeys: vi.fn(),
}));

import { server } from "@/test/setup";
import { clearStatus } from "@/lib/status";
import { dismissModelPicker } from "@/lib/dismiss-model-picker";
vi.mock("@/lib/dismiss-model-picker", () => ({ dismissModelPicker: vi.fn() }));
import { submitPromptOption } from "@/lib/prompt-action";
import { submitWizardKeys } from "@/lib/wizard-action";
import { fixtureAgents } from "@/test/handlers";
import { WorkbenchNavigationContext, type WorkbenchNavigation } from "@/lib/workbench-navigation";
import { AgentChat } from "./agent-chat";
import { ConnectionBanner } from "./connection-banner";
import { StatusArea } from "./status-area";

it.each(["codex", "claude"])("recovers %s history without a SessionStart hook", async (kind) => {
  const paneId = `missing-hook-${kind}`;
  server.use(http.get(/\/api\/pane\/[^/]+\/history$/, () => HttpResponse.json({
    paneId, available: true, entries: [{ uuid: "recovered", ts: "", role: "assistant", parts: [{ kind: "text", text: "Recovered conversation" }] }],
    total: 1, hasMore: false, fileTruncated: false,
  })));
  const agent = { ...fixtureAgents[0]!, paneId, agent: kind, status: "unknown" as const, hasSession: false };
  renderChat({ paneId, agent, agents: [agent], text: "" });
  expect(await screen.findByText("Recovered conversation")).toBeInTheDocument();
});

// Measured on the live bridge (read-only, 2026-10-11): Herdr reported working 157-1636 ms after
// Claude's own session file said the turn runs (ADR 0067). The chat's Working… waited for Herdr.
it("says Working… as soon as the CLI's own state says the turn runs, before Herdr does", async () => {
  const paneId = "turn-before-herdr";
  server.use(http.get(/\/api\/pane\/[^/]+\/history$/, () => HttpResponse.json({
    paneId, available: true, entries: [{ uuid: "asked", ts: "", role: "user", parts: [{ kind: "text", text: "run the tests" }] }],
    total: 1, hasMore: false, fileTruncated: false,
  })));
  const agent = { ...fixtureAgents[0]!, paneId, agent: "claude", status: "idle" as const, hasSession: true, turn: { running: true, source: "claude-session" as const } };
  renderChat({ paneId, agent, agents: [agent], text: "" });
  expect(await screen.findByText("run the tests")).toBeInTheDocument();
  expect(screen.getByText("Working…")).toBeInTheDocument();
});

// The detail view's core job: type a reply and submit it to the bridge. This drives the whole wired
// path (composer → api.sendReply → MSW → optimistic clear / error surfacing) end-to-end, which no
// other test covers. AgentChat uses useRevalidator, so it needs a data router (createMemoryRouter).

beforeAll(() => {
  // jsdom doesn't implement scrollTo; the terminal mirror's auto-scroll calls it.
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => { clearStatus(); vi.mocked(dismissModelPicker).mockReset(); vi.mocked(dismissModelPicker).mockResolvedValue({ ok: true }); });

/** Every secondary tool is a row in the header's ⋯ menu. */
async function openMenuItem(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("button", { name: "Conversation actions" }));
  await user.click(screen.getByRole("button", { name }));
}

function renderChat(overrides: Partial<ComponentProps<typeof AgentChat>> = {}, navigation?: WorkbenchNavigation, { banner = false } = {}) {
  const agent = fixtureAgents[0]!; // a blocked claude agent
  const props: ComponentProps<typeof AgentChat> = {
    paneId: agent.paneId,
    agent,
    agents: fixtureAgents,
    shellPanes: [],
    tabs: [],
    text: "recent pane output",
    onBack: vi.fn(),
    onSelect: vi.fn(),
    ...overrides,
  };
  // The chat's own route, so the shared header draws what a pane gets rather than Home's bar. The
  // outage notice sits above it, as RootLayout mounts it, where a case is about who names an outage.
  const notice = banner && <ConnectionBanner bridge={props.bridge ?? "connected"} error={props.error ?? false} authError={props.authError ?? false} />;
  const element = <>{notice}<AgentChat {...props} /><StatusArea /></>;
  const router = createMemoryRouter([{ path: "/pane/:paneId", element: navigation ? <WorkbenchNavigationContext value={navigation}>{element}</WorkbenchNavigationContext> : element }],
    { initialEntries: [`/pane/${encodeURIComponent(props.paneId)}`] });
  render(<RouterProvider router={router} />);
  return props;
}

describe("AgentChat — reply flow", () => {
  it("sends a typed reply and clears the composer on success", async () => {
    const user = userEvent.setup();
    renderChat();
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "looks good");
    expect(box).toHaveValue("looks good");

    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(box).toHaveValue(""));
  });

  it("keeps the draft and surfaces the error when the bridge rejects the send", async () => {
    server.use(
      http.post(/\/api\/pane\/[^/]+\/send$/, () =>
        HttpResponse.json({ ok: false, error: "agent busy" }),
      ),
    );
    const user = userEvent.setup();
    renderChat();
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "retry this");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("agent busy")).toBeInTheDocument();
    expect(box).toHaveValue("retry this"); // not cleared on failure
  });

  it("keeps navigation available while drafting and after clearing", async () => {
    const user = userEvent.setup();
    renderChat({ agent: { ...fixtureAgents[0]!, status: "idle" } });
    const box = screen.getByPlaceholderText(/type a reply/i);
    await user.type(box, "read this while I draft");
    expect(document.documentElement).not.toHaveAttribute("data-collie-composer-focus");
    expect(screen.queryByRole("button", { name: "Show navigation", hidden: true })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Conversation actions" })).toBeVisible();
    await user.clear(box);
    expect(document.documentElement).not.toHaveAttribute("data-collie-composer-focus");
  });
});

// Echoes the project a title tap opened.
function ProjectSentinel() {
  const { projectSlug } = useParams();
  return <div>project:{projectSlug ?? "none"}</div>;
}

/** A shell in another tab of fixtureAgents[0]'s workspace, so the workspace holds more than this pane. */
const neighbourShell = { ...fixtureAgents[0]!, paneId: "w1:shell", tabId: "w1:t9", kind: "shell" as const, agent: "shell", status: "idle" as const };

describe("AgentChat — header title block", () => {
  const named = { ...fixtureAgents[0]!, paneLabel: "Working Claude", tabLabel: "review" };

  it("names the pane as every row does and says where it lives under the name", () => {
    renderChat({ agent: named, agents: [named] });
    const header = screen.getByRole("banner");
    expect(within(header).getByRole("heading", { level: 1 })).toHaveTextContent(/^Working Claude/);
    expect(within(header).getByText("webapp")).toBeInTheDocument();
    expect(within(header).getByText("review")).toBeInTheDocument();
    // The folder is no longer the second line; the place is.
    expect(within(header).queryByText("~/webapp")).toBeNull();
  });

  it("leads a phone chat with a back to Home instead of the brand mark", async () => {
    const props = renderChat({ agent: named, agents: [named] }, { open: false, onOpen: vi.fn() });
    expect(screen.queryByRole("button", { name: "Open navigation" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Back to Home" }));
    expect(props.onBack).toHaveBeenCalledOnce();
  });

  it("opens the navigation sheet from the title, where every workspace, tab and pane is one tap away", async () => {
    const onOpen = vi.fn();
    renderChat({ agent: named, agents: [named] }, { open: false, onOpen });
    const title = screen.getByRole("button", { name: /^Working Claude/ });
    expect(title).toHaveAttribute("aria-haspopup", "dialog");
    await userEvent.click(title);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  // The outage is named by the banner, or before it by the card or the composer; the header keeps
  // saying where the pane lives, so the screen never names the same outage twice.
  it("keeps the pane's place under the title while Herdr isn't responding", () => {
    renderChat({ agent: named, agents: [named], bridge: "disconnected" });
    const header = screen.getByRole("banner");
    expect(within(header).getByText("webapp")).toBeInTheDocument();
    expect(within(header).getByText("review")).toBeInTheDocument();
    expect(within(header).queryByText(/Herdr/)).not.toBeInTheDocument();
  });

  it("keeps the folder one tap away in the ⋯ menu", async () => {
    renderChat({ agent: named, agents: [named] });
    await userEvent.click(screen.getByRole("button", { name: "Conversation actions" }));
    expect(within(screen.getByRole("dialog", { name: "Conversation actions" })).getByText("~/webapp")).toBeInTheDocument();
  });

  it("drops the unlabeled grab handle: the terminal view switches panes from the title too", () => {
    const shell = { ...fixtureAgents[0]!, kind: "shell" as const, agent: "shell", status: "idle" as const };
    renderChat({ agent: shell, agents: [], shellPanes: [shell] });
    expect(screen.queryByRole("button", { name: "Switch pane" })).toBeNull();
  });

  // A workspace has no page: its tabs and panes are the strips above the conversation.
  it("opens no workspace page from a workspace pane's title, however many panes the workspace holds", () => {
    renderChat({ shellPanes: [neighbourShell] });
    expect(screen.getByText("webapp")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /overview/i })).toBeNull();
  });

  it("opens the project's page from a project pane's title", async () => {
    const user = userEvent.setup();
    const agent = fixtureAgents[0]!;
    const router = createMemoryRouter(
      [
        { path: "/project/:projectSlug", element: <ProjectSentinel /> },
        {
          path: "/pane/:paneId",
          element: (
            <AgentChat
              paneId={agent.paneId}
              agent={agent}
              project={{ slug: "shop", name: "Shop", role: "coordinator" }}
              agents={fixtureAgents}
              shellPanes={[neighbourShell]}
              tabs={[]}
              text="out"
              onBack={vi.fn()}
              onSelect={vi.fn()}
            />
          ),
        },
      ],
      { initialEntries: ["/pane/w1:p1"] },
    );
    render(<RouterProvider router={router} />);

    await user.click(screen.getByRole("button", { name: "Open Shop overview" }));
    expect(await screen.findByText("project:shop")).toBeInTheDocument();
  });
});

describe("AgentChat — read-only device", () => {
  it("disables the composer and shows the banner when the device isn't authorised", () => {
    renderChat({ device: { enforced: true, device: "spare-phone", authorized: false } });

    // The banner names the read-only state (and the device id), and the composer is locked.
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
    expect(screen.getByText(/spare-phone/)).toBeInTheDocument();
    const box = screen.getByPlaceholderText(/read-only — device not authorised/i);
    expect(box).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    // The terminal mirror still renders — reading is always allowed.
    expect(screen.getByText("recent pane output")).toBeInTheDocument();
  });

  it("keeps the composer live for an authorised device", () => {
    renderChat({ device: { enforced: true, device: "my-phone", authorized: true } });
    expect(screen.queryByText(/read-only/i)).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/type a reply/i)).not.toBeDisabled();
  });
});

describe("AgentChat — raw-terminal escape hatch", () => {
  afterEach(() => localStorage.clear());

  function enableRawTerminal(): void {
    localStorage.setItem(
      "collie:raw-terminal-scopes:v1",
      JSON.stringify({ '["default","w1:p1"]': true }),
    );
  }

  it("lifts a tail menu into buttons by default (grammars on)", async () => {
    renderChat({ text: MENU_TEXT });
    expect(await screen.findByRole("button", { name: "Yes" })).toBeInTheDocument();
    // The raw option row is consumed into the button, not shown as text.
    expect(screen.queryByText(/❯ 1\. Yes/)).not.toBeInTheDocument();
  });

  it.each(["idle", "working"] as const)("opens a fresh %s agent in the workbench before its first journal entry", async (status) => {
    const user = userEvent.setup();
    const fresh = { ...fixtureAgents[1]!, status, hasSession: false };
    renderChat({ agent: fresh, agents: [fresh], text: "Codex is ready" });

    expect(screen.getByRole("region", { name: "Live conversation" })).toBeInTheDocument();
    expect(await screen.findByText("what changed today?")).toBeInTheDocument();
    expect(screen.queryByText("Codex is ready")).not.toBeInTheDocument();

    await openMenuItem(user, "Terminal view");
    expect(screen.getByText("Codex is ready")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Conversation actions" }));
    expect(screen.getByRole("button", { name: "Terminal view" })).toHaveAttribute("aria-pressed", "true");
  });

  it("promotes a newly-created shell to the Codex workbench without remounting the pane", async () => {
    const user = userEvent.setup();
    const shell = {
      ...fixtureAgents[1]!,
      agent: "shell",
      kind: "shell" as const,
      status: "unknown" as const,
      hasSession: false,
    };

    function ShellToCodex() {
      const [phase, setPhase] = useState<"shell" | "classified" | "journal">("shell");
      const current = phase === "shell"
        ? shell
        : {
            ...shell,
            agent: "codex",
            kind: "agent" as const,
            status: phase === "classified" ? "unknown" as const : "idle" as const,
            hasSession: phase === "journal",
          };
      return (
        <>
          <button type="button" onClick={() => setPhase("classified")}>Classify Codex</button>
          <button type="button" onClick={() => setPhase("journal")}>Attach journal</button>
          <AgentChat
            paneId={current.paneId}
            agent={current}
            agents={current.kind === "agent" ? [current] : []}
            shellPanes={current.kind === "shell" ? [current] : []}
            tabs={[]}
            text={phase === "shell" ? "$ codex" : "Codex is starting"}
            onBack={vi.fn()}
            onSelect={vi.fn()}
          />
        </>
      );
    }

    const router = createMemoryRouter([{ path: "/", element: <ShellToCodex /> }]);
    render(<RouterProvider router={router} />);

    expect(screen.queryByRole("region", { name: "Live conversation" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Classify Codex" }));
    expect(screen.getByRole("region", { name: "Live conversation" })).toBeInTheDocument();
    expect(await screen.findByText("what changed today?")).toBeInTheDocument();

    const box = screen.getByPlaceholderText(/type a reply/i);
    await user.type(box, "first message from the phone");
    expect(box).toHaveValue("first message from the phone");

    await user.click(screen.getByRole("button", { name: "Attach journal" }));
    expect(screen.getByRole("region", { name: "Live conversation" })).toBeInTheDocument();
    expect(box).toHaveValue("first message from the phone");
  });

  it("shows a 44px Stop control while Codex is generating and routes the interrupt to its session", async () => {
    const user = userEvent.setup();
    const requests: string[] = [];
    server.use(
      http.post(/\/api\/pane\/[^/]+\/interrupt/, ({ request }) => {
        requests.push(request.url);
        return HttpResponse.json({ ok: true, pressed: true, queued: null, held: 0 });
      }),
    );
    const working = { ...fixtureAgents[1]!, status: "working" as const, hasSession: false };
    renderChat({ agent: working, agents: [working], session: "phone", text: "Codex is working" });

    const stop = screen.getByRole("button", { name: "Stop" });
    // 32px visual circle; the 44px target comes from the hit-area pseudo-element (workbench.css).
    expect(stop).toHaveClass("hit-area");
    await user.click(stop);

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(new URL(requests[0]!).searchParams.get("session")).toBe("phone");
    expect(await screen.findByText("Stopping…")).toBeInTheDocument();
  });

  it("shows the plain mirror (no buttons, menu as raw text) when raw terminal is on", () => {
    enableRawTerminal();
    renderChat({ text: MENU_TEXT });
    // No native prompt buttons — the escape hatch bypasses the block grammars entirely…
    expect(screen.queryByRole("button", { name: "Yes" })).not.toBeInTheDocument();
    // …and the menu is rendered verbatim in the mirror, drivable by the keys pad.
    expect(screen.getByText(/1\. Yes/)).toBeInTheDocument();
  });

  // "Tap to type" — on, the mirror is one big "start typing" target; off, it is a document. The
  // pref must gate ONLY the focus, never the mirror's own controls: someone who turned it off to
  // stop the keyboard appearing has not asked to lose the prompt buttons.
  it("focuses the composer on a mirror tap by default", async () => {
    renderChat({ text: "just some output\n" });
    const line = screen.getByText(/just some output/);
    fireEvent.click(line);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByPlaceholderText(/Type a reply/i)));
  });

  it("leaves focus alone on a mirror tap when Tap to type is off", async () => {
    localStorage.setItem(
      "collie:display-prefs:v5",
      JSON.stringify({ wrap: true, fontSize: 11, rawTerminal: false, tapToFocus: false }),
    );
    renderChat({ text: "just some output\n" });
    const before = document.activeElement;
    fireEvent.click(screen.getByText(/just some output/));
    expect(document.activeElement).toBe(before);
    expect(document.activeElement).not.toBe(screen.getByPlaceholderText(/Type a reply/i));
  });

  it("still lifts a menu into buttons with Tap to type off — it gates focus, not the grammars", async () => {
    localStorage.setItem(
      "collie:display-prefs:v5",
      JSON.stringify({ wrap: true, fontSize: 11, rawTerminal: false, tapToFocus: false }),
    );
    renderChat({ text: MENU_TEXT });
    expect(await screen.findByRole("button", { name: "Yes" })).toBeInTheDocument();
  });

  it("lifts a multi-question wizard into native controls by default (grammars on)", async () => {
    renderChat({ text: WIZARD_TEXT });
    expect(await screen.findByRole("button", { name: /Parser/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next step" })).toBeInTheDocument();
    // The stepper header row is consumed into the wizard block, not mirrored as text.
    expect(screen.queryByText(/☐ Focus area/)).not.toBeInTheDocument();
  });

  it("raw terminal bypasses the wizard too — the dialog shows verbatim, keys-pad drivable", () => {
    enableRawTerminal();
    renderChat({ text: WIZARD_TEXT });
    expect(screen.queryByRole("button", { name: /Parser/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next step" })).not.toBeInTheDocument();
    expect(screen.getByText(/1\. Parser/)).toBeInTheDocument();
    expect(screen.getByText(/☐ Focus area/)).toBeInTheDocument();
  });
});

// A minimal permission dialog at the buffer tail — enough for the REAL detector (not a mock) to
// lift it into prompt-select buttons inside AgentChat's mirror.
const MENU_TEXT = [
  "Do you want to create hello.txt?",
  " ❯ 1. Yes",
  "   2. No",
  "",
  " Esc to cancel · Tab to amend",
].join("\n");

// A minimal Claude input-box buffer at the tail: top border, the "❯" prompt, bottom border, then the
// statusline + a hint. For a Claude pane, chrome-stripping peels the box off the mirror and the
// statusline is re-surfaced as the app strip; for a non-Claude pane none of that runs (raw mirror).
const RULE = "─".repeat(60);
const STATUS_TEXT = [
  "Welcome back!",
  "",
  RULE,
  "❯ ",
  RULE,
  "  [Opus 4.8] ~/webapp · main",
  "  ← for agents",
].join("\n");

// A minimal multi-question wizard tail (stepper header + current question) — enough for the REAL
// wizard detector to lift it into the native WizardBlock inside AgentChat's mirror.
const WIZARD_TEXT = [
  "←  ☐ Focus area  ☐ Scope  ✔ Submit  →",
  "",
  "Which focus area should we work on?",
  "",
  "❯ 1. Parser",
  "  2. UI",
  "",
  "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
].join("\n");

describe("AgentChat — prompt-select race guard wiring (frozen {text, revision} pair)", () => {
  const mockSubmit = vi.mocked(submitPromptOption);
  beforeEach(() => {
    mockSubmit.mockReset();
    mockSubmit.mockResolvedValue({ status: "sent" });
  });

  // Renders AgentChat inside a data router with EXTERNALLY-UPDATABLE pane props, standing in for the
  // route loader delivering fresh polls. Returns a setter that advances {text, revision} in place.
  function renderWithLivePane(initial: { text: string; revision: number }) {
    const agent = fixtureAgents[0]!; // a claude agent — the block grammars are gated on the agent
    let advance: (pane: { text: string; revision: number }) => void = () => {
      throw new Error("harness not mounted");
    };
    function Harness() {
      const [pane, setPane] = useState(initial);
      advance = setPane;
      return (
        <AgentChat
          paneId={agent.paneId}
          agent={agent}
          agents={fixtureAgents}
          shellPanes={[]}
          tabs={[]}
          text={pane.text}
          revision={pane.revision}
          onBack={vi.fn()}
          onSelect={vi.fn()}
        />
      );
    }
    const router = createMemoryRouter([{ path: "/", element: <Harness /> }]);
    render(<RouterProvider router={router} />);
    return (pane: { text: string; revision: number }) => advance(pane);
  }

  // The answered menu leaving the screen is the receipt; a "Sent" toast over the thread repeated it
  // (T10). What the screen cannot show, a menu that changed under the tap, still says so.
  it("answers a terminal menu without a Sent toast, and still says when the menu changed under the tap", async () => {
    const user = userEvent.setup();
    renderChat({ text: MENU_TEXT });
    await user.click(await screen.findByRole("button", { name: "Yes" }));
    await waitFor(() => expect(mockSubmit).toHaveBeenCalledOnce());
    await act(async () => {});
    expect(screen.queryByText("Sent")).toBeNull();
    mockSubmit.mockResolvedValueOnce({ status: "changed" });
    await user.click(screen.getByRole("button", { name: "Yes" }));
    expect(await screen.findByText("Menu changed — refreshing")).toBeInTheDocument();
  });

  it("passes the FROZEN revision when the mirror is frozen and the pane advances underneath", async () => {
    // Regression (found in review): the handler used to pass the LIVE loader revision, which keeps
    // advancing via background polls even while the mirror is frozen — so the guard compared
    // live-vs-live and could never catch drift that happened before the freeze. The menu the user
    // taps is derived from the FROZEN text, so the guard must get the revision frozen WITH it.
    const user = userEvent.setup();
    const advance = renderWithLivePane({ text: MENU_TEXT, revision: 1 });

    // The real detector lifted the tail menu into buttons.
    await screen.findByRole("button", { name: "Yes" });

    // Freeze the mirror (opening find pins the tail — the same `following=false` state a scroll-up
    // freeze produces).
    await user.click(screen.getByRole("button", { name: "Conversation actions" }));
    await user.click(screen.getByRole("button", { name: "Find in terminal" }));

    // The pane advances while frozen: new output below the menu + a bumped revision.
    act(() => advance({ text: `${MENU_TEXT}\n● proceeding…\n`, revision: 2 }));

    // The frozen mirror still shows the old menu; the tap must hand the guard the FROZEN pair.
    await user.click(screen.getByRole("button", { name: "Yes" }));

    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));
    expect(mockSubmit).toHaveBeenCalledWith(expect.objectContaining({ detectedRevision: 1 }));
  });

  it("passes the LIVE revision while following (the frozen pair is the live pair)", async () => {
    const user = userEvent.setup();
    const advance = renderWithLivePane({ text: MENU_TEXT, revision: 1 });
    await screen.findByRole("button", { name: "Yes" });

    // Not frozen: a revision-only poll (same text) is adopted into the shown pair.
    act(() => advance({ text: MENU_TEXT, revision: 2 }));

    await user.click(screen.getByRole("button", { name: "Yes" }));

    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));
    expect(mockSubmit).toHaveBeenCalledWith(expect.objectContaining({ detectedRevision: 2 }));
  });

  it("does not let a frozen old dialog block writing or the model control after the live pane clears", async () => {
    const user = userEvent.setup();
    const advance = renderWithLivePane({ text: MENU_TEXT, revision: 1 });
    expect(screen.getByRole("button", { name: "Choose model" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Conversation actions" }));
    await user.click(screen.getByRole("button", { name: "Find in terminal" }));
    act(() => advance({ text: STATUS_TEXT, revision: 2 }));
    expect(screen.getByRole("button", { name: "Choose model" })).toBeEnabled();
    const input = screen.getByRole("textbox", { name: "" });
    await user.type(input, "Writing while reading older output");
    expect(input).toHaveValue("Writing while reading older output");
    // The old approval remains frozen for reading; its action still carries revision 1.
    expect(screen.getByRole("button", { name: "Yes" })).toBeInTheDocument();
  });

  // Same frozen-pair guarantee for the wizard path (the guard mirrors prompt-select's; this locks the
  // wiring so the live-vs-frozen-revision bug can't regress here either).
  it("wizard: passes the FROZEN revision when the mirror is frozen and the pane advances", async () => {
    const mockWizard = vi.mocked(submitWizardKeys);
    mockWizard.mockReset();
    mockWizard.mockResolvedValue({ status: "sent" });

    const user = userEvent.setup();
    const advance = renderWithLivePane({ text: WIZARD_TEXT, revision: 1 });

    // The real detector lifted the multi-question tail into a wizard with option buttons.
    await screen.findByRole("button", { name: /Parser/ });

    await user.click(screen.getByRole("button", { name: "Conversation actions" }));
    await user.click(screen.getByRole("button", { name: "Find in terminal" })); // freeze the tail
    act(() => advance({ text: `${WIZARD_TEXT}\n● advancing…\n`, revision: 2 }));

    await user.click(screen.getByRole("button", { name: /Parser/ }));

    await waitFor(() => expect(mockWizard).toHaveBeenCalledTimes(1));
    expect(mockWizard).toHaveBeenCalledWith(expect.objectContaining({ detectedRevision: 1 }));
  });
});

// The block grammars are provably scoped to the pane's own adapter (spec T8): an agent with no
// adapter gets the plain raw mirror — no prompt-select buttons, no chrome stripping, no re-surfaced
// status strip — because running Claude-tuned matchers on an unverified TUI could mis-lift or
// mis-strip its output. opencode is such an agent (codex graduated to its own adapter); omp has an
// adapter but lifts no dialog kind at all.
describe("AgentChat — block-grammar scoping (an agent with no adapter)", () => {
  // An opencode agent sharing the Claude fixture's ids, so only the agent kind differs from the default.
  const opencodeAgent = { ...fixtureAgents[0]!, agent: "opencode" };

  it("does NOT lift an adapterless agent's tail menu into buttons — it stays raw mirror text", () => {
    renderChat({ text: MENU_TEXT, agent: opencodeAgent });
    // No native prompt buttons: the Claude prompt-select grammar never runs without an adapter…
    expect(screen.queryByRole("button", { name: "Yes" })).not.toBeInTheDocument();
    // …and the menu row shows verbatim in the raw mirror instead (drivable by the keys pad).
    expect(screen.getByText(/1\. Yes/)).toBeInTheDocument();
  });

  it("re-surfaces EVERY row of the Claude input-box statusline as an app strip above the composer", () => {
    renderChat({ text: STATUS_TEXT }); // default claude agent
    const strip = screen.getByText("[Opus 4.8] ~/webapp · main");
    expect(strip.closest("pre")).toBeNull(); // the strip is app chrome, not <pre> mirror text
    // Row 2 of the run: it used to be stripped off the mirror and rendered nowhere at all.
    const second = screen.getByText("← for agents");
    expect(second.closest("pre")).toBeNull();
    // Stacked in the one strip. Compared at the ROW level: each row renders one <span> per ANSI
    // segment (colour is carried through now), so the text node's own parent is a span, not the row.
    const row = (el: HTMLElement) => el.closest("div.truncate");
    expect(row(second)).not.toBe(row(strip));
    expect(row(second)?.parentElement).toBe(row(strip)?.parentElement);
    expect(screen.queryByText(/❯/)).toBeNull(); // the input box was stripped off the mirror
  });

  it("leaves an adapterless agent's input-box buffer fully raw — no status strip, box kept in the mirror", () => {
    renderChat({ text: STATUS_TEXT, agent: opencodeAgent });
    // The statusline is NOT hoisted into an app strip — it stays inside the raw <pre> mirror…
    const status = screen.getByText(/\[Opus 4\.8\] ~\/webapp · main/);
    expect(status.closest("pre")).not.toBeNull();
    // …and the input box itself is preserved verbatim (no chrome stripping for a non-Claude agent).
    expect(screen.getByText(/❯/)).toBeInTheDocument();
  });

  it("strips Grok's composer box and hoists the bottom-border status into the app strip", () => {
    const grokBox = [
      "Sandbox transcript",
      "",
      `  ╭${"─".repeat(60)}╮`,
      "  │ ❯ testing stuff                                                     │",
      `  ╰${"─".repeat(28)} Local Llama (xhigh) · plan ─╯`,
      "",
      "  Shift+Tab:mode  │  Ctrl+.:shortcuts",
    ].join("\n");
    const grokAgent = { ...opencodeAgent, agent: "grok", paneId: "w9:p5" };
    renderChat({ text: grokBox, agent: grokAgent });
    const strip = screen.getByText("Local Llama (xhigh) · plan");
    expect(strip.closest("pre")).toBeNull();
    expect(strip.textContent).toBe("Local Llama (xhigh) · plan");
    expect(screen.queryByText(/Shift\+Tab:mode/)).toBeNull();
    expect(screen.queryByText("╭")).toBeNull();
  });
});

// Regression (user-reported on mobile): tapping a native prompt/wizard/preview option button popped
// the phone keyboard. Those buttons live INSIDE the terminal-mirror div, whose onClick focuses the
// composer (the "tap the mirror to start typing" affordance) — so an option tap bubbled up and
// focused the input, opening the soft keyboard over the output. focusFromMirror must ignore taps
// that land on an interactive control, while still focusing on a tap of the raw terminal text.
describe("AgentChat — mirror tap must not pop the keyboard on option taps", () => {
  const mockSubmit = vi.mocked(submitPromptOption);
  beforeEach(() => {
    mockSubmit.mockReset();
    mockSubmit.mockResolvedValue({ status: "sent" });
  });

  it("does NOT focus the composer when a native prompt option is tapped", async () => {
    const user = userEvent.setup();
    renderChat({ text: MENU_TEXT });
    const box = screen.getByPlaceholderText("Answer the agent first…");
    const yes = await screen.findByRole("button", { name: "Yes" });

    await user.click(yes);
    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));
    expect(box).not.toHaveFocus();
  });

  it("DOES still focus the composer when the raw mirror text is tapped", async () => {
    const user = userEvent.setup();
    renderChat({ text: "recent pane output" });
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.click(screen.getByText("recent pane output"));
    await waitFor(() => expect(box).toHaveFocus());
  });

  it("focuses during the tap event so mobile browsers can open the software keyboard", () => {
    renderChat({ text: "recent pane output" });
    const box = screen.getByPlaceholderText(/type a reply/i);

    fireEvent.click(screen.getByText("recent pane output"));

    expect(box).toHaveFocus();
  });
});

// Connection copy now lives in the single top ConnectionBanner (mounted in RootLayout), not in the
// header — so the pane header has no pill. What it still owns: the agent's status dot, which shows the
// LAST snapshot's status and must stop reading as current during an outage (it dims on any not-live).
describe("AgentChat — shared header: stale-status dimming", () => {
  beforeEach(() => __resetConnectionHealth());

  it("dims the agent's status dot while the connection is not live and restores it on recovery", () => {
    // fixtureAgents[0] is a blocked claude agent → the title says "needs you" to assistive tech.
    let setError: (e: boolean) => void = () => {};
    function Harness() {
      const [error, setErr] = useState(true);
      setError = setErr;
      const agent = fixtureAgents[0]!;
      return (
        <AgentChat
          paneId={agent.paneId}
          agent={agent}
          project={{ slug: "shop", name: "Shop", role: "coordinator" }}
          agents={fixtureAgents}
          shellPanes={[]}
          tabs={[]}
          text="out"
          error={error}
          onBack={vi.fn()}
          onSelect={vi.fn()}
        />
      );
    }
    const router = createMemoryRouter([{ path: "/", element: <Harness /> }]);
    render(<RouterProvider router={router} />);

    const title = screen.getByRole("button", { name: /overview$/ });
    expect(title).toHaveTextContent("needs you");
    const dot = () => title.querySelector("span.rounded-full");
    expect(dot()).toHaveClass("opacity-40"); // not live → frozen status dimmed
    act(() => setError(false)); // snapshot recovers → live
    expect(dot()).not.toHaveClass("opacity-40"); // undimmed instantly
  });
});

// The History affordance opens the agent's own transcript — the only real scrollback a Claude pane
// has, because its terminal runs on the alternate screen and Herdr retains nothing behind the
// viewport. It's gated on the pane actually reporting an agent session, so the button can never
// lead to an empty screen.
describe("AgentChat — history affordance", () => {
  it("is offered in conversation actions when the pane reports an agent session id", async () => {
    const agent = { ...fixtureAgents[0]!, hasSession: true };
    renderChat({ agent, agents: [agent] });
    await userEvent.click(screen.getByRole("button", { name: "Conversation actions" }));
    expect(screen.getByRole("button", { name: /conversation history/i })).toBeVisible();
  });

  it("is hidden when the pane has no agent session (a shell, or a harness without one)", () => {
    renderChat(); // fixture agents carry no session
    expect(screen.queryByRole("button", { name: /conversation history/i })).not.toBeInTheDocument();
  });

  it("keeps a phone header to one ⋯ of five views beside the pane's own actions", async () => {
    const agent = { ...fixtureAgents[0]!, hasSession: true };
    renderChat({ agent, agents: [agent] });
    for (const name of [/conversation history/i, "Show raw terminal", "Artifacts and files", /^Subagents/]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
    await userEvent.click(screen.getByRole("button", { name: "Conversation actions" }));
    const menu = screen.getByRole("dialog", { name: "Conversation actions" });
    expect(within(menu).getAllByRole("button").map((b) => b.textContent)).toEqual(
      expect.arrayContaining(["Find in chat", "Conversation history", "Artifacts and files", "Terminal view", "Display"]));
    for (const heading of ["Terminal", "Shortcuts"]) expect(within(menu).queryByText(heading)).not.toBeInTheDocument();
    // Message tools stay under the composer's chevron, background work behind the processes chip.
    for (const name of ["Keys", "Type into terminal", "Quick replies", "Background activity", "Subagents", "Context and usage"]) {
      expect(within(menu).queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });

  it("shows in Display only what changes the view on screen: the chat's size, or the mirror's settings", async () => {
    const user = userEvent.setup();
    const agent = { ...fixtureAgents[0]!, status: "idle" as const, hasSession: true };
    renderChat({ agent, agents: [agent] });
    await openMenuItem(user, "Display");
    expect(screen.getByRole("radiogroup", { name: "Text size" })).toBeVisible();
    expect(screen.queryByRole("switch", { name: "Wrap lines" })).not.toBeInTheDocument();
    await openMenuItem(user, "Terminal view");
    expect(screen.getByRole("switch", { name: "Wrap lines" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Increase font size" })).toBeVisible();
    expect(screen.queryByRole("radiogroup", { name: "Text size" })).not.toBeInTheDocument();
  });

  it("keeps the terminal switch in a desktop header, beside the ⋯, and no separate Agents button", async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({ matches: query === "(min-width: 1024px)", media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false })) as typeof window.matchMedia;
    try {
      const agent = { ...fixtureAgents[0]!, hasSession: true };
      renderChat({ agent, agents: [agent] });
      expect(screen.getByRole("button", { name: "Show raw terminal" })).toBeVisible();
      expect(screen.queryByRole("button", { name: /^Subagents/ })).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Conversation actions" }));
      expect(screen.queryByRole("button", { name: "Terminal view" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Artifacts and files" })).toBeVisible();
    } finally {
      window.matchMedia = original;
    }
  });

  it("arms Type into terminal and docks Keys from the composer's chevron, keeping the input row to one line", async () => {
    const user = userEvent.setup();
    const agent = { ...fixtureAgents[0]!, status: "idle" as const, hasSession: true };
    renderChat({ agent, agents: [agent] });
    const shortcut = async (name: string) => {
      await user.click(screen.getByRole("button", { name: "Message actions" }));
      await user.click(within(screen.getByRole("dialog", { name: "Message actions" })).getByRole("button", { name }));
    };
    expect(screen.queryByText("Controls")).not.toBeInTheDocument();
    await shortcut("Keys");
    expect(screen.getByRole("button", { name: "Close Keys" })).toBeVisible();
    await shortcut("Type into terminal");
    expect(screen.getByPlaceholderText(/type into the terminal/i)).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Close Keys" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Message actions" }));
    expect(screen.getByRole("button", { name: "Type into terminal" })).toHaveAttribute("aria-pressed", "true");
  });

  it("opens the files browser from the menu and closes the menu behind it", async () => {
    const agent = { ...fixtureAgents[0]!, hasSession: true };
    renderChat({ agent, agents: [agent] });
    await openMenuItem(userEvent.setup(), "Artifacts and files");
    expect(screen.getByRole("dialog", { name: "Artifacts and files" })).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Conversation actions" })).not.toBeInTheDocument();
  });
});

// The top-of-mirror affordance. This block previously rendered on NO pane at all: it was gated on
// `truncated`, which Herdr never sets true even when a read demonstrably cut scrollback off. The
// working signal is `readableLines` (scrollback depth + viewport), and which button appears is
// decided by what the pane can actually offer — the two are never simultaneously possible.
describe("AgentChat — top-of-mirror history affordance", () => {
  const showHistory = () => screen.queryByRole("button", { name: /show entire history/i });
  const loadOlder = () => screen.queryByRole("button", { name: /load older/i });

  it("an agent pane with a transcript offers the full history, not scrollback paging", () => {
    // A Claude pane: alt-screen, so readableLines is just its viewport — there IS no scrollback.
    const agent = { ...fixtureAgents[0]!, hasSession: true, readableLines: 51 };
    renderChat({ agent, agents: [agent], requestedLines: 600 });
    expect(screen.getByRole("region", { name: "Live conversation" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Conversation actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Terminal view" }));
    expect(showHistory()).toBeInTheDocument();
    // A full-width row a thumb reaches: 44 px under a finger (QA 15).
    expect(showHistory()).toHaveClass("coarse:min-h-11");
    expect(loadOlder()).not.toBeInTheDocument();
  });

  it("a pane with real scrollback and no transcript offers Load older", () => {
    // A shell on the primary screen: 6895 lines of ring + 51 viewport, and we've only asked for 600.
    const agent = { ...fixtureAgents[0]!, kind: "shell" as const, readableLines: 6946 };
    renderChat({ agent, agents: [agent], requestedLines: 600 });
    expect(loadOlder()).toBeInTheDocument();
    expect(loadOlder()).toHaveClass("coarse:min-h-11");
    expect(showHistory()).not.toBeInTheDocument();
  });

  it("says Load older is busy while the older lines are on their way", () => {
    const agent = { ...fixtureAgents[0]!, kind: "shell" as const, readableLines: 6946 };
    renderChat({ agent, agents: [agent], requestedLines: 600 });
    fireEvent.click(loadOlder()!);
    expect(screen.getByRole("button", { name: /loading/i })).toHaveAttribute("aria-busy", "true");
  });

  it("offers nothing when the pane has neither", () => {
    const agent = { ...fixtureAgents[0]!, kind: "shell" as const, readableLines: 51 };
    renderChat({ agent, agents: [agent], requestedLines: 600 });
    expect(loadOlder()).not.toBeInTheDocument();
    expect(showHistory()).not.toBeInTheDocument();
  });

  it("hides Load older once the window already covers everything Herdr can return", () => {
    const agent = { ...fixtureAgents[0]!, kind: "shell" as const, readableLines: 700 };
    renderChat({ agent, agents: [agent], requestedLines: 1000 }); // at the cap, past the content
    expect(loadOlder()).not.toBeInTheDocument();
  });

  it("stays hidden when readableLines is unknown (older bridge) rather than offering a dud tap", () => {
    const agent = { ...fixtureAgents[0]!, kind: "shell" as const }; // no readableLines
    renderChat({ agent, agents: [agent], requestedLines: 600 });
    expect(loadOlder()).not.toBeInTheDocument();
    expect(showHistory()).not.toBeInTheDocument();
  });

  it("a transcript wins even when the pane also reports scrollback", () => {
    const agent = { ...fixtureAgents[0]!, hasSession: true, readableLines: 6946 };
    renderChat({ agent, agents: [agent], requestedLines: 600 });
    fireEvent.click(screen.getByRole("button", { name: "Conversation actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Terminal view" }));
    expect(showHistory()).toBeInTheDocument();
    expect(loadOlder()).not.toBeInTheDocument();
  });
});


describe("AgentChat — native workbench interactions", () => {
  it("keeps conversation and draft editable while a native model picker owns agent input", async () => {
    const agent = { ...fixtureAgents[1]!, hasSession: true };
    const menu = readFileSync("src/lib/harness/codex/fixtures/model-picker.txt", "utf8");
    renderChat({ paneId: agent.paneId, agent, agents: [agent], text: `Old terminal output that must not become the conversation\n${menu}` });
    expect(screen.getByRole("region", { name: "Live conversation" })).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Model" })).toBeVisible();
    // The chip stays in the input row as the picker's anchor.
    expect(screen.getByRole("button", { name: "Choose model" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("radio", { name: "gpt-6-astra" })).toBeVisible();
    expect(screen.queryByText("Old terminal output that must not become the conversation")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Live terminal" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Type into terminal" })).not.toBeInTheDocument();
    const input = screen.getByRole("textbox");
    await userEvent.type(input, "My next message");
    expect(input).toHaveValue("My next message");
    expect(screen.queryByRole("dialog", { name: "Model" })).not.toBeInTheDocument();
    expect(dismissModelPicker).toHaveBeenCalledWith(expect.objectContaining({ paneId: agent.paneId, agent: "codex" }));
  });
});


it("preloads once and opens, selects and closes models without terminal requests", async () => {
  let catalogs = 0;
  const writes = vi.fn();
  server.use(
    http.get(/\/api\/pane\/[^/]+\/models$/, () => {
      catalogs++;
      return HttpResponse.json({ available: true, models: [
        { name: "gpt-6-astra", description: "Complex tasks" },
        { name: "gpt-5.6-sol", description: "Everyday tasks" },
      ] });
    }),
    http.post(/\/api\/pane\/[^/]+\/(reply|keys)$/, () => { writes(); return HttpResponse.json({ ok: true }); }),
  );
  const agent = { ...fixtureAgents[1]!, paneId: "instant-model-qa", hasSession: true };
  renderChat({ paneId: agent.paneId, agent, agents: [agent] });
  await waitFor(() => expect(catalogs).toBe(1));
  fireEvent.click(screen.getByRole("button", { name: "Choose model" }));
  const option = await screen.findByRole("radio", { name: "gpt-5.6-sol" });
  expect(option).toBeEnabled();
  fireEvent.click(option);
  expect(option).toHaveAttribute("aria-checked", "true");
  expect(writes).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog", { name: "Model" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Choose model" }));
  expect(screen.getByRole("radio", { name: "gpt-6-astra" })).toBeEnabled();
  expect(catalogs).toBe(1);
  expect(writes).not.toHaveBeenCalled();
  expect(dismissModelPicker).not.toHaveBeenCalled();
});

it("waits for reasoning selection and confirmation repaints before enabling the next tap or reporting success", async () => {
  const initial = readFileSync("src/lib/harness/codex/fixtures/model-reasoning.txt", "utf8");
  const moved = initial.replace("› 1.", "  1.").replace("  3.", "› 3.");
  const idle = readFileSync("src/fixtures/panes/codex--v0150-idle.txt", "utf8");
  const agent = { ...fixtureAgents[1]!, paneId: "reasoning-confirm-qa", hasSession: true };
  let text = initial;
  const writes: string[][] = [];
  server.use(
    http.get(/\/api\/pane\/[^/]+$/, () => HttpResponse.json({ paneId: agent.paneId, text, revision: 0, truncated: false })),
    http.post(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => {
      const body = await request.json() as { keys: string[] };
      writes.push(body.keys);
      return HttpResponse.json({ ok: true });
    }),
  );
  renderChat({ paneId: agent.paneId, agent, agents: [agent], text: initial });
  fireEvent.click(screen.getByRole("radio", { name: "High" }));
  await waitFor(() => expect(writes).toEqual([["Down", "Down"]]));
  expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
  expect(screen.queryByText("Model settings applied")).not.toBeInTheDocument();
  text = moved;
  await waitFor(() => expect(screen.getByRole("radio", { name: "High" })).toHaveAttribute("aria-checked", "true"));
  await waitFor(() => expect(screen.getByRole("button", { name: "Confirm" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(writes).toEqual([["Down", "Down"], ["Enter"]]));
  expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
  expect(screen.queryByText("Model settings applied")).not.toBeInTheDocument();
  text = idle;
  await screen.findByText("Model settings applied");
  expect(screen.queryByRole("dialog", { name: "Model" })).not.toBeInTheDocument();
  expect(dismissModelPicker).not.toHaveBeenCalled();
  expect(writes).toEqual([["Down", "Down"], ["Enter"]]);
});


describe("mobile session startup", () => {
  it("waits for shell output before enabling launch", () => {
    const shell = { ...fixtureAgents[0]!, kind: "shell" as const, agent: "shell" };
    renderChat({ agent: shell, agents: [], shellPanes: [shell], text: "" });
    expect(screen.getByRole("button", { name: "Start Codex" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Start Claude Code" })).toBeDisabled();
    expect(screen.getByText("Preparing the terminal…")).toBeInTheDocument();
  });
  it.each(["Codex", "Claude Code"])("starts %s from a shell without typing a command", async (label) => {
    const user = userEvent.setup();
    const calls: unknown[] = [];
    server.use(http.post("/api/pane/:id/start", async ({ request }) => {
      calls.push(await request.json());
      return HttpResponse.json({ ok: true });
    }));
    const shell = { ...fixtureAgents[0]!, kind: "shell" as const, agent: "shell", hasSession: false };
    renderChat({ agent: shell, agents: [], shellPanes: [shell] });
    await user.click(screen.getByRole("button", { name: `Start ${label}` }));
    await waitFor(() => expect(calls).toEqual([{ agent: label === "Codex" ? "codex" : "claude" }]));
  });
});

it("connects a chosen history without sending a message to the terminal", async () => {
  const id = "11111111-2222-3333-4444-555555555555";
  let connected = false;
  const writes = vi.fn();
  server.use(
    http.get(/\/api\/pane\/[^/]+\/history$/, () => HttpResponse.json(connected ? {
      paneId: "recovery", available: true, sessionKey: id, entries: [{ uuid: "answer", role: "assistant", ts: "", parts: [{ kind: "text", text: "Recovered answer" }] }], hasMore: false, total: 1, fileTruncated: false,
    } : { paneId: "recovery", available: false, reason: "no-session" })),
    http.get(/\/api\/pane\/[^/]+\/conversations$/, () => HttpResponse.json({ conversations: [{ id, title: "My terminal session" }] })),
    http.post(/\/api\/pane\/[^/]+\/connect$/, async ({ request }) => {
      expect(await request.json()).toEqual({ id }); connected = true; return HttpResponse.json({ ok: true });
    }),
    http.post(/\/api\/pane\/[^/]+\/(reply|keys)$/, () => { writes(); return HttpResponse.json({ ok: true }); }),
  );
  const agent = { ...fixtureAgents[1]!, paneId: "recovery", hasSession: false };
  renderChat({ paneId: agent.paneId, agent, agents: [agent] });
  await userEvent.click(await screen.findByRole("button", { name: "Find Codex conversations" }));
  await userEvent.selectOptions(await screen.findByLabelText("Conversation to connect"), id);
  await userEvent.click(screen.getByRole("button", { name: "Connect history" }));
  expect(await screen.findByText("Recovered answer")).toBeInTheDocument();
  expect(writes).not.toHaveBeenCalled();
});

it("keeps an open session on screen when a newer build is announced, even without a draft", async () => {
  const { startSelfUpdate, __resetSelfUpdate, __setReloadImpl } = await import("@/lib/self-update");
  const { observeServerBuild, __resetServerBuild } = await import("@/lib/server-build");
  __resetServerBuild(); __resetSelfUpdate();
  const reload = vi.fn(); __setReloadImpl(reload);
  const stop = startSelfUpdate();
  try {
    renderChat({ agent: { ...fixtureAgents[0]!, status: "idle" } });
    act(() => { observeServerBuild("new-release"); observeServerBuild("new-release"); });
    expect(screen.getByPlaceholderText(/type a reply/i)).toHaveValue("");
    expect(reload).not.toHaveBeenCalled();
  } finally { stop(); __resetServerBuild(); __resetSelfUpdate(); }
});


it("allows a send attempt during a brief signal loss and retains the draft if it fails", async () => {
  __resetConnectionHealth();
  server.use(http.post(/\/api\/pane\/[^/]+\/send$/, () => new HttpResponse("Signal unavailable", { status: 503 })));
  renderChat({ error: true });
  const box = screen.getByPlaceholderText(/type a reply/i);
  await userEvent.type(box, "keep this during weak signal");
  const send = screen.getByRole("button", { name: "Send" });
  expect(send).toBeEnabled();
  await userEvent.click(send);
  await waitFor(() => expect(send).toBeEnabled());
  expect(box).toHaveValue("keep this during weak signal");
});


it("blocks sending immediately after access is refused, without waiting for the outage grace", async () => {
  __resetConnectionHealth();
  renderChat({ error: true, authError: true });
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
});

// A pane that is gone, when the route cannot move off it (Herdr is not answering, or it never was):
// say what happened and offer the way on, instead of a dead composer under "(agent gone)".
describe("AgentChat — a pane that is gone", () => {
  const closed = { ...fixtureAgents[0]!, paneLabel: "Codex" };
  const next = { ...fixtureAgents[0]!, paneId: "w1:p9", paneLabel: "Blocked Claude" };

  it("says the pane closed and opens the pane beside it or Home, with no composer", async () => {
    const props = renderChat({ agent: undefined, closed, next, error: true });
    const header = screen.getByRole("banner");
    expect(within(header).getByRole("heading", { level: 1 })).toHaveTextContent("Pane closed");
    expect(screen.getByRole("heading", { name: "This pane is closed" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByText("(no recent output)")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Open Blocked Claude" }));
    expect(props.onSelect).toHaveBeenCalledWith("w1:p9");
    await userEvent.click(screen.getByRole("button", { name: "Go to Home" }));
    expect(props.onBack).toHaveBeenCalled();
  });

  it("says a link names a pane Herdr no longer has", () => {
    renderChat({ agent: undefined });
    expect(screen.getByRole("heading", { name: "That pane no longer exists" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Open / })).toBeNull();
  });

  it("does not claim a pane is gone while Nenu cannot ask Herdr", () => {
    renderChat({ agent: undefined, error: true });
    expect(screen.getByRole("heading", { name: "Nenu can't find this pane yet" })).toBeInTheDocument();
    expect(within(screen.getByRole("banner")).getByRole("heading", { level: 1 })).toHaveTextContent(/^Pane$/);
  });
});

// A pane opened on the page's last text (its read still on the way) may show an input-box draft that
// is gone by now; only the fresh read may offer it to Take over.
describe("AgentChat — a pane opened on its last text", () => {
  afterEach(() => vi.useRealTimers());

  const box = "─".repeat(40);
  const withDraft = `hello from the pane\n${box}\n❯ a message recalled an hour ago\n${box}`;

  it.each([[false, true], [true, false]])("pending %s offers the terminal's draft: %s", async (pending, offered) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderChat({ text: withDraft, pending });
    act(() => vi.advanceTimersByTime(1600));
    if (offered) expect(await screen.findByText(/draft in terminal/i)).toBeInTheDocument();
    else expect(screen.queryByText(/draft in terminal/i)).toBeNull();
  });
});

it("says the terminal is on its way, not that it printed nothing, while the pane's first read is pending", () => {
  const shell = { ...fixtureAgents[0]!, kind: "shell" as const, agent: "shell", status: "idle" as const };
  renderChat({ agent: shell, agents: [], shellPanes: [shell], text: "", pending: true });
  expect(screen.getByRole("status", { name: "Reading the terminal" })).toBeInTheDocument();
  expect(screen.queryByText("(no recent output)")).toBeNull();
});

// Renaming and closing used to hide behind a long-press or a second tap on the open chip (NAV-11).
describe("AgentChat — the ⋯ menu renames and closes the pane and its tab", () => {
  const agent = { ...fixtureAgents[0]!, paneLabel: "Working Claude" };
  const tabs = [{ tabId: "w1:t1", workspaceId: "w1", number: 1, label: "review", focused: false, paneCount: 1 }];

  it("opens the pane's and the tab's actions from the menu", async () => {
    const user = userEvent.setup();
    renderChat({ agent, agents: [agent], tabs });
    await openMenuItem(user, "Rename or close pane…");
    const paneSheet = screen.getByRole("dialog", { name: "Working Claude" });
    expect(within(paneSheet).getByRole("button", { name: /Rename/ })).toBeInTheDocument();
    expect(within(paneSheet).getByRole("button", { name: /Close pane/ })).toBeInTheDocument();
    await user.click(within(paneSheet).getByRole("button", { name: "Close" }));
    await openMenuItem(user, "Rename or close tab…");
    expect(within(screen.getByRole("dialog", { name: "review" })).getByRole("button", { name: /Close tab/ })).toBeInTheDocument();
  });

  it("offers neither on a device that cannot write", async () => {
    renderChat({ agent, agents: [agent], tabs, device: { enforced: true, device: "spare-phone", authorized: false } });
    await userEvent.click(screen.getByRole("button", { name: "Conversation actions" }));
    expect(screen.queryByRole("button", { name: "Rename or close pane…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rename or close tab…" })).toBeNull();
  });
});

it("names a project's pane in the pane strip as its rows do", () => {
  const coordinator = { ...fixtureAgents[0]!, paneId: "w1:p2", paneLabel: "claude" };
  const projects = [{ slug: "shop", name: "Shop", status: "active" as const, coordinator: { paneId: "w1:p2", agent: "claude", liveStatus: "idle" as const }, threads: [] }];
  renderChat({ agents: [fixtureAgents[0]!, coordinator], projects });
  expect(screen.getByRole("button", { name: /Shop coordinator/ })).toBeInTheDocument();
});

// A project thread's back climbs one level, as its node page's does (NAV-03): to the coordinator it
// runs under, else to its project. Only the project's own coordinator leads Home, since the project
// opens on it.
describe("AgentChat — a project thread's back", () => {
  const coordinatorPane = { ...fixtureAgents[0]!, paneId: "w1:p2", paneLabel: "claude" };
  const thread = (id: string, title: string, parentId: string, role: "worker" | "coordinator", paneId?: string) =>
    ({ id, title, parentId, role, status: "open" as const, ...(paneId ? { paneId } : {}) });
  const shop = (threads: ReturnType<typeof thread>[], coordinator?: string) => [{
    slug: "shop", name: "Shop", status: "active" as const, threads,
    ...(coordinator ? { coordinator: { paneId: coordinator, agent: "claude", liveStatus: "idle" as const } } : {}),
  }];
  const worker = { slug: "shop", name: "Shop", role: "worker" as const };

  it("leads a worker back to its coordinator's chat while that runs", () => {
    renderChat({ session: "work", agents: [fixtureAgents[0]!, coordinatorPane], project: worker,
      projects: shop([thread("t-1", "Checkout", "root", "coordinator", "w1:p2"), thread("t-2", "Pagos", "t-1", "worker", "w1:p1")]) }, { open: false, onOpen: vi.fn() });
    expect(screen.getByRole("link", { name: "Back to Checkout" })).toHaveAttribute("href", "/pane/w1%3Ap2?s=work");
    expect(screen.queryByRole("button", { name: "Back to Home" })).toBeNull();
  });

  it("leads a worker back to its coordinator's page when the coordinator has no chat", () => {
    renderChat({ project: worker, projects: shop([thread("t-1", "Checkout", "root", "coordinator"), thread("t-2", "Pagos", "t-1", "worker", "w1:p1")]) });
    expect(screen.getByRole("link", { name: "Back to Checkout" })).toHaveAttribute("href", "/project/shop/node/t-1");
  });

  it("leads a thread of the project itself back to the project", () => {
    renderChat({ agents: [fixtureAgents[0]!, coordinatorPane], project: worker, projects: shop([thread("t-2", "Pagos", "root", "worker", "w1:p1")], "w1:p2") });
    expect(screen.getByRole("link", { name: "Back to Shop" })).toHaveAttribute("href", "/project/shop");
  });

  it("leads the project's own coordinator Home", () => {
    renderChat({ project: { slug: "shop", name: "Shop", role: "coordinator" }, projects: shop([], "w1:p1") });
    expect(screen.getByRole("button", { name: "Back to Home" })).toBeInTheDocument();
  });
});

// A project lays its Threads and PRs over the chat (ProjectFrame) and brings its own tabs into the
// overlay, so only the header stays above it: the strips belong to the chat underneath.
describe("AgentChat — a project's overlay", () => {
  const sibling = { ...fixtureAgents[0]!, paneId: "w1:p2", paneLabel: "Second pane" };

  it("draws the project's tabs once, inside the overlay", () => {
    const projectTabs = <div role="tablist" aria-label="Project" />;
    renderChat({ strip: projectTabs, overlay: <div>{projectTabs}<p>Threads list</p></div> });
    expect(screen.getAllByRole("tablist", { name: "Project" })).toHaveLength(1);
    expect(screen.getByText("Threads list")).toBeVisible();
  });

  it("keeps a worker's chips and the pane row under the overlay", () => {
    renderChat({ agents: [fixtureAgents[0]!, sibling], strip: <nav aria-label="Threads" />, overlay: <p>Threads list</p> });
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Threads" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Second pane/ })).toBeNull();
  });
});

// The work log names a file as the operator thinks of it inside the project: from the pane's folder.
it("shows a work step's file relative to the pane's folder", async () => {
  const ts = "2026-07-25T06:22:21.253Z";
  server.use(http.get(/\/api\/pane\/[^/]+\/history/, () => HttpResponse.json({
    paneId: "w1:p1", available: true, hasMore: false, total: 2, fileTruncated: false, entries: [
      { uuid: "t1", ts, role: "user", parts: [{ kind: "text", text: "read the stylesheet" }] },
      { uuid: "t2", ts, role: "assistant", parts: [{ kind: "tool", name: "Read", summary: "/home/you/webapp/web/src/workbench.css", result: { text: "ok" } }] },
    ],
  })));
  const agent = { ...fixtureAgents[0]!, status: "idle" as const, hasSession: true };
  renderChat({ agent, agents: [agent] });
  const work = await screen.findByRole("button", { name: /^(Worked|Work log)/ });
  if (work.getAttribute("aria-expanded") === "false") await userEvent.click(work);
  expect(await screen.findByRole("button", { name: /^Read / })).toHaveTextContent(/^Read\s*web\/src\/workbench\.css$/);
});

// A subagent works in its parent's folder, so its work log names the same file the same way.
it("shows a subagent's work step file relative to the pane's folder too", async () => {
  const reviewer = { id: "a1", parentId: "", name: "reviewer", task: "Review the diff", status: "running" };
  server.use(
    http.get(/\/api\/pane\/[^/]+\/subagents$/, () => HttpResponse.json({ available: true, sessionKey: "parent-key", agents: [reviewer], truncated: false })),
    http.get(/\/api\/pane\/[^/]+\/subagent-history$/, () => HttpResponse.json({ sessionKey: "parent-key", agent: reviewer, truncated: false, entries: [
      { uuid: "c1", ts: "2026-07-25T06:22:21.253Z", role: "assistant", parts: [{ kind: "tool", name: "Read", summary: "/home/you/webapp/web/src/workbench.css", result: { text: "ok" } }] },
    ] })),
  );
  const user = userEvent.setup();
  const agent = { ...fixtureAgents[0]!, status: "working" as const, hasSession: true };
  renderChat({ agent, agents: [agent] });
  await user.click(await screen.findByRole("button", { name: /^Processes/ }));
  await user.click(screen.getByRole("button", { name: "Expand reviewer" }));
  await user.click(screen.getByRole("button", { name: "Open conversation: reviewer" }));
  const work = await screen.findByRole("button", { name: /^(Worked|Work log|Working)/ });
  if (work.getAttribute("aria-expanded") === "false") await user.click(work);
  expect(await screen.findByRole("button", { name: /^Read / })).toHaveTextContent(/^Read\s*web\/src\/workbench\.css$/);
});

// Find names what it searches, in the menu and in the bar (T31).
describe("AgentChat — find says what it searches", () => {
  it("finds in the chat while the conversation shows", async () => {
    const agent = { ...fixtureAgents[0]!, status: "idle" as const, hasSession: true };
    renderChat({ agent, agents: [agent] });
    await openMenuItem(userEvent.setup(), "Find in chat");
    expect(screen.getByRole("textbox", { name: "Find in chat" })).toHaveAttribute("placeholder", "Find in chat…");
  });

  it("finds in the terminal while the mirror shows", async () => {
    renderChat();
    await openMenuItem(userEvent.setup(), "Find in terminal");
    expect(screen.getByRole("textbox", { name: "Find in terminal" })).toBeInTheDocument();
  });
});

// The composer names why it is locked, the same reason the question card gives: a refused sign-in is
// not a device that was never authorised, and a silent Herdr is not a lost network.
describe("AgentChat — why the composer is locked", () => {
  beforeEach(() => __resetConnectionHealth());

  it("asks for a new sign-in when access was refused", () => {
    renderChat({ error: true, authError: true });
    expect(screen.getByPlaceholderText("Sign in again to reply")).toBeDisabled();
  });

  it("says Herdr isn't responding as soon as Herdr reports disconnected", () => {
    renderChat({ bridge: "disconnected" });
    expect(screen.getByText("Herdr isn't responding.")).toBeVisible();
    expect(screen.getByPlaceholderText("Drafts are kept.")).toBeEnabled();
  });

  // DetailRoute passes the pane's own refusal as authError while the snapshot may still answer.
  it("asks for a new sign-in when only the pane's read was refused", () => {
    renderChat({ authError: true });
    expect(screen.getByPlaceholderText("Sign in again to reply")).toBeDisabled();
  });

  // Once the outage is sustained the connection banner names it, so the box only says what it keeps.
  it("leaves naming a sustained Herdr outage to the banner", () => {
    vi.useFakeTimers();
    try {
      __resetConnectionHealth();
      renderChat({ bridge: "disconnected" }, undefined, { banner: true });
      expect(screen.getByText("Herdr isn't responding.")).toBeVisible();
      act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS));
      expect(screen.getAllByText(/Herdr isn.t responding/)).toHaveLength(1);
      expect(screen.getByText("Herdr isn’t responding.")).toBeVisible();
      expect(screen.getByPlaceholderText("Drafts are kept.")).toBeEnabled();
      expect(screen.queryByPlaceholderText(/Herdr/)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  // A pane read that answers stamps the connection live while the snapshot still says Herdr is down.
  // The banner stays up until the snapshot recovers, so the box must keep leaving the outage to it.
  it("keeps leaving the outage to the banner while a live pane read leaves the banner up", () => {
    vi.useFakeTimers();
    try {
      __resetConnectionHealth();
      renderChat({ bridge: "disconnected" }, undefined, { banner: true });
      act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS));
      act(() => { markLive(); vi.advanceTimersByTime(1_000); });
      expect(screen.getByText("Herdr isn’t responding.")).toBeVisible();
      expect(screen.getByPlaceholderText("Drafts are kept.")).toBeEnabled();
      expect(screen.queryByPlaceholderText(/Herdr/)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  // Before the banner, a question card on screen is the one place that says why answers stopped.
  it("leaves naming Herdr's outage to the question card when one is on screen", async () => {
    const agent = { ...fixtureAgents[0]!, status: "blocked" as const, hasSession: true };
    server.use(http.get("/api/interactions", () => HttpResponse.json({ interactions: [{
      paneId: agent.paneId, agent: "claude", kind: "permission", family: "permission", question: "Do you want to proceed?",
      context: "Bash command\nmkfifo fixture-fifo", subject: { tool: "Bash", command: "mkfifo fixture-fifo" },
      signature: "sig-1", revision: 1, detectedAt: 0, detailComplete: true,
      options: [{ index: 0, label: "Yes", role: "primary" }, { index: 1, label: "No", role: "deny" }],
    }] })));
    renderChat({ agent, agents: [agent], text: readFileSync("src/fixtures/panes/claude--permission-bash.txt", "utf8"), bridge: "disconnected" });
    const card = await screen.findByRole("region", { name: "Do you want to proceed?" });
    expect(within(card).getByText("Herdr isn't responding. Answers are paused.")).toBeVisible();
    expect(screen.getByPlaceholderText("Drafts are kept.")).toBeInTheDocument();
    expect(within(screen.getByRole("banner")).queryByText(/Herdr/)).not.toBeInTheDocument();
  });

  // Before the banner, one quiet line above the box names the outage, empty or with a draft, and
  // only one surface names it at a time. The placeholder only says what the box keeps: the outage in
  // it took two lines at 375 px, which Safari cuts at the box's one-line height.
  it("names Herdr's outage once, above the box, until the banner takes it over", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      __resetConnectionHealth();
      renderChat({ bridge: "disconnected" }, undefined, { banner: true });
      expect(screen.getAllByText(/Herdr isn.t responding/)).toHaveLength(1);
      expect(screen.getByText("Herdr isn't responding.")).toBeVisible();
      const box = screen.getByPlaceholderText("Drafts are kept.");
      fireEvent.change(box, { target: { value: "keep this for later" } });
      expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
      expect(screen.getAllByText(/Herdr isn.t responding/)).toHaveLength(1);
      expect(screen.getByText("Herdr isn't responding. Drafts are kept.")).toBeVisible();
      act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS));
      expect(screen.getAllByText(/Herdr isn.t responding/)).toHaveLength(1);
      expect(screen.getByText("Herdr isn’t responding.")).toBeVisible();
      fireEvent.change(box, { target: { value: "" } });
      expect(screen.queryByPlaceholderText(/Herdr/)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  // A read-only device's box and card say read-only, which is the lock that holds, so the outage
  // needs its own line there until the banner names it.
  it("names Herdr's outage once on a device that cannot write, until the banner takes it over", () => {
    vi.useFakeTimers();
    try {
      __resetConnectionHealth();
      renderChat({ bridge: "disconnected", device: { enforced: true, device: "spare-phone", authorized: false } }, undefined, { banner: true });
      expect(screen.getByPlaceholderText("Read-only — device not authorised")).toBeDisabled();
      expect(screen.getAllByText(/Herdr isn.t responding/)).toHaveLength(1);
      expect(screen.getByText("Herdr isn't responding.")).toBeVisible();
      act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS));
      expect(screen.getAllByText(/Herdr isn.t responding/)).toHaveLength(1);
      expect(screen.getByText("Herdr isn’t responding.")).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the pane's place under the title on a device that cannot write, too", () => {
    renderChat({ bridge: "disconnected", device: { enforced: true, device: "spare-phone", authorized: false } });
    expect(within(screen.getByRole("banner")).queryByText(/Herdr/)).not.toBeInTheDocument();
  });
});

// Claude's usage-limit pause paints "esc to cancel" under a live input box. That hint makes the box
// unsendable (ADR 0048 step 4), which is right, but it is not a question for the operator: Claude
// resumes on its own. Only a screen that really waits on a key earns the interaction notice.
describe("AgentChat — terminal waiting notice", () => {
  const USAGE_LIMIT_TEXT = [
    "● Listo, te aviso cuando termine.",
    "  ⎿  You've hit your session limit · resets 1:20am (Europe/Amsterdam)",
    "",
    "  Usage limit reached · continuing automatically at 1:20am · esc to cancel",
    "",
    "✻ Sautéed for 1h 55m 17s · done 10:22 PM",
    "",
    "✔ Update installed · Restart to update",
    RULE,
    "❯ ",
    RULE,
    "  ⚠ Usage limit reached · limit resets 1:20am",
    "    Continuing automatically at 1:20am · esc to cancel",
    "  Opus 5.5 (1M context) | Context 18% used (82% left) | 5h 100% used (0% left)",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
  ].join("\n");
  const UNKNOWN_WAIT_TEXT = ["● Working on it", "", "  Something new needs your attention", "", "  Enter to continue"].join("\n");

  it("shows a usage-limit pause as one quiet line, not a terminal waiting notice", async () => {
    const agent = { ...fixtureAgents[0]!, status: "idle" as const, hasSession: true };
    renderChat({ agent, agents: [agent], text: USAGE_LIMIT_TEXT });
    expect(await screen.findByText(/Usage limit reached · limit resets 1:20am/, { selector: "[data-terminal-notice] *" })).toBeVisible();
    expect(screen.queryByText(/terminal is waiting/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /terminal keys/i })).not.toBeInTheDocument();
  });

  it("says in words what an unrecognised wait is, and leads to the terminal and its keys", async () => {
    const user = userEvent.setup();
    const agent = { ...fixtureAgents[0]!, status: "blocked" as const, hasSession: true };
    renderChat({ agent, agents: [agent], text: UNKNOWN_WAIT_TEXT });
    const notice = await screen.findByRole("region", { name: "Terminal waiting" });
    // Only the sentence is announced; the buttons around it are not part of a live region.
    expect(within(notice).getByRole("status")).toHaveTextContent("Claude is showing a screen Nenu can't answer");
    expect(notice).not.toHaveAttribute("role", "status");
    // It needs the operator, like the pane's red dot in the header: never the yellow of a working agent.
    const dots = [...notice.querySelectorAll("[aria-hidden]")].map((el) => el.getAttribute("class") ?? "");
    expect(dots.some((c) => /status-blocked/.test(c))).toBe(true);
    expect(dots.some((c) => /status-working/.test(c))).toBe(false);
    // The screen's own hint stays, under the sentence.
    expect(within(notice).getByText("Enter to continue")).toBeVisible();
    expect(within(notice).getByRole("button", { name: "Keys" })).toBeVisible();
    // No key of its own until a declared cancel key exists (ADR 0053 rule 2 is still Proposed).
    expect(within(notice).queryByRole("button", { name: /Esc|Dismiss/ })).not.toBeInTheDocument();
    await user.click(within(notice).getByRole("button", { name: "Show terminal" }));
    expect(screen.queryByRole("region", { name: "Live conversation" })).not.toBeInTheDocument();
  });

  // The composer is not paused: a message typed now waits for the answer ("Message for after you
  // answer…"). The chip names what is actually waiting, the screen.
  it("collapses an unrecognised wait to a chip that names the waiting screen, not a paused composer", async () => {
    const user = userEvent.setup();
    const agent = { ...fixtureAgents[0]!, status: "blocked" as const, hasSession: true };
    renderChat({ agent, agents: [agent], text: UNKNOWN_WAIT_TEXT });
    const notice = await screen.findByRole("region", { name: "Terminal waiting" });
    const collapse = within(notice).getByRole("button", { name: "Collapse" });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    await user.click(collapse);
    expect(within(notice).queryByText("Claude is showing a screen Nenu can't answer")).not.toBeInTheDocument();
    expect(within(notice).queryByText(/Composer paused/)).not.toBeInTheDocument();
    const chip = within(notice).getByRole("button", { name: "Terminal waiting on a key" });
    expect(chip).toHaveAttribute("aria-expanded", "false");
    expect(chip.querySelector("[aria-hidden].bg-status-blocked")).not.toBeNull();
    await user.click(chip);
    expect(within(notice).getByText("Claude is showing a screen Nenu can't answer")).toBeVisible();
  });
});

describe("AgentChat — bridge-detected dialog", () => {
  const PERMISSION = readFileSync("src/fixtures/panes/claude--permission-bash.txt", "utf8");

  it("shows the bridge's card inline instead of the popover, and a tap is one POST", async () => {
    const user = userEvent.setup();
    const agent = { ...fixtureAgents[0]!, status: "blocked" as const, hasSession: true };
    const posts: unknown[] = [];
    server.use(
      http.get("/api/interactions", () => HttpResponse.json({ interactions: [{
        paneId: agent.paneId, agent: "claude", kind: "permission", family: "permission", question: "Do you want to proceed?",
        context: "Bash command\nmkfifo fixture-fifo", subject: { tool: "Bash", command: "mkfifo fixture-fifo" }, signature: "sig-1", revision: 1, detectedAt: 0, detailComplete: false,
        options: [{ index: 0, label: "Yes", role: "primary" }, { index: 1, label: "No", role: "deny" }],
      }] })),
      http.post(/\/api\/interactions\/[^/]+\/answer$/, async ({ request }) => {
        posts.push(await request.json());
        return HttpResponse.json({ ok: true });
      }),
    );
    renderChat({ agent, agents: [agent], text: PERMISSION });
    const card = await screen.findByRole("region", { name: "Do you want to proceed?" });
    expect(within(card).getByText("Waiting on you")).toBeVisible();
    // Inside the thread's own scroller: a swipe over the card scrolls the conversation.
    expect(screen.getByRole("region", { name: "Live conversation" })).toContainElement(card);
    expect(card.closest("[data-follow-stop]")).not.toBeNull();
    expect(screen.queryByRole("region", { name: "Agent interaction" })).not.toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(posts).toEqual([{ signature: "sig-1", optionIndex: 0 }]));
    expect(await screen.findByText("Approved · mkfifo fixture-fifo")).toBeVisible();
  });

  it("keeps saying why a tap did nothing when the question it hit is replaced by the next one", async () => {
    const user = userEvent.setup();
    const agent = { ...fixtureAgents[0]!, status: "blocked" as const, hasSession: true };
    const ask = (signature: string, question: string) => ({
      paneId: agent.paneId, agent: "claude", kind: "permission", family: "permission", question, signature, revision: 1, detectedAt: 0,
      subject: { tool: "Bash", command: "mkfifo fixture-fifo" }, detailComplete: true,
      options: [{ index: 0, label: "Yes", role: "primary" }, { index: 1, label: "No", role: "deny" }],
    });
    let shown = [ask("sig-1", "Do you want to proceed?")];
    server.use(
      http.get("/api/interactions", () => HttpResponse.json({ interactions: shown })),
      http.post(/\/api\/interactions\/[^/]+\/answer$/, () => {
        shown = [ask("sig-2", "Do you want to make this edit?")];
        return HttpResponse.json({ ok: false, error: "The question changed in the terminal. Nothing was sent.", code: "interaction_changed" }, { status: 409 });
      }),
    );
    renderChat({ agent, agents: [agent], text: PERMISSION });
    const first = await screen.findByRole("region", { name: "Do you want to proceed?" });
    await user.click(within(first).getByRole("button", { name: "Yes" }));
    const next = await screen.findByRole("region", { name: "Do you want to make this edit?" });
    expect(within(next).getByRole("status")).toHaveTextContent("The question changed in the terminal. Nothing was sent.");
  });

  it.each([
    [{ device: { enforced: true, device: "spare-phone", authorized: false } }, "Read-only on this device. Answer from an authorised one."],
    [{ error: true, authError: true }, "Sign in again to answer."],
    [{ bridge: "disconnected" as const }, "Herdr isn't responding. Answers are paused."],
  ])("says why the card cannot answer: %j", async (snapshot, line) => {
    const agent = { ...fixtureAgents[0]!, status: "blocked" as const, hasSession: true };
    server.use(http.get("/api/interactions", () => HttpResponse.json({ interactions: [{
      paneId: agent.paneId, agent: "claude", kind: "permission", family: "permission", question: "Do you want to proceed?",
      context: "Bash command\nmkfifo fixture-fifo", subject: { tool: "Bash", command: "mkfifo fixture-fifo" },
      signature: "sig-1", revision: 1, detectedAt: 0, detailComplete: true,
      options: [{ index: 0, label: "Yes", role: "primary" }, { index: 1, label: "No", role: "deny" }],
    }] })));
    renderChat({ agent, agents: [agent], text: PERMISSION, ...snapshot });
    const card = await screen.findByRole("region", { name: "Do you want to proceed?" });
    expect(within(card).getByText(line)).toBeVisible();
    expect(within(card).queryByText("Answers are paused right now.")).not.toBeInTheDocument();
  });

  it("shows a read-only device the options as a list it cannot press", async () => {
    const agent = { ...fixtureAgents[0]!, status: "blocked" as const, hasSession: true };
    server.use(http.get("/api/interactions", () => HttpResponse.json({ interactions: [{
      paneId: agent.paneId, agent: "claude", kind: "permission", family: "permission", question: "Do you want to proceed?",
      subject: { tool: "Bash", command: "mkfifo fixture-fifo" }, signature: "sig-1", revision: 1, detectedAt: 0, detailComplete: true,
      options: [{ index: 0, label: "Yes", role: "primary" }, { index: 1, label: "No", role: "deny" }],
    }] })));
    renderChat({ agent, agents: [agent], text: PERMISSION, device: { enforced: true, device: "spare-phone", authorized: false } });
    const card = await screen.findByRole("region", { name: "Do you want to proceed?" });
    expect(within(card).queryByRole("button", { name: "Yes" })).not.toBeInTheDocument();
    expect(within(within(card).getByRole("list", { name: "Options" })).getByText("Yes")).toBeVisible();
  });

  it("draws the dialog as a card in the conversation while the bridge has no card for the pane", async () => {
    const agent = { ...fixtureAgents[0]!, status: "blocked" as const, hasSession: true };
    renderChat({ agent, agents: [agent], text: PERMISSION });
    const conversation = await screen.findByRole("region", { name: "Live conversation" });
    const card = await within(conversation).findByRole("region", { name: "Do you want to proceed?" });
    expect(within(card).getByText("Waiting on you")).toBeVisible();
    expect(card.closest("[data-follow-stop]")).not.toBeNull();
    expect(screen.queryByRole("region", { name: "Agent interaction" })).not.toBeInTheDocument();
  });

  it("draws a generic menu in the conversation as a card, never over it", async () => {
    const MENU = readFileSync("src/fixtures/panes/claude-lab--menu-rewind--w82.txt", "utf8");
    const agent = { ...fixtureAgents[0]!, status: "blocked" as const, hasSession: true };
    server.use(http.get("/api/interactions", () => HttpResponse.json({ interactions: [{
      paneId: agent.paneId, agent: "claude", kind: "menu", family: "claude", question: "Rewind", signature: "sig-m", revision: 1, detectedAt: 0,
      options: [{ index: 0, label: "Continue", role: "neutral" }, { index: 1, label: "Cancel", role: "deny" }],
    }] })));
    renderChat({ agent, agents: [agent], text: MENU });
    const conversation = await screen.findByRole("region", { name: "Live conversation" });
    const card = await within(conversation).findByRole("region", { name: "Rewind" });
    expect(within(card).getByRole("button", { name: "Continue" })).toBeVisible();
    expect(within(card).getByRole("button", { name: "Cancel" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Agent interaction" })).not.toBeInTheDocument();
  });

  it("draws a preview question in the conversation as a card, never over it", async () => {
    const PREVIEW = readFileSync("src/fixtures/panes/claude--select-preview.txt", "utf8");
    const agent = { ...fixtureAgents[0]!, status: "blocked" as const, hasSession: true };
    server.use(http.get("/api/interactions", () => HttpResponse.json({ interactions: [{
      paneId: agent.paneId, agent: "claude", kind: "question", family: "claude", question: "Which widget design should we use?", signature: "sig-p", revision: 1, detectedAt: 0,
      options: [{ index: 0, label: "Boxy", role: "neutral" }, { index: 1, label: "Rounded", role: "neutral" }, { index: 2, label: "Minimal", role: "neutral" }],
    }] })));
    renderChat({ agent, agents: [agent], text: PREVIEW });
    const conversation = await screen.findByRole("region", { name: "Live conversation" });
    const card = await within(conversation).findByRole("region", { name: "Which widget design should we use?" });
    expect(within(card).getByRole("button", { name: "Choose Boxy" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Agent interaction" })).not.toBeInTheDocument();
  });
});

// Pointing at a preview row is the first of two taps: the digit moves the pointer, the guard sees it
// land, and the card is drawn again from the next read. Until that read lands the tapped row stays
// busy, so a second tap can never act on the old pointer; nothing was answered, so no "Sent".
describe("AgentChat — pointing at a preview option", () => {
  const PLAIN = readFileSync("src/fixtures/panes/claude--select-preview.txt", "utf8").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\r/g, "");
  const ON_ROUNDED = PLAIN.replace("❯ 1. Boxy ", "  1. Boxy ").replace("  2. Rounded", "❯ 2. Rounded").replace("| WIDGET           [X] |", "( WIDGET           (x) )");

  it("keeps the row busy until the refreshed card shows its preview and Choose, and says nothing was sent", async () => {
    const user = userEvent.setup();
    const agent = { ...fixtureAgents[0]!, status: "blocked" as const, hasSession: true };
    let pane = PLAIN;
    const keys: string[][] = [];
    let hold = false;
    let held = 0;
    const waiting: Array<() => void> = [];
    server.use(
      http.get("/api/interactions", () => HttpResponse.json({ interactions: [{
        paneId: agent.paneId, agent: "claude", kind: "question", family: "claude", question: "Which widget design should we use?", signature: "sig-p", revision: 1, detectedAt: 0,
        options: [{ index: 0, label: "Boxy", role: "neutral" }, { index: 1, label: "Rounded", role: "neutral" }, { index: 2, label: "Minimal", role: "neutral" }],
      }] })),
      http.get(/\/api\/pane\/[^/]+$/, () => HttpResponse.json({ paneId: agent.paneId, text: pane, truncated: false, revision: 1 })),
      http.post(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => {
        const body = (await request.json()) as { keys: string[] };
        keys.push(body.keys);
        if (body.keys.join() === "2") pane = ON_ROUNDED;
        return HttpResponse.json({ ok: true });
      }),
    );
    function PaneRoute() {
      const { text } = useLoaderData() as { text: string };
      return <><AgentChat paneId={agent.paneId} agent={agent} agents={[agent]} shellPanes={[]} tabs={[]} text={text} revision={1} onBack={vi.fn()} onSelect={vi.fn()} /><StatusArea /></>;
    }
    const router = createMemoryRouter([{
      path: "/",
      loader: async () => {
        if (hold) { held++; await new Promise<void>((resolve) => waiting.push(resolve)); }
        return { text: pane };
      },
      element: <PaneRoute />,
    }]);
    render(<RouterProvider router={router} />);
    const card = await screen.findByRole("region", { name: "Which widget design should we use?" });
    expect(within(card).getByRole("button", { name: "Choose Boxy" })).toBeVisible();

    hold = true;
    await user.click(within(card).getByRole("radio", { name: /^Rounded/ }));
    await waitFor(() => expect(held).toBeGreaterThan(0));
    expect(keys).toEqual([["2"]]);
    // The pointer moved, but the card on screen is still the old read: nothing in it can be pressed.
    expect(within(card).getByRole("radio", { name: /^Rounded/ })).toBeDisabled();
    expect(within(card).getByRole("button", { name: "Choose Boxy" })).toBeDisabled();

    hold = false;
    act(() => { for (const resolve of waiting.splice(0)) resolve(); });
    const refreshed = await screen.findByRole("region", { name: "Which widget design should we use?" });
    expect(await within(refreshed).findByRole("button", { name: "Choose Rounded" })).toBeEnabled();
    expect(within(within(refreshed).getByRole("group", { name: "Preview of Rounded" })).getByText(/\( WIDGET/)).toBeVisible();
    expect(keys).toEqual([["2"]]);
    expect(screen.queryByText("Sent")).not.toBeInTheDocument();
    expect(screen.queryByText(/Dialog changed/)).not.toBeInTheDocument();
  });
});

describe("AgentChat — project composer copy", () => {
  it("asks a worker thread to be steered", () => {
    renderChat({ project: { slug: "hub", name: "Hub", role: "worker" } });
    expect(screen.getByPlaceholderText("Steer this thread…")).toBeInTheDocument();
  });

  it("points a coordinator's composer at the coordinator", () => {
    renderChat({ project: { slug: "hub", name: "Hub", role: "coordinator" } });
    expect(screen.getByPlaceholderText("Ask the coordinator…")).toBeInTheDocument();
  });

  it("keeps the reply copy outside a project", () => {
    renderChat();
    expect(screen.getByPlaceholderText("Type a reply…")).toBeInTheDocument();
  });
});

// Measured 2026-10-12 in a disposable Herdr 0.9.3 with Claude 2.1.296: a background agent launched in
// a turn that has ended keeps Herdr at working and Claude's session file at busy, and Enter typed then
// starts a new turn at once (answer 1.1 s later, no queue-operation row). Only a running turn is busy.
describe("AgentChat — Send while only background work runs", () => {
  function serveQueue() {
    const posts: Array<Record<string, unknown>> = [];
    const sends: string[] = [];
    server.use(
      http.get(/\/api\/pane\/[^/]+\/queue$/, () => HttpResponse.json({ available: true, scope: "scope", messages: [], delivered: [] })),
      http.post(/\/api\/pane\/[^/]+\/queue$/, async ({ request }) => {
        posts.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ available: true, scope: "scope", messages: [], delivered: [] });
      }),
      http.post(/\/api\/pane\/[^/]+\/send$/, async ({ request }) => {
        const body = (await request.json()) as { text: string; requestId: string };
        sends.push(body.text);
        return HttpResponse.json({ ok: true, requestId: body.requestId, ack: "submitted" });
      }),
    );
    return { posts, sends };
  }
  const claude = (turn: { running: boolean; background?: boolean }) =>
    ({ ...fixtureAgents[0]!, paneId: "background-send", agent: "claude", status: "working" as const, hasSession: true, turn: { ...turn, source: "claude-session" as const } });

  it("sends directly when the main turn is over, without asking now or later", async () => {
    const wire = serveQueue();
    const agent = claude({ running: false, background: true });
    renderChat({ paneId: agent.paneId, agent, agents: [agent], text: "" });
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox"), "status?");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(wire.sends).toEqual(["status?"]));
    expect(screen.queryByRole("group", { name: /is working/i })).not.toBeInTheDocument();
    expect(wire.posts).toEqual([]);
  });

  it("still asks while the main turn runs", async () => {
    const wire = serveQueue();
    const agent = claude({ running: true });
    renderChat({ paneId: agent.paneId, agent, agents: [agent], text: "" });
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox"), "status?");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("group", { name: /is working/i })).toBeInTheDocument();
    expect(wire.sends).toEqual([]);
  });
});
