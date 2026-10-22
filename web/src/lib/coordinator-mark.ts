import { GLYPH_NAMES, isGlyph, isHue, projectMark, type GlyphName, type HueName, type MarkPick } from "@/lib/project-glyph";
import type { ProjectView } from "@/lib/types";

// A coordinator's mark (ADR 0122): the glyph and hue the operator picked in Nenu, else its own, drawn
// from the project's slug and its node id with the same hash a project's mark uses. Within a project
// no two open coordinators, nor the project itself, draw the same own glyph: in id order, one that
// lands on a glyph already drawn takes the next free one. The project coordinator draws the project's.

export interface Mark {
  glyph: GlyphName;
  hue: HueName;
}

/** Glyphs a coordinator never draws: a dashed circle with a check reads as the to-review state mark (ADR 0113). */
const STATE_LIKE: ReadonlySet<GlyphName> = new Set(["orbitcheck"]);
/** The glyphs a coordinator's mark is drawn or picked from. */
export const COORDINATOR_GLYPHS: readonly GlyphName[] = GLYPH_NAMES.filter((glyph) => !STATE_LIKE.has(glyph));

const marks = new WeakMap<ProjectView, Map<string, Mark>>();

const order = (id: string) => Number(id.slice(2)) || 0;

/** Every coordinator's mark in a project by node id, `root` for the project's own; read once per snapshot. */
export function coordinatorMarks(project: ProjectView): Map<string, Mark> {
  const known = marks.get(project);
  if (known) return known;
  const out = new Map<string, Mark>([["root", projectMark(project.slug, project)]]);
  const coordinators = project.threads.filter((thread) => thread.role === "coordinator").sort((a, b) => order(a.id) - order(b.id));
  const open = new Set(coordinators.filter((thread) => thread.status !== "resolved").map((thread) => thread.id));
  // Only the marks drawn before it move a coordinator off its own glyph, never a pick: picking one never
  // changes another coordinator's mark.
  const taken = new Set<GlyphName>([out.get("root")!.glyph, ...STATE_LIKE]);
  for (const { id } of coordinators) {
    const own = projectMark(`${project.slug}/${id}`);
    if (open.has(id) || STATE_LIKE.has(own.glyph)) {
      const start = GLYPH_NAMES.indexOf(own.glyph);
      own.glyph = GLYPH_NAMES.map((_, step) => GLYPH_NAMES[(start + step) % GLYPH_NAMES.length]!).find((glyph) => !taken.has(glyph)) ?? own.glyph;
      if (open.has(id)) taken.add(own.glyph);
    }
    out.set(id, picked(own, project.marks?.[id]));
  }
  marks.set(project, out);
  return out;
}

/** One coordinator's mark; a node the project does not list draws its own. */
export function coordinatorMark(project: ProjectView, id: string): Mark {
  return coordinatorMarks(project).get(id) ?? picked(projectMark(`${project.slug}/${id}`), project.marks?.[id]);
}

/** The operator's pick over a coordinator's own mark, each name only where Nenu draws it. */
function picked(own: Mark, pick: MarkPick = {}): Mark {
  return { glyph: isGlyph(pick.icon) ? pick.icon : own.glyph, hue: isHue(pick.tone) ? pick.tone : own.hue };
}
