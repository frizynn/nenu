import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { MOTION_CONTROL_MS } from "@/lib/motion";
import { checkForUpdate } from "@/lib/pwa";
import { useUpdateNotice } from "@/lib/self-update";
import { UpdateBanner } from "./update-banner";

vi.mock("@/lib/pwa", () => ({ checkForUpdate: vi.fn() }));
vi.mock("@/lib/self-update", () => ({ useUpdateNotice: vi.fn() }));

beforeEach(() => vi.clearAllMocks());

it("draws nothing while no update waits", () => {
  vi.mocked(useUpdateNotice).mockReturnValue(false);
  const { container } = render(<UpdateBanner />);
  expect(container).toBeEmptyDOMElement();
});

it("names the new version and applies it with one tap, through the update Settings uses", async () => {
  vi.mocked(useUpdateNotice).mockReturnValue(true);
  vi.mocked(checkForUpdate).mockReturnValue(new Promise(() => {}));
  render(<UpdateBanner />);
  expect(screen.getByRole("status")).toHaveTextContent("New version of Nenu");
  await userEvent.click(screen.getByRole("button", { name: "Update" }));
  expect(checkForUpdate).toHaveBeenCalledWith();
  expect(screen.getByRole("button", { name: "Updating…" })).toBeDisabled();
});

it("keeps the page and offers another try when the update cannot finish", async () => {
  vi.mocked(useUpdateNotice).mockReturnValue(true);
  let finish!: (ok: boolean) => void;
  vi.mocked(checkForUpdate).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  render(<UpdateBanner />);
  await userEvent.click(screen.getByRole("button", { name: "Update" }));
  await act(async () => finish(false));
  expect(screen.getByRole("status")).toHaveTextContent("Couldn't finish updating.");
  expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
});

it("is simply there when the app draws with it, and folds out when the update applies", () => {
  vi.useFakeTimers();
  vi.mocked(useUpdateNotice).mockReturnValue(true);
  const { rerender } = render(<UpdateBanner />);
  const fold = screen.getByRole("status").closest(".fold")!;
  expect(fold).toHaveAttribute("data-phase", "open");
  vi.mocked(useUpdateNotice).mockReturnValue(false);
  rerender(<UpdateBanner />);
  expect(fold).toHaveAttribute("data-phase", "shutting");
  expect(fold).toHaveAttribute("inert");
  act(() => vi.advanceTimersByTime(MOTION_CONTROL_MS));
  expect(fold).not.toBeInTheDocument();
  vi.useRealTimers();
});
