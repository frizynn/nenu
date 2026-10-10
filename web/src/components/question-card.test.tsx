import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { Interaction } from "@/lib/types";
import type { AnswerOutcome } from "@/lib/types";
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
    { index: 3, label: "Tell Claude what to change", role: "freeText" },
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

  it("sends a free-text row of a question to the terminal instead of answering", async () => {
    const { onAnswer, onOpen, user } = setup();
    await user.click(screen.getByRole("button", { name: /Type something\. \(in terminal\)/ }));
    expect(onOpen).toHaveBeenCalled();
    expect(onAnswer).not.toHaveBeenCalled();
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
    await user.click(screen.getByRole("button", { name: "Send to Claude" }));
    expect(onAnswer).toHaveBeenCalledWith(plan.options[3], { text: "Split it in two" });
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
