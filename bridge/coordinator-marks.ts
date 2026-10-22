import { NODE_ID_RE, pickName, SLUG_RE } from "./org-cli.ts";
import { PrefsFile } from "./prefs-file.ts";

// The glyph and colour the operator picked for a coordinator, kept by Nenu in its state dir because
// Organizations has no field for a node's mark (ADR 0122). One file for every device, so a pick made
// on the phone draws the same on the desk. Only the names are kept: the web knows the glyphs, and a
// name it does not know draws the coordinator's own mark.

/** A coordinator's pick: either name may be absent, and then its own mark's part draws. */
export interface MarkPick {
  icon?: string;
  tone?: string;
}

/** Picks by project slug, then by coordinator node id. */
export type MarkPicks = Record<string, Record<string, MarkPick>>;

/** Keeps only well-formed slugs, node ids and names, so a hand-edited file can never reach the snapshot malformed. */
export function coerceMarkPicks(raw: unknown): MarkPicks {
  const out: MarkPicks = {};
  if (!isRecord(raw)) return out;
  for (const [slug, nodes] of Object.entries(raw)) {
    if (!SLUG_RE.test(slug) || !isRecord(nodes)) continue;
    for (const [id, pick] of Object.entries(nodes)) {
      if (!NODE_ID_RE.test(id) || !isRecord(pick)) continue;
      const kept = clean(pick);
      if (kept) (out[slug] ??= {})[id] = kept;
    }
  }
  return out;
}

/** A pick's well-formed names, or undefined when none is left. */
function clean(pick: Record<string, unknown>): MarkPick | undefined {
  const icon = pickName(pick.icon);
  const tone = pickName(pick.tone);
  return icon || tone ? { ...(icon ? { icon } : {}), ...(tone ? { tone } : {}) } : undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export class CoordinatorMarks {
  private readonly file: PrefsFile<MarkPicks>;

  constructor(path: string) {
    this.file = new PrefsFile(path, coerceMarkPicks);
    this.file.loadSync();
  }

  /** A project's picks, by node id; empty when it has none. */
  of(slug: string): Record<string, MarkPick> {
    return this.file.current()[slug] ?? {};
  }

  /** Saves a coordinator's pick; a pick with no name left clears it, so its own mark draws again. */
  async set(slug: string, id: string, pick: Record<string, unknown>): Promise<MarkPick | undefined> {
    const next = this.file.current();
    const nodes = { ...next[slug] };
    const kept = clean(pick);
    if (kept) nodes[id] = kept;
    else delete nodes[id];
    if (Object.keys(nodes).length > 0) next[slug] = nodes;
    else delete next[slug];
    await this.file.set(next);
    return kept;
  }
}
