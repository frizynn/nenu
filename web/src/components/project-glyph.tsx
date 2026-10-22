import { coordinatorMark, type Mark } from "@/lib/coordinator-mark";
import { GLYPHS, projectMark, type MarkPick } from "@/lib/project-glyph";
import type { ProjectView } from "@/lib/types";
import { cn } from "@/lib/utils";

/** A mark's glyph in its hue's token. Decorative, since a name always sits beside it. */
export function MarkGlyph({ mark, size = 16, className }: { mark: Mark; size?: number; className?: string }) {
  const { stroke, fill, dash } = GLYPHS[mark.glyph];
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 16 16" data-glyph={mark.glyph} data-hue={mark.hue} className={cn("shrink-0", className)}
      style={{ color: `var(--glyph-${mark.hue})` }} fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
      {stroke && <path d={stroke} />}
      {dash && <path d={dash} strokeDasharray="2.1 2.1" />}
      {fill && <path d={fill} fill="currentColor" stroke="none" />}
    </svg>
  );
}

/**
 * A project's own mark, drawn from its slug (lib/project-glyph.ts): 16px beside a name in the sidebar
 * and Search, 20px at the head of the project.
 */
export function ProjectGlyph({ slug, pick, size = 16, className }: { slug: string; pick?: MarkPick; size?: number; className?: string }) {
  return <MarkGlyph mark={projectMark(slug, pick)} size={size} className={className} />;
}

/** A coordinator's mark (lib/coordinator-mark.ts), the same wherever it is named; `root` draws the project's. */
export function CoordinatorGlyph({ project, id, size = 16, className }: { project: ProjectView; id: string; size?: number; className?: string }) {
  return <MarkGlyph mark={coordinatorMark(project, id)} size={size} className={className} />;
}
