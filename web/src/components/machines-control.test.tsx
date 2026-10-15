import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import type { MachineView } from "@/lib/types";
import { server } from "@/test/setup";
import { MachinesControl } from "./machines-control";

const OFF: MachineView[] = [
  { session: "@build-box", label: "build-box", state: "off" },
  { session: "@lab", label: "lab", state: "disabled", detail: "Disabled in Herdr" },
];

describe("Settings: other machines", () => {
  it("is off until turned on, listing Herdr's machines without reaching them", async () => {
    server.use(http.get("/api/machines", () => HttpResponse.json({ on: false, machines: OFF })));
    render(<MachinesControl />);
    const toggle = await screen.findByRole("switch", { name: "Show other machines" });
    expect(toggle).not.toBeChecked();
    const list = within(screen.getByRole("list", { name: "Machines in Herdr" }));
    expect(list.getAllByRole("listitem").map((row) => row.textContent)).toEqual(["build-boxOff", "labDisabled in Herdr"]);
  });

  it("turning it on asks the bridge, which answers each machine's state", async () => {
    const posts: unknown[] = [];
    server.use(
      http.get("/api/machines", () => HttpResponse.json({ on: false, machines: OFF })),
      http.post("/api/machines", async ({ request }) => {
        posts.push(await request.json());
        return HttpResponse.json({ on: true, machines: [{ session: "@build-box", label: "build-box", state: "connecting" }, OFF[1]] });
      }),
    );
    render(<MachinesControl />);
    await userEvent.setup().click(await screen.findByRole("switch", { name: "Show other machines" }));
    expect(await screen.findByText("Connecting…")).toBeTruthy();
    expect(posts).toEqual([{ on: true }]);
    expect(screen.getByRole("switch", { name: "Show other machines" })).toBeChecked();
  });

  it("with no machine saved, says how to add one", async () => {
    server.use(http.get("/api/machines", () => HttpResponse.json({ on: false, machines: [] })));
    render(<MachinesControl />);
    expect(await screen.findByText(/herdr machine add/)).toBeTruthy();
  });

  it("a read-only device sees the setting and cannot change it", async () => {
    server.use(http.get("/api/machines", () => HttpResponse.json({ on: false, machines: OFF })));
    render(<MachinesControl readOnly />);
    expect(await screen.findByRole("switch", { name: "Show other machines" })).toBeDisabled();
  });
});
