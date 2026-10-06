import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { saveAgent, savePermission, rememberDir } from "@/lib/spawn";
import { NewAgentSheet } from "./new-agent-sheet";

const HOME = "/home/me";
const TREE: Record<string, string[]> = {
  [HOME]: ["code", "Documents"],
  [`${HOME}/code`]: ["api", "awam", "web"],
  [`${HOME}/code/awam`]: [],
};
const listed: string[] = [];

beforeEach(() => {
  localStorage.clear();
  listed.length = 0;
  server.use(
    http.get("/api/dirs", ({ request }) => {
      const raw = new URL(request.url).searchParams.get("path") ?? "~";
      listed.push(raw);
      const path = raw.startsWith("~") ? `${HOME}${raw.slice(1)}`.replace(/\/+$/, "") : raw.replace(/(.)\/+$/, "$1");
      const entries = TREE[path];
      return entries ? HttpResponse.json({ path, home: HOME, entries, truncated: false }) : HttpResponse.json({ error: "Directory unavailable." }, { status: 404 });
    }),
  );
});

function renderSheet(over: Partial<React.ComponentProps<typeof NewAgentSheet>> = {}) {
  const props: React.ComponentProps<typeof NewAgentSheet> = {
    open: true, onClose: vi.fn(), title: "New tab", defaultCwd: `${HOME}/code/api`, liveDirs: ["/srv/web"], readOnly: false,
    onSubmit: vi.fn(async () => null), ...over,
  };
  render(<NewAgentSheet {...props} />);
  return props;
}

const directory = () => screen.getByRole("button", { name: /^Directory/ });

describe("NewAgentSheet", () => {
  it("opens on the remembered agent and permission, with the directory shown from home", async () => {
    saveAgent("codex");
    savePermission("codex", "auto");
    renderSheet();
    expect(screen.getByRole("radio", { name: "Codex" })).toHaveAttribute("aria-checked", "true");
    expect(within(screen.getByRole("radiogroup", { name: "Permissions" })).getByRole("radio", { name: "Auto" })).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(directory()).toHaveAccessibleName("Directory: ~/code/api"));
  });

  it("submits the chosen agent, permission, directory, name and first message", async () => {
    const user = userEvent.setup();
    rememberDir("/old/project");
    const { onSubmit } = renderSheet();
    await user.click(screen.getByRole("radio", { name: "Codex" }));
    await user.click(screen.getByRole("radio", { name: "Full access" }));
    await user.click(directory());
    expect(await screen.findByRole("button", { name: "/srv/web" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "/old/project" }));
    await user.type(screen.getByLabelText("Name (optional)"), "web");
    await user.type(screen.getByLabelText("First message (optional)"), "hello");
    await user.click(screen.getByRole("button", { name: "Start Codex" }));
    expect(onSubmit).toHaveBeenCalledWith({ agent: "codex", cwd: "/old/project", name: "web", message: "hello", permission: "full" });
  });

  it("offers each CLI its own permissions and warns about the dangerous ones", async () => {
    const user = userEvent.setup();
    renderSheet();
    const group = () => within(screen.getByRole("radiogroup", { name: "Permissions" }));
    expect(group().getAllByRole("radio").map((r) => r.textContent)).toEqual(["Ask", "Accept edits", "Plan", "Bypass"]);
    expect(screen.queryByText(/Never asks/)).toBeNull();
    await user.click(group().getByRole("radio", { name: "Bypass" }));
    expect(screen.getByText(/Never asks/)).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Codex" }));
    expect(group().getAllByRole("radio").map((r) => r.textContent)).toEqual(["Ask", "Auto", "Full access"]);
    expect(group().getByRole("radio", { name: "Ask" })).toHaveAttribute("aria-checked", "true");
  });

  it("browses into a folder and uses it", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderSheet();
    await user.click(directory());
    await user.click(await screen.findByRole("button", { name: "code" }));
    await user.click(await screen.findByRole("button", { name: "awam" }));
    await screen.findByText("No folders here.");
    expect(within(screen.getByRole("navigation")).getAllByRole("button").map((b) => b.textContent)).toEqual(["Home", "code", "awam"]);
    await user.click(screen.getByRole("button", { name: "Use awam" }));
    expect(directory()).toHaveAccessibleName("Directory: ~/code/awam");
    await user.click(screen.getByRole("button", { name: "Start Claude Code" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ cwd: `${HOME}/code/awam`, permission: "ask" }));
  });

  it("filters as you type and takes the folder the filter names exactly", async () => {
    const user = userEvent.setup();
    renderSheet();
    await user.click(directory());
    const path = await screen.findByLabelText("Folder path");
    await user.clear(path);
    await user.type(path, "~/code/w");
    await waitFor(() => expect(screen.queryByRole("button", { name: "api" })).toBeNull());
    expect(screen.getByRole("button", { name: "web" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "awam" })).toBeInTheDocument(); // contains "w", after prefix matches
    await user.type(path, "eb");
    await user.click(screen.getByRole("button", { name: "Use web" }));
    expect(directory()).toHaveAccessibleName("Directory: ~/code/web");
  });

  it("keeps a typed path the bridge will not list, so desktop typing still works", async () => {
    const user = userEvent.setup();
    renderSheet();
    await user.click(directory());
    const path = await screen.findByLabelText("Folder path");
    await user.clear(path);
    await user.type(path, "/srv/data/");
    await screen.findByText(/Can't list this folder/);
    await user.keyboard("{Enter}");
    expect(directory()).toHaveAccessibleName("Directory: /srv/data");
    expect(listed).toContain("/srv/data/");
  });

  it("drops the message and permissions for a plain shell", async () => {
    const user = userEvent.setup();
    renderSheet();
    await user.click(screen.getByRole("radio", { name: "Shell" }));
    expect(screen.queryByLabelText("First message (optional)")).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: "Permissions" })).toBeNull();
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
