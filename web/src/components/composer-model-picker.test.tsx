import { createRef } from "react";
import type { ComponentProps } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { http, HttpResponse } from "msw";
import { Composer, type ComposerHandle } from "./composer";
import { __resetOperatorCommands, loadOperatorCommands } from "@/lib/operator-config";
import { loadDraft } from "@/lib/drafts";
import { server } from "@/test/setup";
import { recordReply } from "@/test/handlers";

beforeEach(() => __resetOperatorCommands());

function mount(overrides: Partial<ComponentProps<typeof Composer>> = {}) {
  const ref = createRef<ComposerHandle>();
  const props: ComponentProps<typeof Composer> = {
    paneId: "w1:p1", session: "work", agent: "claude", isShell: false,
    gone: false, readOnly: false, dialogPresent: false, text: "pane output",
    terminalDraft: null, rawTerminalDraft: null,
    prefs: { wrap: true, fontSize: 11, rawTerminal: false, tapToFocus: true },
    setWrap: vi.fn(), stepFontSize: vi.fn(), setRawTerminal: vi.fn(), setTapToFocus: vi.fn(), onSent: vi.fn(),
    ...overrides,
  };
  const router = createMemoryRouter([{ path: "/", element: <Composer {...props} ref={ref} /> }]);
  render(<RouterProvider router={router} />);
  return ref;
}

it("opens the real model picker through a scoped verified send and preserves the browser draft", async () => {
  const writes: Array<{ url: string; text: string }> = [];
  server.use(http.post(/\/api\/pane\/[^/]+\/send$/, async ({ request }) => {
    const body = await request.json() as { text: string; requestId: string };
    writes.push({ url: request.url, text: body.text });
    recordReply({ text: body.text, submit: true });
    return HttpResponse.json({ ok: true, requestId: body.requestId, ack: "submitted" });
  }));
  const ref = mount();
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "Keep this unsent work" } });
  let sent = false;
  await act(async () => { sent = await ref.current!.openModelPicker(); });
  expect(sent).toBe(true);
  // One request: the bridge types, verifies and submits.
  expect(writes.map(({ text }) => text)).toEqual(["/model"]);
  const url = new URL(writes[0]!.url);
  expect(decodeURIComponent(url.pathname)).toBe("/api/pane/w1:p1/send");
  expect(url.searchParams.get("session")).toBe("work");
  expect(input).toHaveValue("Keep this unsent work");
  expect(loadDraft("work", "w1:p1")).toBe("Keep this unsent work");
});

it.each([
  ["read-only", { readOnly: true }],
  ["gone pane", { gone: true }],
  ["host draft", { rawTerminalDraft: "host input" }],
  ["dialog", { dialogPresent: true }],
  ["unsupported agent", { agent: "unknown-agent" }],
] as const)("refuses the model shortcut for %s without writing", async (_name, overrides) => {
  const writes = vi.fn();
  server.use(http.post(/\/api\/pane\/[^/]+\/(send|reply)$/, async () => {
    writes();
    return HttpResponse.json({ ok: true });
  }));
  const ref = mount(overrides);
  let sent = true;
  await act(async () => { sent = await ref.current!.openModelPicker(); });
  expect(sent).toBe(false);
  expect(writes).not.toHaveBeenCalled();
});

it("does not bypass an operator-required model confirmation", async () => {
  const writes = vi.fn();
  server.use(
    http.get(/\/api\/config$/, () => HttpResponse.json({
      push: false, vapidPublicKey: "",
      operatorCommands: [{ agent: "claude", command: "/model", description: "Change models", takesArg: false, argHint: "", confirm: true }],
    })),
    http.post(/\/api\/pane\/[^/]+\/(send|reply)$/, () => {
      writes();
      return HttpResponse.json({ ok: true });
    }),
  );
  await loadOperatorCommands();
  const ref = mount();
  let sent = true;
  await act(async () => { sent = await ref.current!.openModelPicker(); });
  expect(sent).toBe(false);
  expect(writes).not.toHaveBeenCalled();
});
