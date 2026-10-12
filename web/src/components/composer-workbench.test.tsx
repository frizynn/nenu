import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRef, useState, type ComponentProps } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { sendMessage } from "@/lib/api";
import { loadDraft } from "@/lib/drafts";
import { clearStatus, useStatus } from "@/lib/status";
import { declarations } from "@/test/css-rules";
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

/** The toast line, as the status area would show it. */
function StatusLine() {
  return <output data-testid="status">{useStatus()?.text ?? ""}</output>;
}

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
  const router = createMemoryRouter([{ path: "/", element: <><Composer {...props} ref={ref} /><StatusLine /></> }]);
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

it("publishes its secondary controls, grouped, instead of rendering them", async () => {
  const { controls, user } = setup({ nativeWorkbench: true, usageControls: <button>Session metrics</button> });
  const input = screen.getByRole("textbox");
  await user.type(input, "draft survives navigation");
  expect(controls().map(({ group, label }) => `${group}: ${label}`)).toEqual([
    "Attach: Photo", "Replies: Quick replies", "Replies: Commands", "Terminal: Keys", "Terminal: Type into terminal",
    "Session: Context and usage", "View: Display",
  ]);
  for (const name of ["Photo", "Keys", "Quick replies", "Display", "Session metrics"]) expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
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

it("reports a failed toolbar command in a toast, never as a draft's notice with Try again", async () => {
  // Try again resends a message; a /compact that failed to verify is not one, and re-sending its
  // text as a reply would skip the action's own guard.
  vi.mocked(sendMessage).mockResolvedValueOnce({ ok: false, requestId: "r", stage: "verify", error: "Compact didn't reach the agent.", textDelivered: false });
  const { ref } = setup();
  await act(async () => { expect(await ref.current!.compactContext()).toBe(false); });
  expect(screen.getByTestId("status")).toHaveTextContent("Compact didn't reach the agent.");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
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

it("puts one + at the start of the box and Send at its end; the row beneath holds only the session", () => {
  setup({ modelControl: <button>Choose model</button>, processesControl: <button>Processes: 1 done</button> });
  expect(screen.queryByText("Controls")).not.toBeInTheDocument();
  const input = screen.getByRole("textbox");
  const box = input.parentElement!;
  // One box: the + leads, the draft grows in the middle, Send closes it. No second menu anywhere.
  expect(within(box).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Message actions", "Send"]);
  const plus = within(box).getByRole("button", { name: "Message actions" });
  expect(plus.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(input.compareDocumentPosition(within(box).getByRole("button", { name: "Send" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "Message actions" })).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Attach image" })).not.toBeInTheDocument();
  const toolbar = screen.getByRole("group", { name: "Message tools" });
  expect(toolbar).not.toContainElement(input);
  expect(within(toolbar).getAllByRole("button").map((button) => button.textContent)).toEqual(["Choose model", "Processes: 1 done"]);
});

it("opens one menu from the +, grouped Attach, Replies, Terminal and Session, and runs a row like the header menu does", async () => {
  const { user } = setup({ usageControls: <button>Session metrics</button> });
  const input = screen.getByRole("textbox");
  await user.type(input, "Keep writing here");
  await user.click(screen.getByRole("button", { name: "Message actions" }));
  const menu = screen.getByRole("dialog", { name: "Message actions" });
  const groups = [...menu.querySelectorAll("section")].map((section) =>
    `${section.getAttribute("aria-label")}: ${within(section).getAllByRole("button").map((button) => button.textContent).join(", ")}`);
  expect(groups).toEqual(["Attach: Photo", "Replies: Quick replies, Commands", "Terminal: Keys, Type into terminal", "Session: Context and usage"]);
  // "Type into terminal" stays a row with its name, never a gesture; Display stays in the header.
  expect(within(menu).getByRole("button", { name: "Type into terminal" })).toBeVisible();
  expect(within(menu).queryByRole("button", { name: "Display" })).not.toBeInTheDocument();
  await user.click(within(menu).getByRole("button", { name: "Quick replies" }));
  expect(screen.queryByRole("dialog", { name: "Message actions" })).not.toBeInTheDocument();
  // The dock is titled with the row that opened it.
  expect(screen.getByRole("heading", { name: "Quick replies" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Close Quick replies" })).toBeVisible();
  expect(input).toHaveValue("Keep writing here");
  expect(sendMessage).not.toHaveBeenCalled();
});

it("takes the phone keyboard down when the + opens its menu, so the menu has the screen", async () => {
  const { user } = setup();
  const input = screen.getByRole("textbox");
  await user.click(input);
  expect(input).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "Message actions" }));
  expect(screen.getByRole("dialog", { name: "Message actions" })).toBeVisible();
  expect(input).not.toHaveFocus();
});

it("reaches the + menu's rows from the keyboard and hands focus back to the + on Escape", async () => {
  const { user } = setup({ usageControls: <button>Session metrics</button> });
  const plus = screen.getByRole("button", { name: "Message actions" });
  plus.focus();
  await user.keyboard("{Enter}");
  const menu = screen.getByRole("dialog", { name: "Message actions" });
  // The menu takes focus on its first row and Tab walks the rest; leaving it is Escape.
  expect(within(menu).getByRole("button", { name: "Photo" })).toHaveFocus();
  await user.tab();
  expect(within(menu).getByRole("button", { name: "Quick replies" })).toHaveFocus();
  expect(menu).toBeVisible();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "Message actions" })).not.toBeInTheDocument();
  expect(plus).toHaveFocus();
});

it("takes the keyboard down itself when the + opens its menu, as a tap on iOS leaves focus in the draft", async () => {
  const { user } = setup();
  const input = screen.getByRole("textbox");
  await user.click(input);
  // Safari on iOS does not focus a button it taps, so the click arrives with the draft still focused.
  fireEvent.click(screen.getByRole("button", { name: "Message actions" }));
  expect(screen.getByRole("dialog", { name: "Message actions" })).toBeVisible();
  expect(input).not.toHaveFocus();
});

it("closes the + menu when the pane locks, so it does not come back by itself on unlock", async () => {
  function Lockable(props: ComponentProps<typeof Composer>) {
    const [readOnly, setReadOnly] = useState(false);
    return <><button type="button" onClick={() => setReadOnly(!readOnly)}>Toggle lock</button><Composer {...props} readOnly={readOnly} /></>;
  }
  const props: ComponentProps<typeof Composer> = {
    paneId: "w1:p1", agent: "codex", isShell: false, gone: false, readOnly: false, nativeWorkbench: true, dialogPresent: false,
    text: "pane output", terminalDraft: null, rawTerminalDraft: null,
    prefs: { wrap: true, fontSize: 11, rawTerminal: false, tapToFocus: true },
    setWrap: vi.fn(), stepFontSize: vi.fn(), setRawTerminal: vi.fn(), setTapToFocus: vi.fn(), onSent: vi.fn(),
  };
  render(<RouterProvider router={createMemoryRouter([{ path: "/", element: <Lockable {...props} /> }])} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Message actions" }));
  expect(screen.getByRole("dialog", { name: "Message actions" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Toggle lock" }));
  expect(screen.queryByRole("dialog", { name: "Message actions" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Toggle lock" }));
  expect(screen.queryByRole("dialog", { name: "Message actions" })).not.toBeInTheDocument();
});

it("opens the image picker from the menu's Photo row", async () => {
  const { user } = setup();
  const picker = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  const click = vi.spyOn(picker, "click").mockImplementation(() => {});
  await user.click(screen.getByRole("button", { name: "Message actions" }));
  await user.click(within(screen.getByRole("dialog", { name: "Message actions" })).getByRole("button", { name: "Photo" }));
  expect(click).toHaveBeenCalledOnce();
  expect(screen.queryByRole("dialog", { name: "Message actions" })).not.toBeInTheDocument();
});

it("gives every small composer control a 44px touch target", () => {
  setup({ modelControl: <button>Choose model</button> });
  expect(screen.getByRole("button", { name: "Message actions" })).toHaveClass("hit-area");
  expect(screen.getByRole("button", { name: "Send" })).toHaveClass("hit-area");
  const css = readFileSync(resolve(import.meta.dirname, "../workbench.css"), "utf8");
  expect(declarations(css, ".hit-area::before", ["@media (pointer: coarse)"])).toMatchObject({ width: "max(100%, 44px)", height: "max(100%, 44px)" });
});

it("gives a draft the + column's width while the phone keyboard is up, so it wraps no sooner than before", async () => {
  // Measured on the bench: with the + inside the box a four-line draft wrapped to six lines and the
  // thread lost 48px; folding the + while typing under the keyboard keeps it at four.
  const { user } = setup();
  const box = screen.getByRole("textbox").parentElement!;
  expect(box).not.toHaveClass("composer-box-typing");
  await user.type(screen.getByRole("textbox"), "a");
  expect(box).toHaveClass("composer-box-typing");
  const css = readFileSync(resolve(import.meta.dirname, "../styles/composer.css"), "utf8");
  expect(declarations(css, ".workbench-chat[data-keyboard-open] .composer-box-typing .composer-lead", ["@media (max-width: 1023px) and (pointer: coarse)"])).toMatchObject({ width: "0", visibility: "hidden" });
  // Off the keyboard, and on a desk, the + stays: the menu is one tap away while a draft waits.
  expect(screen.getByRole("button", { name: "Message actions" })).toBeVisible();
});

it("gives the thread the meta row's height while the phone keyboard is up", () => {
  const css = readFileSync(resolve(import.meta.dirname, "../styles/composer.css"), "utf8");
  expect(declarations(css, ".workbench-chat[data-keyboard-open] .composer-meta", ["@media (max-width: 1023px) and (pointer: coarse)"])).toMatchObject({ display: "none" });
});

it("paints the armed Send in the accent its box wears, so armed reads as one signal", async () => {
  const { user } = setup();
  await user.click(screen.getByRole("button", { name: "Message actions" }));
  await user.click(within(screen.getByRole("dialog", { name: "Message actions" })).getByRole("button", { name: "Type into terminal" }));
  const armed = screen.getByRole("button", { name: "Stop typing into terminal" });
  expect(armed).toHaveAttribute("aria-pressed", "true");
  expect(armed).toHaveClass("composer-send");
  // The ink primary must not win here: the direction keeps the accent for the armed mode.
  const css = readFileSync(resolve(import.meta.dirname, "../styles/composer.css"), "utf8");
  const box = declarations(css, ".composer-box-armed")["border-color"];
  expect(box).toBe("var(--primary)");
  expect(declarations(css, '.composer-send[aria-pressed="true"]')).toMatchObject({ background: box, color: "var(--primary-foreground)" });
});

it("opens quick replies from the menu without changing or sending the draft", async () => {
  const { run, user } = setup();
  const input = screen.getByRole("textbox");
  await user.type(input, "Keep writing here");
  run("quick");
  expect(screen.getByRole("button", { name: "Close Quick replies" })).toBeVisible();
  expect(input).toHaveValue("Keep writing here");
  expect(sendMessage).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Close Quick replies" }));
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
  expect(screen.getByRole("button", { name: "Stop" })).toBeVisible();
});

it("keeps Stop beside Send while a draft is written, never only in a menu", async () => {
  const { controls, user } = setup({ working: true });
  await user.type(screen.getByRole("textbox"), "next step");
  expect(screen.getByRole("button", { name: "Stop" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  expect(controls().some((control) => control.label.startsWith("Stop"))).toBe(false);
});
