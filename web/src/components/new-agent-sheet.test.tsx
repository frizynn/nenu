import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { saveAgent, rememberDir } from "@/lib/spawn";
import { NewAgentSheet } from "./new-agent-sheet";

beforeEach(() => localStorage.clear());

function renderSheet(over: Partial<React.ComponentProps<typeof NewAgentSheet>> = {}) {
  const props: React.ComponentProps<typeof NewAgentSheet> = {
    open: true, onClose: vi.fn(), title: "New tab", defaultCwd: "/srv/api", liveDirs: ["/srv/web"], readOnly: false,
    onSubmit: vi.fn(async () => null), ...over,
  };
  render(<NewAgentSheet {...props} />);
  return props;
}

describe("NewAgentSheet", () => {
  it("opens on the remembered agent with the directory prefilled and recent dirs offered", () => {
    saveAgent("codex");
    rememberDir("/old/project");
    renderSheet();
    expect(screen.getByRole("radio", { name: "Codex" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText("Directory")).toHaveValue("/srv/api");
    expect(screen.getByRole("button", { name: "/srv/web" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "/old/project" })).toBeInTheDocument();
  });

  it("submits the chosen agent, directory, name and first message", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderSheet();
    await user.click(screen.getByRole("radio", { name: "Codex" }));
    await user.click(screen.getByRole("button", { name: "/srv/web" }));
    await user.type(screen.getByLabelText("Name (optional)"), "web");
    await user.type(screen.getByLabelText("First message (optional)"), "hello");
    await user.click(screen.getByRole("button", { name: "Start Codex" }));
    expect(onSubmit).toHaveBeenCalledWith({ agent: "codex", cwd: "/srv/web", name: "web", message: "hello" });
  });

  it("drops the message field for a plain shell", async () => {
    const user = userEvent.setup();
    renderSheet();
    await user.click(screen.getByRole("radio", { name: "Shell" }));
    expect(screen.queryByLabelText("First message (optional)")).toBeNull();
    expect(screen.getByRole("button", { name: "Open shell" })).toBeInTheDocument();
  });

  it("shows a failure inline, keeps the form, and lets you retry", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValueOnce("No such directory").mockResolvedValue(null);
    const alert = vi.spyOn(window, "alert");
    renderSheet({ onSubmit });
    await user.click(screen.getByRole("button", { name: "Start Claude Code" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No such directory");
    expect(alert).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Start Claude Code" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Start Claude Code" }));
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("cannot submit from a read-only device", () => {
    renderSheet({ readOnly: true });
    expect(screen.getByRole("button", { name: "Start Claude Code" })).toBeDisabled();
  });
});
