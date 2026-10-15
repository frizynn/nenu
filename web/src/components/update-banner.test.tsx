import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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
