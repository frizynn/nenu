import { fireEvent, render, screen } from "@testing-library/react";

import { IdleLock } from "./idle-lock";

describe("IdleLock", () => {
  it("says Paused and offers Resume, in words that fit a desk as well as a phone", () => {
    const onUnlock = vi.fn();
    render(<IdleLock onUnlock={onUnlock} />);
    const cover = screen.getByRole("dialog", { name: "Nenu paused" });
    expect(cover).toHaveTextContent("Paused");
    expect(cover).not.toHaveTextContent(/tap/i);
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(onUnlock).toHaveBeenCalledOnce();
  });

  it("resumes on Enter", () => {
    const onUnlock = vi.fn();
    render(<IdleLock onUnlock={onUnlock} />);
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onUnlock).toHaveBeenCalledOnce();
  });

  it("keeps the same button slot while catching up: disabled, busy, with a spinner and a label", () => {
    const onUnlock = vi.fn();
    render(<IdleLock onUnlock={onUnlock} catchingUp />);
    const button = screen.getByRole("button", { name: "Resuming…" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button.querySelector("svg")).not.toBeNull();
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onUnlock).not.toHaveBeenCalled();
  });

  // Resume unmounts the cover for one render before the catch-up beat mounts it again: a fade there
  // would flash the cover out and back in.
  it("fades in when the pause arrives, and the catch-up cover is simply there", () => {
    const { unmount } = render(<IdleLock onUnlock={() => {}} />);
    expect(screen.getByRole("dialog")).toHaveClass("animate-in", "fade-in");
    unmount();
    render(<IdleLock onUnlock={() => {}} catchingUp />);
    expect(screen.getByRole("dialog")).not.toHaveClass("animate-in");
  });

  it("never draws a lock or speaks of safety: the pause guards nothing (ADR 0007)", () => {
    const { container } = render(<IdleLock onUnlock={() => {}} />);
    expect(container.querySelector("[class*='icon-lock']")).toBeNull();
    expect(screen.getByRole("dialog")).not.toHaveTextContent(/lock|safe|secur/i);
  });
});
