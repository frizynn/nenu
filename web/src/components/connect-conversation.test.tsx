import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { connectConversation, fetchConversations } from "@/lib/api";
import { ConnectConversation, RecoveryLeads } from "./connect-conversation";

vi.mock("@/lib/api", () => ({ fetchConversations: vi.fn(), connectConversation: vi.fn() }));
vi.mock("react-router", async (original) => ({ ...await original<typeof import("react-router")>(), useRevalidator: () => ({ revalidate: async () => {}, state: "idle" }) }));
beforeEach(() => {
  vi.mocked(fetchConversations).mockReset();
  vi.mocked(connectConversation).mockReset().mockResolvedValue({ ok: true });
});

const ID = "11111111-2222-3333-4444-555555555555";

// T18: the empty Codex pane stacked a second explanation, a bare ID field and a dim Connect button
// under the composer. One way forward shows; the ID waits behind its own disclosure.
describe("ConnectConversation", () => {
  it("keeps the session ID behind a disclosure and connects the typed one", async () => {
    const user = userEvent.setup();
    const connected = vi.fn();
    render(<ConnectConversation paneId="w2:codex" session="work" disabled={false} onConnected={connected} />);
    expect(screen.getByRole("button", { name: "Find Codex conversations" })).toBeEnabled();
    expect(screen.queryByRole("textbox", { name: "Session ID" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect history" })).not.toBeInTheDocument();

    const disclosure = screen.getByRole("button", { name: "Enter a session ID" });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await user.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Connect history" })).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: "Session ID" }), ` ${ID} `);
    await user.click(screen.getByRole("button", { name: "Connect history" }));

    expect(connectConversation).toHaveBeenCalledWith("w2:codex", ID, "work");
    await waitFor(() => expect(connected).toHaveBeenCalledOnce());
  });

  it("leads with Find as the large action every empty state offers, and commits with a full-width Connect", async () => {
    const user = userEvent.setup();
    render(<RecoveryLeads.Provider value><ConnectConversation paneId="w2:codex" disabled={false} onConnected={vi.fn()} /></RecoveryLeads.Provider>);
    const find = screen.getByRole("button", { name: "Find Codex conversations" });
    expect(find).toHaveClass("ui-button-lg", "bg-foreground", "text-base");
    expect(find).not.toHaveClass("w-full");
    await user.click(screen.getByRole("button", { name: "Enter a session ID" }));
    // The block tier: a card's one commit, full width, the option rows' radius and type.
    expect(screen.getByRole("button", { name: "Connect history" })).toHaveClass("w-full", "rounded-lg", "text-body");
  });

  it("lists the conversations running here and connects the chosen one", async () => {
    const user = userEvent.setup();
    vi.mocked(fetchConversations).mockResolvedValue({ conversations: [{ id: ID, title: "My terminal session" }] });
    render(<ConnectConversation paneId="w2:codex" disabled={false} onConnected={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Find Codex conversations" }));
    await user.selectOptions(await screen.findByLabelText("Conversation to connect"), ID);
    await user.click(screen.getByRole("button", { name: "Connect history" }));
    expect(connectConversation).toHaveBeenCalledWith("w2:codex", ID, undefined);
  });

  // The one the operator wants may have started after the first search (opened a moment ago in the
  // terminal): a loaded list still offers to look again.
  it("searches again from a loaded list", async () => {
    const user = userEvent.setup();
    const LATER = "99999999-8888-7777-6666-555555555555";
    vi.mocked(fetchConversations)
      .mockResolvedValueOnce({ conversations: [{ id: ID, title: "My terminal session" }] })
      .mockResolvedValueOnce({ conversations: [{ id: ID, title: "My terminal session" }, { id: LATER, title: "Opened just now" }] });
    render(<ConnectConversation paneId="w2:codex" disabled={false} onConnected={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Find Codex conversations" }));
    await screen.findByLabelText("Conversation to connect");

    await user.click(screen.getByRole("button", { name: "Search again" }));

    expect(await screen.findByRole("option", { name: /Opened just now/ })).toBeInTheDocument();
    expect(fetchConversations).toHaveBeenCalledTimes(2);
    await user.selectOptions(screen.getByLabelText("Conversation to connect"), LATER);
    await user.click(screen.getByRole("button", { name: "Connect history" }));
    expect(connectConversation).toHaveBeenCalledWith("w2:codex", LATER, undefined);
  });

  // On a phone, opening the disclosure should bring the keyboard up for the ID, not ask for a second tap.
  it("moves focus to the session ID when its disclosure opens", async () => {
    const user = userEvent.setup();
    render(<ConnectConversation paneId="w2:codex" disabled={false} onConnected={() => {}} />);
    const disclosure = screen.getByRole("button", { name: "Enter a session ID" });
    expect(document.getElementById(disclosure.getAttribute("aria-controls")!)).not.toBeNull();
    await user.click(disclosure);
    expect(screen.getByRole("textbox", { name: "Session ID" })).toHaveFocus();
  });

  // Both buttons wait while either action runs; only the one that runs says it is busy.
  it("says busy only on the button whose action runs", async () => {
    const user = userEvent.setup();
    vi.mocked(connectConversation).mockReturnValue(new Promise(() => {}));
    render(<ConnectConversation paneId="w2:codex" disabled={false} onConnected={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Enter a session ID" }));
    await user.type(screen.getByRole("textbox", { name: "Session ID" }), ID);
    await user.click(screen.getByRole("button", { name: "Connect history" }));

    expect(screen.getByRole("button", { name: "Connect history" })).toHaveAttribute("aria-busy", "true");
    const find = screen.getByRole("button", { name: "Find Codex conversations" });
    expect(find).toBeDisabled();
    expect(find).not.toHaveAttribute("aria-busy");
  });

  it("says when no conversation runs here instead of an empty list", async () => {
    const user = userEvent.setup();
    vi.mocked(fetchConversations).mockResolvedValue({ conversations: [] });
    render(<ConnectConversation paneId="w2:codex" disabled={false} onConnected={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Find Codex conversations" }));
    expect(await screen.findByText("No Codex conversation is running in this folder.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Conversation to connect")).not.toBeInTheDocument();
  });
});
