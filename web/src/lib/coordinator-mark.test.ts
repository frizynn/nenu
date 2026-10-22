import { describe, expect, it } from "vitest";

import type { ProjectThreadView, ProjectView } from "@/lib/types";
import { coordinatorMark, coordinatorMarks } from "./coordinator-mark";
import { GLYPH_NAMES, MARK_HUES, projectMark } from "./project-glyph";

const coordinator = (n: number, status: ProjectThreadView["status"] = "open"): ProjectThreadView =>
  ({ id: `t-${String(n).padStart(4, "0")}`, title: `Coordinator ${n}`, parentId: "root", role: "coordinator", status });
const project = (threads: ProjectThreadView[], extra: Partial<ProjectView> = {}): ProjectView =>
  ({ slug: "awam-org", name: "AWAM", status: "active", threads, ...extra });

describe("coordinatorMarks", () => {
  it("gives every open coordinator its own glyph, none the project's, in a project with as many as AWAM", () => {
    const view = project([...Array.from({ length: 20 }, (_, n) => coordinator(n + 1)), ...Array.from({ length: 12 }, (_, n) => coordinator(n + 30, "resolved"))]);
    const marks = coordinatorMarks(view);
    const open = view.threads.filter((thread) => thread.status === "open").map((thread) => marks.get(thread.id)!.glyph);
    expect(new Set([...open, marks.get("root")!.glyph]).size).toBe(21);
    expect(marks.get("root")).toEqual(projectMark("awam-org"));
    // Never red or amber unless picked, nor the dashed circle with a check: those say a state.
    for (const mark of marks.values()) if (mark !== marks.get("root")) {
      expect(MARK_HUES).toContain(mark.hue);
      expect(mark.glyph).not.toBe("orbitcheck");
    }
  });

  it("is the same on every read, and a coordinator started later moves no one", () => {
    const before = project([coordinator(1), coordinator(2), coordinator(3)]);
    const after = project([...before.threads, coordinator(4)]);
    for (const id of ["t-0001", "t-0002", "t-0003"]) {
      expect(coordinatorMark(after, id)).toEqual(coordinatorMark(before, id));
      expect(coordinatorMark(project(before.threads), id)).toEqual(coordinatorMark(before, id));
    }
  });

  it("draws a pick where Nenu knows its names, and picking never changes another coordinator's mark", () => {
    const plain = project([coordinator(1), coordinator(2)]);
    const taken = coordinatorMark(plain, "t-0002").glyph;
    const picked = project(plain.threads, { marks: { "t-0001": { icon: taken, tone: "pink" } } });
    expect(coordinatorMark(picked, "t-0001")).toEqual({ glyph: taken, hue: "pink" });
    expect(coordinatorMark(picked, "t-0002")).toEqual(coordinatorMark(plain, "t-0002"));
    const unknown = project(plain.threads, { marks: { "t-0001": { icon: "nope", tone: "nope" } } });
    expect(coordinatorMark(unknown, "t-0001")).toEqual(coordinatorMark(plain, "t-0001"));
    expect(GLYPH_NAMES).toContain(coordinatorMark(plain, "t-0099").glyph);
  });
});
