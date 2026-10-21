import { act, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { StatusArea, TOAST_EXIT_MS } from "./status-area";
import { clearStatus, setStatus } from "@/lib/status";

/** Past the exit: a dismissed notice stays mounted for its fade, then leaves. */
const finishExit = () => act(() => vi.advanceTimersByTime(TOAST_EXIT_MS));

describe("workbench notifications", () => {
  beforeEach(() => { vi.useFakeTimers(); clearStatus(); });
  afterEach(() => { clearStatus(); vi.useRealTimers(); });

  it("floats outside route layout and never takes focus from the composer", () => {
    const { container } = render(<><textarea aria-label="Reply" /><StatusArea /></>);
    const input = screen.getByRole("textbox");
    input.focus();
    act(() => setStatus("Codex finished", "success", undefined, { description: "shop · web" }));
    const notice = screen.getByRole("status");
    expect(container).not.toContainElement(notice);
    expect(document.activeElement).toBe(input);
    expect(screen.getByText("shop · web")).toBeVisible();
    expect(screen.getAllByRole("region", { name: "Notifications" })).toHaveLength(1);
  });

  it.each(["info", "success", "warn", "error"] as const)("offers a separate dismiss button for %s", (tone) => {
    render(<StatusArea />);
    act(() => setStatus("A complete, selectable message", tone, null));
    fireEvent.click(screen.getByText("A complete, selectable message"));
    expect(screen.getByText("A complete, selectable message")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    finishExit();
    expect(screen.queryByText("A complete, selectable message")).not.toBeInTheDocument();
  });

  it("pauses while hovered or focused, resuming only after both leave", () => {
    render(<><textarea aria-label="Reply" /><StatusArea /></>);
    act(() => setStatus("Finished", "success"));
    const notice = screen.getByRole("status");
    fireEvent.mouseEnter(notice);
    act(() => screen.getByRole("button", { name: "Dismiss notification" }).focus());
    fireEvent.mouseLeave(notice);
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.getByText("Finished")).toBeVisible();
    act(() => screen.getByRole("textbox").focus());
    act(() => vi.advanceTimersByTime(2500));
    finishExit();
    expect(screen.queryByText("Finished")).not.toBeInTheDocument();
  });

  it("does not expire a notification while the page is hidden", () => {
    render(<StatusArea />);
    const hidden = vi.spyOn(document, "hidden", "get");
    hidden.mockReturnValue(true);
    act(() => setStatus("Finished", "success"));
    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.getByText("Finished")).toBeVisible();
    hidden.mockReturnValue(false);
    fireEvent(document, new Event("visibilitychange"));
    act(() => vi.advanceTimersByTime(2500));
    finishExit();
    expect(screen.queryByText("Finished")).not.toBeInTheDocument();
    hidden.mockRestore();
  });

  it("keeps a dismissed notice on screen for its exit, then removes it", () => {
    render(<StatusArea />);
    act(() => setStatus("Tab closed", "info"));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    // Still drawn, fading out and no longer something to press or read.
    const leaving = screen.getByText("Tab closed").closest("[data-leaving]");
    expect(leaving).not.toBeNull();
    expect(leaving).toHaveAttribute("inert");
    act(() => vi.advanceTimersByTime(TOAST_EXIT_MS - 1));
    expect(screen.getByText("Tab closed")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText("Tab closed")).not.toBeInTheDocument();
  });

  it("still leaves after TOAST_EXIT_MS under reduced motion, as a fade alone", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-reduced-motion"), media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    }));
    render(<StatusArea />);
    act(() => setStatus("Tab closed", "info"));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    act(() => vi.advanceTimersByTime(TOAST_EXIT_MS));
    expect(screen.queryByText("Tab closed")).not.toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("a newer notice replaces one that is still leaving", () => {
    render(<StatusArea />);
    act(() => setStatus("Tab closed", "info"));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    act(() => setStatus("Pane closed", "info"));
    expect(screen.queryByText("Tab closed")).not.toBeInTheDocument();
    expect(screen.getByText("Pane closed").closest("[data-leaving]")).toBeNull();
    finishExit();
    expect(screen.getByText("Pane closed")).toBeVisible();
  });

  it("dismisses on a swipe up past 24 px and springs back from a shorter drag", () => {
    render(<StatusArea />);
    act(() => setStatus("Tab closed", "info"));
    const card = screen.getByRole("status");
    fireEvent.pointerDown(card, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(card, { pointerId: 1, clientX: 100, clientY: 84 });
    fireEvent.pointerUp(card, { pointerId: 1, clientX: 100, clientY: 84 });
    expect(card.closest("[data-leaving]")).toBeNull();
    fireEvent.pointerDown(card, { pointerId: 2, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(card, { pointerId: 2, clientX: 100, clientY: 80 });
    fireEvent.pointerMove(card, { pointerId: 2, clientX: 100, clientY: 70 });
    fireEvent.pointerUp(card, { pointerId: 2, clientX: 100, clientY: 70 });
    expect(screen.getByText("Tab closed").closest("[data-leaving]")).not.toBeNull();
    finishExit();
    expect(screen.queryByText("Tab closed")).not.toBeInTheDocument();
  });

  it("leaves a message that overflows its box to the finger's scroll, and takes the swipe from short ones", () => {
    // jsdom lays nothing out: the text box reports the size a long raw error measured in the bench.
    const overflow = { scroll: 842, client: 256 };
    const scrollHeight = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => overflow.scroll);
    const clientHeight = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => overflow.client);
    render(<StatusArea />);
    act(() => setStatus("Send failed: a very long raw error from the bridge", "error", null));
    const longText = screen.getByText(/very long raw error/).parentElement!;
    expect(longText).toHaveClass("touch-pan-y");
    expect(longText).not.toHaveClass("touch-none");

    overflow.scroll = overflow.client;
    act(() => setStatus("Tab closed", "info"));
    const shortText = screen.getByText("Tab closed").parentElement!;
    expect(shortText).toHaveClass("touch-none");
    scrollHeight.mockRestore();
    clientHeight.mockRestore();
  });

  it("makes a notice with a destination a control that opens it and clears the notice", async () => {
    const router = createMemoryRouter([
      { path: "/", element: <><p>Home page</p><StatusArea /></> },
      { path: "/pane/:paneId", element: <><p>Pane page</p><StatusArea /></> },
    ]);
    render(<RouterProvider router={router} />);
    act(() => setStatus("Working Claude needs your input", "warn", undefined, { description: "nenu · redesign", to: "/pane/w1%3Aworking" }));
    const open = screen.getByRole("link", { name: /Working Claude needs your input/ });
    expect(open).toHaveAccessibleName(/nenu · redesign/);
    expect(open).toHaveAttribute("href", "/pane/w1%3Aworking");
    await act(async () => { fireEvent.click(open); });
    expect(router.state.location.pathname).toBe("/pane/w1%3Aworking");
    finishExit();
    expect(screen.queryByText("Working Claude needs your input")).not.toBeInTheDocument();
    router.dispose();
  });

  // Every notice can be closed where it sits: one that opens a chat used to offer only its link.
  it("gives a notice with a destination its own close button, which closes it without opening anything", async () => {
    const router = createMemoryRouter([{ path: "/", element: <StatusArea /> }, { path: "/pane/:paneId", element: <p>Pane page</p> }]);
    render(<RouterProvider router={router} />);
    act(() => setStatus("Codex finished", "success", undefined, { to: "/pane/w1%3Aworking" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" })); });
    expect(router.state.location.pathname).toBe("/");
    finishExit();
    expect(screen.queryByText("Codex finished")).not.toBeInTheDocument();
    router.dispose();
  });
});
