import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { AnswerOutcome, Interaction } from "@/lib/types";
import { QuestionCard } from "./question-card";

// Shapes as bridge/interactions.ts serves them for the fixture corpus (claude--permission-bash,
// claude--plan-approval, claude--v2285-ask-question, claude--select-multiselect-checked).
const base = { paneId: "w1:p1", agent: "claude", signature: "sig-1", revision: 1, detectedAt: 0 };

const permission: Interaction = {
  ...base, kind: "permission", family: "permission", question: "Do you want to proceed?",
  context: "Bash command\nmkfifo fixture-fifo",
  options: [
    { index: 0, label: "Yes", role: "primary" },
    { index: 1, label: "Yes, and don’t ask again for: mkfifo fixture-fifo *", role: "persistent" },
    { index: 2, label: "No", role: "deny", description: "Stops Claude's turn" },
  ],
  detailComplete: false,
};

const plan: Interaction = {
  ...base, kind: "plan", family: "plan", question: "Would you like to proceed?",
  options: [
    { index: 0, label: "Yes, and use auto mode", role: "persistent" },
    { index: 1, label: "Yes, manually approve edits", role: "primary" },
    { index: 2, label: "No, refine with Ultraplan", role: "deny" },
    { index: 3, label: "Tell Claude what to change", role: "freeText", acceptsText: true },
  ],
};

const question: Interaction = {
  ...base, kind: "question", family: "select", question: "Which fruit?",
  options: [
    { index: 0, label: "Apple", role: "neutral" },
    { index: 1, label: "No", role: "neutral" },
    { index: 2, label: "Type something.", role: "freeText" },
    { index: 3, label: "Chat about this", role: "deny" },
  ],
};

const multi: Interaction = {
  ...base, kind: "multi-select", family: "claude", question: "Which toppings?",
  options: [
    { index: 0, label: "Cheese", role: "neutral", checked: false },
    { index: 1, label: "Olives", role: "neutral", checked: true },
    { index: 2, label: "Submit", role: "primary" },
  ],
};

const ok = (): Promise<AnswerOutcome> => Promise.resolve({ ok: true });

function setup(props: Partial<Parameters<typeof QuestionCard>[0]> = {}) {
  const onAnswer = vi.fn(ok);
  const onOpen = vi.fn();
  render(<QuestionCard interaction={question} onAnswer={onAnswer} onOpen={onOpen} {...props} />);
  return { onAnswer: (props.onAnswer as typeof onAnswer | undefined) ?? onAnswer, onOpen, user: userEvent.setup() };
}

describe("QuestionCard", () => {
  it("shows Waiting on you, the question and the request detail in mono", () => {
    setup({ interaction: permission });
    expect(screen.getByText("Waiting on you")).toBeVisible();
    expect(screen.getByText("Do you want to proceed?")).toBeVisible();
    const detail = screen.getByLabelText("Request details");
    expect(detail.tagName).toBe("PRE");
    expect(detail).toHaveClass("font-mono");
  });

  it("clamps the compact detail on an unpadded box, so no fourth line peeks into the padding", () => {
    setup({ interaction: { ...permission, context: "a\nb\nc\nd\ne" }, compact: true });
    const detail = screen.getByLabelText("Request details");
    expect(detail).toHaveClass("line-clamp-3");
    expect(detail.className).not.toMatch(/(^|\s)p[xy]?-/);
    expect(detail.parentElement).toHaveClass("py-2");
  });

  it("answers with one call naming the option by index", async () => {
    const { onAnswer, user } = setup();
    await user.click(screen.getByRole("button", { name: /Apple/ }));
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith(question.options[0], {});
  });

  it("treats a question's No as an answer and its escape row as deny", () => {
    setup();
    expect(screen.getByRole("button", { name: /^No$/ })).toHaveAttribute("data-role", "neutral");
    expect(screen.getByRole("button", { name: /Chat about this/ })).toHaveAttribute("data-role", "deny");
  });

  it("says a text row without a recipe is answered in the terminal and links to the keys", async () => {
    const onKeys = vi.fn();
    const { onAnswer, onOpen, user } = setup({ onKeys });
    expect(screen.queryByRole("button", { name: /Type something/ })).not.toBeInTheDocument();
    expect(document.querySelector("[data-in-terminal]")).toHaveTextContent("Type something. Answer in the terminal.");
    await user.click(screen.getByRole("button", { name: "Open keys" }));
    expect(onKeys).toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("names the terminal for a text row on Home, where the card's own Open leads there", () => {
    setup({ compact: true });
    const row = document.querySelector<HTMLElement>("[data-in-terminal]")!;
    expect(row).toHaveTextContent("Type something. Answer in the terminal.");
    expect(within(row).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open" })).toBeVisible();
  });

  it("asks to confirm a persistent option and sends it with confirm on the second tap", async () => {
    const { onAnswer, user } = setup({ interaction: permission });
    await user.click(screen.getByRole("button", { name: /don’t ask again/ }));
    expect(onAnswer).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /Tap again to confirm/ }));
    expect(onAnswer).toHaveBeenCalledWith(permission.options[1], { confirm: true });
  });

  it("locks every control while someone types in the dialog", () => {
    setup({ interaction: { ...plan, typing: true } });
    expect(screen.getByText(/Someone is typing in this dialog/)).toBeVisible();
    for (const name of [/auto mode/, /manually approve/, /Ultraplan/, /Reply…/]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
  });

  it("never offers the plan's text row as a button; Reply… sends the feedback text", async () => {
    const { onAnswer, user } = setup({ interaction: plan });
    expect(screen.queryByRole("button", { name: /Tell Claude what to change/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reply…" }));
    await user.type(screen.getByRole("textbox", { name: "Tell Claude what to change" }), "Split it in two");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onAnswer).toHaveBeenCalledWith(plan.options[3], { text: "Split it in two" });
  });

  it("types a multi-select's Type something row from the card", async () => {
    const withText: Interaction = { ...multi, options: [...multi.options.slice(0, 2), { index: 2, label: "Type something", role: "freeText", acceptsText: true }, { ...multi.options[2]!, index: 3 }] };
    const { onAnswer, user } = setup({ interaction: withText });
    await user.click(screen.getByRole("button", { name: "Type something…" }));
    const box = screen.getByRole("textbox", { name: "Type something" });
    expect(box).toHaveAttribute("maxLength", "240");
    await user.type(box, "Pineapple");
    expect(screen.getByText("9/240")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onAnswer).toHaveBeenCalledWith(withText.options[2], { text: "Pineapple" });
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  describe("a note on an answer that accepts text (Tab-amend, Codex notes)", () => {
    const amend: Interaction = {
      ...permission, detailComplete: true,
      options: [
        { index: 0, label: "Yes", role: "primary", acceptsText: true },
        permission.options[1]!,
        { index: 2, label: "No", role: "deny", acceptsText: true },
      ],
    };

    it("still answers in one tap without a note", async () => {
      const { onAnswer, user } = setup({ interaction: amend });
      await user.click(screen.getByRole("button", { name: /^Yes$/ }));
      expect(onAnswer).toHaveBeenCalledWith(amend.options[0], {});
    });

    it("sends the note with the tapped answer, capped at 240 characters", async () => {
      const { onAnswer, user } = setup({ interaction: amend });
      await user.click(screen.getByRole("button", { name: "Add a note…" }));
      const box = screen.getByRole("textbox", { name: "Note with your answer" });
      expect(box).toHaveAttribute("maxLength", "240");
      await user.type(box, "  use the test db instead ");
      await user.click(screen.getByRole("button", { name: /^No/ }));
      expect(onAnswer).toHaveBeenCalledWith(amend.options[2], { text: "use the test db instead" });
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    });

    it("never drops a typed note into an answer that cannot carry it", async () => {
      const { user } = setup({ interaction: amend });
      expect(screen.getByRole("button", { name: /don’t ask again/ })).toBeEnabled();
      await user.click(screen.getByRole("button", { name: "Add a note…" }));
      await user.type(screen.getByRole("textbox"), "why");
      expect(screen.getByRole("button", { name: /don’t ask again/ })).toBeDisabled();
      expect(screen.getByRole("button", { name: /^Yes$/ })).toBeEnabled();
    });

    it("sends the note and confirm together on a persistent answer that accepts text", async () => {
      const persistent: Interaction = { ...amend, options: [amend.options[0]!, { ...permission.options[1]!, acceptsText: true }, amend.options[2]!] };
      const { onAnswer, user } = setup({ interaction: persistent });
      await user.click(screen.getByRole("button", { name: "Add a note…" }));
      await user.type(screen.getByRole("textbox"), "only here");
      await user.click(screen.getByRole("button", { name: /don’t ask again/ }));
      await user.click(screen.getByRole("button", { name: /Tap again to confirm/ }));
      expect(onAnswer).toHaveBeenCalledWith(persistent.options[1], { text: "only here", confirm: true });
    });

    it("offers no note where no answer accepts text", () => {
      setup({ interaction: permission });
      expect(screen.queryByRole("button", { name: "Add a note…" })).not.toBeInTheDocument();
    });
  });

  it("shows checkbox state and toggles a multi-select row", async () => {
    const { onAnswer, user } = setup({ interaction: multi });
    expect(screen.getByRole("button", { name: /Olives/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Cheese/ })).toHaveAttribute("aria-pressed", "false");
    await user.click(screen.getByRole("button", { name: /Cheese/ }));
    expect(onAnswer).toHaveBeenCalledWith(multi.options[0], {});
  });

  it("says the menu changed when the bridge refuses a stale card", async () => {
    const onAnswer = vi.fn((): Promise<AnswerOutcome> => Promise.resolve({ ok: false, error: "changed", code: "interaction_changed" }));
    const { user } = setup({ onAnswer });
    await user.click(screen.getByRole("button", { name: /Apple/ }));
    expect(await screen.findByText("Menu changed. Refreshing.")).toBeVisible();
  });

  it("respects a read-only device", () => {
    setup({ readOnly: true });
    expect(screen.getByText("Read-only on this device.")).toBeVisible();
    expect(screen.getByRole("button", { name: /Apple/ })).toBeDisabled();
  });

  it("shows the optimistic receipt once answered", () => {
    setup({ interaction: undefined, receipt: { paneId: "w1:p1", signature: "sig-1", label: "Apple", at: 0 } });
    expect(screen.getByRole("status")).toHaveTextContent("Answered: Apple");
  });

  describe("compact (Home)", () => {
    it("keeps approval off a permission without its full detail and offers Open", async () => {
      const { onOpen, user } = setup({ interaction: permission, compact: true, title: "panel depo" });
      expect(screen.queryByRole("button", { name: /^Yes$/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /don’t ask again/ })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^No/ })).toBeEnabled();
      expect(screen.getByText("panel depo", { exact: false })).toBeVisible();
      await user.click(screen.getByRole("button", { name: "Open" }));
      expect(onOpen).toHaveBeenCalled();
    });

    it("approves a permission whose full detail is on the card", async () => {
      const { onAnswer, user } = setup({ interaction: { ...permission, detailComplete: true }, compact: true });
      await user.click(screen.getByRole("button", { name: /^Yes$/ }));
      expect(onAnswer).toHaveBeenCalledWith(permission.options[0], {});
      expect(document.querySelector("[data-question-card]")).toHaveAttribute("data-question-card", "compact");
    });
  });
});
