import { createRef, type ComponentProps } from "react";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { sendMessage } from "@/lib/api";
import { loadDraft } from "@/lib/drafts";
import { clearStatus } from "@/lib/status";
import { Composer, type ComposerControl, type ComposerHandle } from "./composer";

// These seams isolate workbench commands from the separately tested send protocol: the bridge's
// one-request send, and the browser guard that only the "Type anyway" override still uses.
// Assertions below require commands to use the guarded send, preserve drafts and remain explicit.
vi.mock("@/lib/api", async (original) => ({ ...(await original<typeof import("@/lib/api")>()), sendMessage: vi.fn() }));

const refused = { ok: false as const, requestId: "r", stage: "preflight" as const, error: "Input changed", textDelivered: false, code: "not_ready" as const };

beforeEach(() => {
  vi.mocked(sendMessage).mockReset();
  vi.mocked(sendMessage).mockImplementation(async (_pane, request) => ({ ok: true, requestId: request.requestId, ack: "submitted" }));
  clearStatus();
});

/** The texts sent through the bridge's one-request send, with the pane and session they went to. */
const sent = () => vi.mocked(sendMessage).mock.calls.map(([pane, request, session]) => ({ pane, text: request.text, session }));

function setup(overrides: Partial<ComponentProps<typeof Composer>> = {}) {
  const ref = createRef<ComposerHandle>();
  const onSent = vi.fn();
  let controls: ComposerControl[] = [];
  const onControlsChange = (next: ComposerControl[]) => { controls = next; };
  const props: ComponentProps<typeof Composer> = {
    paneId: "w1:p1", session: "work", agent: "codex", isShell: false,
    gone: false, readOnly: false, disconnected: false, nativeWorkbench: true, dialogPresent: false,
    text: "pane output", terminalDraft: null, rawTerminalDraft: null,
    prefs: { wrap: true, fontSize: 11, rawTerminal: false, tapToFocus: true },
    setWrap: vi.fn(), stepFontSize: vi.fn(), setRawTerminal: vi.fn(), setTapToFocus: vi.fn(),
    onSent, onControlsChange, ...overrides,
  };
  const router = createMemoryRouter([{ path: "/", element: <Composer {...props} ref={ref} /> }]);
  render(<RouterProvider router={router} />);
  /** The ⋯ menu's view of the composer: its published controls, run as a menu tap would. */
  const run = (id: ComposerControl["id"]) => act(() => controls.find((control) => control.id === id)!.run());
  return { ref, onSent, user: userEvent.setup(), controls: () => controls, run };
}

it("opens the native model picker through the guard without consuming a draft or jumping history", async () => {
  const { ref, onSent, user } = setup();
  const input = screen.getByRole("textbox");
  await user.type(input, "Keep this unfinished thought");
  expect(sendMessage).not.toHaveBeenCalled();
  let result = false;
  await act(async () => { result = await ref.current!.openModelPicker(); });
  expect(result).toBe(true);
  expect(sent()).toEqual([{ pane: "w1:p1", text: "/model", session: "work" }]);
  expect(input).toHaveValue("Keep this unfinished thought");
  expect(loadDraft("work", "w1:p1")).toBe("Keep this unfinished thought");
  expect(onSent).not.toHaveBeenCalled();
});

it("compacts only after the explicit command and retains the local draft", async () => {
  const { ref, onSent, user } = setup();
  await user.type(screen.getByRole("textbox"), "Continue with this afterwards");
  expect(sendMessage).not.toHaveBeenCalled();
  await act(async () => { expect(await ref.current!.compactContext()).toBe(true); });
  expect(sent()).toEqual([{ pane: "w1:p1", text: "/compact", session: "work" }]);
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
  expect(sendMessage).not.toHaveBeenCalled();
  expect(onSent).not.toHaveBeenCalled();
});

it("keeps composing available while disconnected or a dialog is open", async () => {
  const { user } = setup({ disconnected: true, dialogPresent: true });
  const input = screen.getByRole("textbox");
  expect(input).toBeEnabled();
  await user.type(input, "Draft while waiting");
  expect(input).toHaveValue("Draft while waiting");
  expect(loadDraft("work", "w1:p1")).toBe("Draft while waiting");
  expect(sendMessage).not.toHaveBeenCalled();
});

it("publishes its secondary controls to the header menu, grouped, instead of rendering them", async () => {
  const { controls, user } = setup({ nativeWorkbench: true, usageControls: <button>Session metrics</button> });
  const input = screen.getByRole("textbox");
  await user.type(input, "draft survives navigation");
  expect(controls().map(({ group, label }) => `${group}: ${label}`)).toEqual([
    "Terminal: Keys", "Terminal: Type into terminal", "Shortcuts: Quick replies", "Shortcuts: Commands",
    "View: Display", "View: Context and usage",
  ]);
  for (const name of ["Keys", "Quick replies", "Display", "Session metrics"]) expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
  expect(input).toHaveValue("draft survives navigation");
});

it("does not convert a rejected picker command into a forced send on retry", async () => {
  vi.mocked(sendMessage).mockResolvedValue(refused);
  const { ref, onSent, user } = setup();
  await user.type(screen.getByRole("textbox"), "Preserve this draft");
  await act(async () => { expect(await ref.current!.openModelPicker()).toBe(false); });
  await act(async () => { expect(await ref.current!.openModelPicker()).toBe(false); });
  expect(sendMessage).toHaveBeenCalledTimes(2);
  // Neither retry became a forced "Type anyway" send.
  expect(vi.mocked(sendMessage).mock.calls.some(([, request]) => request.force)).toBe(false);
  expect(screen.getByRole("textbox")).toHaveValue("Preserve this draft");
  expect(onSent).not.toHaveBeenCalled();
});

it("does not arm a normal draft override when a toolbar command is rejected", async () => {
  vi.mocked(sendMessage).mockResolvedValueOnce(refused);
  const { ref, user } = setup();
  await user.type(screen.getByRole("textbox"), "A normal draft");
  await act(async () => { expect(await ref.current!.openModelPicker()).toBe(false); });
  await user.keyboard("{Control>}{Enter}{/Control}");
  expect(sent().at(-1)).toMatchObject({ text: "A normal draft" });
  expect(vi.mocked(sendMessage).mock.calls.at(-1)?.[1].force).toBeUndefined();
});

it("waits for verified model dismissal before sending, keeping what was typed during the wait", async () => {
  let finish!: (ready: boolean) => void;
  const prepareSend = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  const { user } = setup({ dialogPresent: true, prepareSend });
  const input = screen.getByRole("textbox");
  await user.type(input, "Send this message");
  await user.keyboard("{Control>}{Enter}{/Control}");
  expect(prepareSend).toHaveBeenCalledOnce();
  expect(sendMessage).not.toHaveBeenCalled();
  await user.type(input, " and keep these new words");
  await act(async () => finish(true));
  expect(sent()).toEqual([expect.objectContaining({ text: "Send this message" })]);
  // The sent message left the box when Send was tapped; only the newer words remain.
  expect(input).toHaveValue(" and keep these new words");
});

it("does not send or arm force when the model cannot be dismissed", async () => {
  const prepareSend = vi.fn().mockResolvedValue(false);
  const { user } = setup({ dialogPresent: true, prepareSend });
  const input = screen.getByRole("textbox");
  await user.type(input, "Keep me");
  await user.keyboard("{Control>}{Enter}{/Control}");
  expect(sendMessage).not.toHaveBeenCalled();
  expect(input).toHaveValue("Keep me");
  prepareSend.mockResolvedValue(true);
  await user.keyboard("{Control>}{Enter}{/Control}");
  expect(sent()).toEqual([expect.objectContaining({ text: "Keep me" })]);
});

it("gives the draft the full width above a toolbar of attach, model chip and send", () => {
  setup({ modelControl: <button>Choose model</button> });
  expect(screen.queryByText("Controls")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "More message actions" })).not.toBeInTheDocument();
  const input = screen.getByRole("textbox");
  const toolbar = screen.getByRole("group", { name: "Message tools" });
  // Regression: the draft used to share a row with these buttons and wrapped every few words.
  expect(toolbar).not.toContainElement(input);
  expect(within(input.parentElement!).queryAllByRole("button")).toHaveLength(0);
  expect(input.parentElement!.nextElementSibling).toBe(toolbar);
  const order = ["Attach image", "Choose model", "Send"].map((name) => within(toolbar).getByRole("button", { name }));
  expect(order[0]!.compareDocumentPosition(order[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(order[1]!.compareDocumentPosition(order[2]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it("opens quick replies from the menu without changing or sending the draft", async () => {
  const { run, user } = setup();
  const input = screen.getByRole("textbox");
  await user.type(input, "Keep writing here");
  run("quick");
  expect(screen.getByRole("button", { name: "Close Quick" })).toBeVisible();
  expect(input).toHaveValue("Keep writing here");
  expect(sendMessage).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Close Quick" }));
  expect(input).toBeEnabled();
});


it("keeps the configured confirmation when a disruptive slash command is typed into the composer", async () => {
  const { user } = setup();
  const input = screen.getByRole("textbox");
  await user.type(input, "/new");
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("button", { name: "Send" }));
  expect(sendMessage).not.toHaveBeenCalled();
  expect(input).toHaveValue("/new");
  await user.click(screen.getByRole("button", { name: "Really send?" }));
  expect(sent()).toEqual([expect.objectContaining({ text: "/new" })]);
});

it("keeps session usage one menu tap away without cluttering the composer", async () => {
  const { run } = setup({ nativeWorkbench: true, usageControls: <button>Session metrics</button> });
  expect(screen.queryByRole("button", { name: "Session metrics" })).not.toBeInTheDocument();
  run("usage");
  expect(screen.getAllByRole("button", { name: "Session metrics" })).toHaveLength(1);
});

 it("shows Stop in the ordinary workbench while Codex works", () => {
  setup({ working: true });
  expect(screen.getByRole("button", { name: "Stop generation" })).toBeVisible();
});

it("moves Stop to the menu while a draft holds the send slot", async () => {
  const { controls, user } = setup({ working: true });
  expect(controls().some((control) => control.id === "stop")).toBe(false);
  await user.type(screen.getByRole("textbox"), "next step");
  expect(controls().find((control) => control.id === "stop")).toMatchObject({ group: "Terminal", label: "Stop generation" });
});
