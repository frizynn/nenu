import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { NeedsYouList } from "./needs-you-list";
import type { LockReason } from "./question-card";
import type { InteractionsState } from "@/hooks/use-interactions";
import type { AgentView, Interaction } from "@/lib/types";

const NAME = "Investigate the flaky Safari 18 e2e when the keyboard opens";
const PLACE = "acme-enterprise-billing-platform-migration";

const blocked: AgentView = {
  paneId: "w5:a2", workspaceId: "w5", workspaceLabel: PLACE, workspaceNumber: 5, tabId: "w5:t2",
  agent: "claude", status: "blocked", cwd: "/dev/acme", focused: false, paneLabel: NAME,
};

const interactions: InteractionsState = {
  interactions: [], receipts: [], stale: false, loaded: true, refresh: () => {}, answer: () => Promise.resolve({ ok: true }), refusalFor: () => undefined,
};

// A data router, as in the app: a row reads the navigation to say when it is opening.
function renderRow() {
  const element = <NeedsYouList agents={[blocked]} session="work" items={[{ paneId: blocked.paneId }]} receipts={[]} interactions={interactions} lockReason={undefined} opening={null} />;
  render(<RouterProvider router={createMemoryRouter([{ path: "/", element }])} />);
  return screen.getByRole("link");
}

it("reads a blocked row as its thread, where it lives and why it waits", () => {
  const row = renderRow();
  expect(row).toHaveAccessibleName(`${NAME}, ${PLACE}, waiting in the terminal`);
  expect(row).toHaveAttribute("href", "/pane/w5%3Aa2?s=work");
});

// "Needs you" is said by its small mark and plain words: a red fill or a red border made the row shout.
it("says the row needs you with its small red mark alone, on a quiet surface with no red fill or border", () => {
  const card = renderRow().closest(".relative")!;
  expect(card.className).not.toMatch(/status-blocked/);
  const red = [...card.querySelectorAll("[class*='status-blocked']")];
  expect(red).toHaveLength(1);
  expect(red[0]).toHaveAttribute("data-node-state", "needs");
  expect(red[0]).toHaveClass("size-3.5");
});

// jsdom lays nothing out, so this pins the class the fix stands on: the column that holds the name
// and the place may shrink below its text (min-w-0). Without it the name keeps its full width, crosses
// the card and pushes the chevron off a phone screen while every class below still reads right. The
// geometry itself is measured in a browser at 390 px, outside this suite.
it("lets the name and the place shorten inside the row while the status stays readable", () => {
  renderRow();
  const name = screen.getByText(NAME);
  expect(name.parentElement).toHaveClass("min-w-0");
  expect(name).toHaveClass("truncate");
  // The place gives up width first, so what the row waits on stays readable.
  expect(screen.getByText(PLACE)).toHaveClass("min-w-0", "truncate", "max-w-[40%]");
  expect(screen.getByText("waiting in the terminal")).toHaveClass("flex-1");
});

// SYS-17 on the row: a tap into the thread waits on the thread's read like any row does, so the row
// says it is opening instead of sitting still.
it("says a dialog's thread is opening while it loads", () => {
  const interaction = { paneId: blocked.paneId, agent: "claude", signature: "sig", revision: 1, detectedAt: 0, kind: "question", family: "select",
    question: "Which fruit?", options: [{ index: 0, label: "Apple", role: "neutral" }] } as const;
  const element = <NeedsYouList agents={[blocked]} session="work" items={[{ paneId: blocked.paneId, interaction: { ...interaction, options: [...interaction.options] } }]}
    receipts={[]} interactions={interactions} lockReason={undefined} opening="/pane/w5%3Aa2" />;
  render(<RouterProvider router={createMemoryRouter([{ path: "/", element }])} />);
  expect(screen.getByRole("link", { name: /^Investigate/ })).toHaveAttribute("aria-busy", "true");
});

describe("a dialog's row", () => {
  const permission: Interaction = {
    paneId: blocked.paneId, agent: "claude", signature: "sig-1", revision: 1, detectedAt: 1,
    kind: "permission", family: "permission", question: "Do you want to proceed?", subject: { tool: "Bash", command: "mkfifo fixture-fifo" },
    options: [
      { index: 0, label: "Yes", role: "primary" },
      { index: 1, label: "Yes, and don't ask again for mkfifo commands", role: "persistent" },
      { index: 2, label: "No", role: "deny", description: "Stops Claude's turn" },
    ],
    detailComplete: true,
  };
  const question: Interaction = {
    ...permission, kind: "question", family: "select", question: "Which fruit?", subject: undefined, detailComplete: undefined,
    options: [{ index: 0, label: "Apple", role: "neutral" }, { index: 1, label: "Banana", role: "neutral" }, { index: 2, label: "Cherry", role: "neutral" }],
  };

  function renderAsk(interaction: Interaction, { answer = interactions.answer, lockReason, refusal }: { answer?: InteractionsState["answer"]; lockReason?: LockReason; refusal?: string } = {}) {
    const state = { ...interactions, answer, refusalFor: () => refusal };
    const element = <NeedsYouList agents={[blocked]} session="work" items={[{ paneId: blocked.paneId, interaction }]} receipts={[]} interactions={state} lockReason={lockReason} opening={null} />;
    const router = createMemoryRouter([{ path: "/", element }, { path: "/pane/:paneId", element: <p>Pane opened</p> }]);
    render(<RouterProvider router={router} />);
    return { router, row: within(screen.getByRole("region", { name: /^Needs you/ })) };
  }

  it("is one line: who asks, where, and the command it would run", () => {
    const { row } = renderAsk(permission);
    expect(row.getByText(NAME)).toHaveClass("truncate");
    expect(row.getByText("mkfifo fixture-fifo")).toHaveClass("font-mono");
    expect(row.getByText(/^Run/).closest("[data-ask]")).toHaveClass("truncate");
    // No option list and no question card on Home: the thread has those.
    expect(row.queryByRole("list")).not.toBeInTheDocument();
    expect(document.querySelector("[data-question-card]")).toBeNull();
  });

  it("answers Yes and No in place on a desk, through the same answer as the card, and never the persistent row", async () => {
    const answered: unknown[] = [];
    const { row } = renderAsk(permission, { answer: (i, option, extra) => { answered.push([i.signature, option.index, extra]); return Promise.resolve({ ok: true }); } });
    const yes = row.getByRole("button", { name: "Yes" });
    expect(row.getByRole("button", { name: "No" })).toHaveAttribute("title", "Stops Claude's turn");
    expect(row.queryByRole("button", { name: /don't ask again/ })).not.toBeInTheDocument();
    // A phone answers in the thread: the in-place pair is the desk's, the Answer link the phone's.
    expect(yes.parentElement).toHaveClass("max-sm:hidden");
    expect(row.getByRole("link", { name: "Answer" })).toHaveClass("sm:invisible");
    await userEvent.click(yes);
    expect(answered).toEqual([["sig-1", 0, undefined]]);
  });

  it("says why a tap did nothing next to the row", async () => {
    const { row } = renderAsk(permission, { answer: () => Promise.resolve({ ok: false, code: "interaction_changed", error: "The question changed in the terminal." }) });
    await userEvent.click(row.getByRole("button", { name: "No" }));
    expect(await row.findByText("The question changed in the terminal.")).toBeVisible();
  });

  it("draws Answer solid on a phone and outlined on a desk, where it is never the brightest thing on the page", () => {
    expect(renderAsk(question).row.getByRole("link", { name: "Answer" })).toHaveClass("bg-foreground");
    cleanup();
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(min-width: 1024px)", media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }));
    try {
      const answer = renderAsk(question).row.getByRole("link", { name: "Answer" });
      expect(answer).toHaveClass("border");
      expect(answer).not.toHaveClass("bg-foreground");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("opens the thread to answer a dialog with more than two answers", async () => {
    const { row, router } = renderAsk(question);
    expect(row.getByText("Which fruit?")).toBeInTheDocument();
    expect(row.queryByRole("button")).not.toBeInTheDocument();
    const answer = row.getByRole("link", { name: "Answer" });
    expect(answer).not.toHaveClass("sm:invisible");
    await userEvent.click(answer);
    expect(router.state.location.pathname).toBe("/pane/w5%3Aa2");
  });

  it("opens the thread when the row can't show the whole command, or the answers mean more than their labels", () => {
    for (const ask of [
      { ...permission, detailComplete: false },
      { ...permission, subject: { tool: "Bash", command: "cd web\nbun run build" } },
      { ...question, options: [{ index: 0, label: "Apple", role: "neutral", description: "Keeps the red theme" }, { index: 1, label: "Banana", role: "neutral" }] },
      { ...permission, typing: true },
    ] as Interaction[]) {
      const { row } = renderAsk(ask);
      expect(row.queryByRole("button", { name: /^(Yes|No|Apple|Banana)$/ })).not.toBeInTheDocument();
      expect(row.getByRole("link", { name: "Answer" })).toBeInTheDocument();
      cleanup();
    }
  });

  it("says why answers are paused and keeps only the way into the thread", () => {
    const { row } = renderAsk(permission, { lockReason: "read-only" });
    expect(row.getByText("Read-only on this device. Answer from an authorised one.")).toBeVisible();
    expect(row.queryByRole("button")).not.toBeInTheDocument();
    expect(row.getByRole("link", { name: "Answer" })).toHaveAttribute("href", "/pane/w5%3Aa2?s=work");
  });

  it("counts down to when Claude denies the request on its own", () => {
    const { row } = renderAsk({ ...permission, autoDenyAt: Date.now() + 65_000 });
    expect(row.getByText(/Claude denies this on its own in 1:0\d if nobody answers/)).toBeInTheDocument();
  });
});

