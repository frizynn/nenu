import { createRef, type ComponentProps } from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { sendGuardedReply } from "@/lib/reply-action";
import { loadDraft } from "@/lib/drafts";
import { clearStatus } from "@/lib/status";
import { Composer, type ComposerHandle } from "./composer";

// This seam isolates workbench commands from the separately tested type/verify/submit protocol.
// Assertions below require commands to use that guard, preserve drafts and remain explicit.
vi.mock("@/lib/reply-action", () => ({ sendGuardedReply: vi.fn() }));

beforeEach(() => {
  vi.mocked(sendGuardedReply).mockReset();
  vi.mocked(sendGuardedReply).mockResolvedValue({ status: "sent" });
  clearStatus();
});

function setup(overrides: Partial<ComponentProps<typeof Composer>> = {}) {
  const ref = createRef<ComposerHandle>();
  const onSent = vi.fn();
  const props: ComponentProps<typeof Composer> = {
    paneId: "w1:p1", session: "work", agent: "codex", isShell: false,
    gone: false, readOnly: false, disconnected: false, nativeWorkbench: true, dialogPresent: false,
    text: "pane output", terminalDraft: null, rawTerminalDraft: null,
    prefs: { wrap: true, fontSize: 11, rawTerminal: false, tapToFocus: true },
    setWrap: vi.fn(), stepFontSize: vi.fn(), setRawTerminal: vi.fn(), setTapToFocus: vi.fn(),
    onSent, ...overrides,
  };
  const router = createMemoryRouter([{ path: "/", element: <Composer {...props} ref={ref} /> }]);
  render(<RouterProvider router={router} />);
  return { ref, onSent, user: userEvent.setup() };
}

it("opens the native model picker through the guard without consuming a draft or jumping history", async () => {
  const { ref, onSent, user } = setup();
  const input = screen.getByRole("textbox");
  await user.type(input, "Keep this unfinished thought");
  expect(sendGuardedReply).not.toHaveBeenCalled();
  let result = false;
  await act(async () => { result = await ref.current!.openModelPicker(); });
  expect(result).toBe(true);
  expect(sendGuardedReply).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ paneId: "w1:p1", session: "work", agent: "codex", text: "/model", force: false }));
  expect(input).toHaveValue("Keep this unfinished thought");
  expect(loadDraft("work", "w1:p1")).toBe("Keep this unfinished thought");
  expect(onSent).not.toHaveBeenCalled();
});

it("compacts only after the explicit command and retains the local draft", async () => {
  const { ref, onSent, user } = setup();
  await user.type(screen.getByRole("textbox"), "Continue with this afterwards");
  expect(sendGuardedReply).not.toHaveBeenCalled();
  await act(async () => { expect(await ref.current!.compactContext()).toBe(true); });
  expect(sendGuardedReply).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: "/compact", force: false, session: "work" }));
  expect(screen.getByRole("textbox")).toHaveValue("Continue with this afterwards");
  expect(onSent).toHaveBeenCalledOnce();
});

it.each([
  ["host draft", { rawTerminalDraft: "Host is writing" }],
  ["disconnected", { disconnected: true }],
  ["dialog", { dialogPresent: true }],
  ["read only", { readOnly: true }],
  ["gone", { gone: true }],
] as const)("refuses both workbench commands when %s owns the input", async (_name, props) => {
  const { ref, onSent } = setup(props);
  await act(async () => {
    expect(await ref.current!.openModelPicker()).toBe(false);
    expect(await ref.current!.compactContext()).toBe(false);
  });
  expect(sendGuardedReply).not.toHaveBeenCalled();
  expect(onSent).not.toHaveBeenCalled();
});

it("keeps composing available while disconnected or a dialog is open", async () => {
  const { user } = setup({ disconnected: true, dialogPresent: true });
  const input = screen.getByRole("textbox");
  expect(input).toBeEnabled();
  await user.type(input, "Draft while waiting");
  expect(input).toHaveValue("Draft while waiting");
  expect(loadDraft("work", "w1:p1")).toBe("Draft while waiting");
  expect(sendGuardedReply).not.toHaveBeenCalled();
});

it("groups secondary actions while leaving the model and send visible", async () => {
  const { user } = setup({ nativeWorkbench: true, modelControl: <button>Choose model</button> });
  const input = screen.getByRole("textbox");
  await user.type(input, "draft survives navigation");
  expect(screen.getByRole("button", { name: "Choose model" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Send" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Display settings" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Quick replies" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "More message actions" }));
  expect(screen.getByRole("button", { name: "Quick replies" })).toBeVisible();
  expect(input).toHaveValue("draft survives navigation");
});

it("does not convert a rejected picker command into a forced send on retry", async () => {
  vi.mocked(sendGuardedReply).mockResolvedValue({ status: "blocked", error: "Input changed" });
  const { ref, onSent, user } = setup();
  await user.type(screen.getByRole("textbox"), "Preserve this draft");
  await act(async () => { expect(await ref.current!.openModelPicker()).toBe(false); });
  await act(async () => { expect(await ref.current!.openModelPicker()).toBe(false); });
  expect(sendGuardedReply).toHaveBeenCalledTimes(2);
  for (const [args] of vi.mocked(sendGuardedReply).mock.calls) expect(args.force).toBe(false);
  expect(screen.getByRole("textbox")).toHaveValue("Preserve this draft");
  expect(onSent).not.toHaveBeenCalled();
});

it("does not arm a normal draft override when a toolbar command is rejected", async () => {
  vi.mocked(sendGuardedReply).mockResolvedValueOnce({ status: "blocked", error: "Input changed" });
  const { ref, user } = setup();
  await user.type(screen.getByRole("textbox"), "A normal draft");
  await act(async () => { expect(await ref.current!.openModelPicker()).toBe(false); });
  await user.keyboard("{Control>}{Enter}{/Control}");
  expect(sendGuardedReply).toHaveBeenLastCalledWith(expect.objectContaining({ text: "A normal draft", force: false }));
});

it("waits for verified model dismissal before sending, preserving edits made during the wait", async () => {
  let finish!: (ready: boolean) => void;
  const prepareSend = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  const { user } = setup({ dialogPresent: true, prepareSend });
  const input = screen.getByRole("textbox");
  await user.type(input, "Send this message");
  await user.keyboard("{Control>}{Enter}{/Control}");
  expect(prepareSend).toHaveBeenCalledOnce();
  expect(sendGuardedReply).not.toHaveBeenCalled();
  await user.type(input, " and keep these new words");
  await act(async () => finish(true));
  expect(sendGuardedReply).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: "Send this message", force: false }));
  expect(input).toHaveValue("Send this message and keep these new words");
});

it("does not send or arm force when the model cannot be dismissed", async () => {
  const prepareSend = vi.fn().mockResolvedValue(false);
  const { user } = setup({ dialogPresent: true, prepareSend });
  const input = screen.getByRole("textbox");
  await user.type(input, "Keep me");
  await user.keyboard("{Control>}{Enter}{/Control}");
  expect(sendGuardedReply).not.toHaveBeenCalled();
  expect(input).toHaveValue("Keep me");
  prepareSend.mockResolvedValue(true);
  await user.keyboard("{Control>}{Enter}{/Control}");
  expect(sendGuardedReply).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ force: false }));
});

it("keeps native composing free of the old labelled controls row", () => {
  setup();
  expect(screen.queryByText("Controls")).not.toBeInTheDocument();
  expect(screen.queryByText("Quick")).not.toBeInTheDocument();
  expect(screen.queryByText("Agent")).not.toBeInTheDocument();
  const actions = screen.getByRole("toolbar", { name: "Message actions" });
  expect(actions).toContainElement(screen.getByRole("button", { name: "More message actions" }));
  expect(actions).toContainElement(screen.getByRole("button", { name: "Attach image" }));
  expect(screen.getByRole("textbox").compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it("opens compact quick actions without changing or sending the draft", async () => {
  const { user } = setup();
  const input = screen.getByRole("textbox");
  await user.type(input, "Keep writing here");
  await user.click(screen.getByRole("button", { name: "More message actions" }));
  await user.click(screen.getByRole("button", { name: "Quick replies" }));
  expect(screen.getByRole("button", { name: "Close Quick" })).toBeVisible();
  expect(input).toHaveValue("Keep writing here");
  expect(sendGuardedReply).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Close Quick" }));
  expect(input).toBeEnabled();
});


it("keeps the configured confirmation when a disruptive slash command is typed into the composer", async () => {
  const { user } = setup();
  const input = screen.getByRole("textbox");
  await user.type(input, "/new");
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("button", { name: "Send" }));
  expect(sendGuardedReply).not.toHaveBeenCalled();
  expect(input).toHaveValue("/new");
  await user.click(screen.getByRole("button", { name: "Really send?" }));
  expect(sendGuardedReply).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: "/new", force: false }));
});
