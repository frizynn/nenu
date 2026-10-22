import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { expect, it, vi } from "vitest";

import { coordinatorMark } from "@/lib/coordinator-mark";
import type { ProjectView } from "@/lib/types";
import { server } from "@/test/setup";
import { MarkTile } from "./mark-picker";

const project: ProjectView = {
  slug: "acme", name: "Acme", status: "active",
  threads: [{ id: "t-0003", title: "Lead", parentId: "root", role: "coordinator", status: "open" }],
};

it("picks a glyph, then a colour keeping it, and puts its own back, each saved on the bridge", async () => {
  const posts: unknown[] = [];
  server.use(http.post("/api/org/node/mark", async ({ request }) => {
    posts.push(await request.json());
    return HttpResponse.json({ ok: true, mark: null });
  }));
  const onChanged = vi.fn();
  const user = userEvent.setup();
  const { rerender } = render(<MarkTile project={project} id="t-0003" name="Lead" editable onChanged={onChanged} />);
  await user.click(screen.getByRole("button", { name: "Change Lead's icon" }));
  const own = coordinatorMark(project, "t-0003");
  expect(screen.getByRole("radio", { name: own.glyph })).toHaveAttribute("aria-checked", "true");
  const other = own.glyph === "leaf" ? "moon" : "leaf";
  await user.click(screen.getByRole("radio", { name: other }));
  expect(screen.getByRole("radio", { name: other })).toHaveAttribute("aria-checked", "true");
  await user.click(screen.getByRole("radio", { name: "pink" }));
  expect(posts).toEqual([{ project: "acme", id: "t-0003", icon: other }, { project: "acme", id: "t-0003", icon: other, tone: "pink" }]);
  expect(onChanged).toHaveBeenCalledTimes(2);

  rerender(<MarkTile project={{ ...project, marks: { "t-0003": { icon: other, tone: "pink" } } }} id="t-0003" name="Lead" editable onChanged={onChanged} />);
  await user.click(screen.getByRole("button", { name: "Use its own icon" }));
  expect(posts.at(-1)).toEqual({ project: "acme", id: "t-0003" });
  expect(screen.getByRole("radio", { name: own.glyph })).toHaveAttribute("aria-checked", "true");
});

it("takes the tap back and says why when the bridge refuses", async () => {
  server.use(http.post("/api/org/node/mark", () => HttpResponse.json({ ok: false, error: "Name a coordinator this project lists." }, { status: 400 })));
  const user = userEvent.setup();
  render(<MarkTile project={project} id="t-0003" name="Lead" editable onChanged={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "Change Lead's icon" }));
  const own = coordinatorMark(project, "t-0003").glyph;
  await user.click(screen.getByRole("radio", { name: own === "leaf" ? "moon" : "leaf" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Name a coordinator this project lists.");
  expect(screen.getByRole("radio", { name: own })).toHaveAttribute("aria-checked", "true");
});

it("only draws the mark where nothing may be picked", () => {
  render(<MarkTile project={project} id="t-0003" name="Lead" editable={false} onChanged={vi.fn()} />);
  expect(screen.queryByRole("button")).toBeNull();
  expect(document.querySelector("svg[data-glyph]")).toHaveAttribute("data-glyph", coordinatorMark(project, "t-0003").glyph);
});
