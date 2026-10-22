# 0122. A coordinator has its own mark, and the operator's pick of it is kept by Nenu

- **Status:** Accepted (2026-10-22). Requested by the operator; the shape and the storage were
  delegated. Amends [ADR 0092](./0092-a-project-organizes-its-coordinators.md) (a coordinator's row on
  its project) in how the rows are drawn; what a tap does (ADR 0115) holds.
- **Trail:** `web/src/lib/coordinator-mark.ts` · `web/src/components/mark-picker.tsx` ·
  `web/src/components/desk-pages.tsx` (`CoordinatorWorkCard`) · `bridge/coordinator-marks.ts` ·
  `bridge/projects.ts` (`setMark`) · `POST /api/org/node/mark` · `scripts/e2e/coordinator-marks.ts`

## Context

A project's Work tab drew each open coordinator as a box of its own, all with the same grey workflow
glyph. On the operator's largest project (12 open coordinators, 2026-10-22) that read as a column of
identical boxes: "esto tiene que tener otra vista, tiene que ser más estético y cada coordinador con
un ícono propio y que pueda personalizarlo si quiero". The pick has to look the same on the phone and
the desk.

Organizations lets a project pick its glyph and colour (`set <slug> icon|tone`, drawn by
`lib/project-glyph.ts`) but has no such field for a node: `node set` only takes `--task-scope`, and `node show --json`
carries none.

| Where a pick lives | Same on every device | Works today | Who owns the contract |
| --- | --- | --- | --- |
| The browser (`localStorage`) | no | yes | Nenu |
| Nenu's state dir, served in the snapshot | yes | yes | Nenu |
| A node field in Organizations | yes | no: the field does not exist | Organizations |

## Decision

1. **A coordinator draws its own mark everywhere it is named**: the project's Work list, the desk's
   bar, the tree in Search and a phone's drawer, its chat's header, its panel and its group in Waiting
   on you. The project's coordinator draws the project's mark. Where a row also says its state, the
   coordinator's mark leads and the state glyph follows its name (amends ADR 0113 for those rows).
2. **Its own mark comes from the project's slug and its node id**, through the hash a project's mark
   uses (`lib/project-glyph.ts`), never from load order or chance. Within a project no two open
   coordinators, nor the project, draw the same own glyph: in id order, one landing on a glyph already
   drawn takes the next free one (23 glyphs: past 22 open coordinators some repeat). A pick never moves
   another coordinator's mark, and a coordinator started later moves none. Red and amber, and the dashed
   circle with a check, are never offered or drawn by default: they say a state. The project's
   coordinator is the exception: it draws the project's mark as the project does, whatever its glyph. The picker shows which
   glyphs another coordinator already draws, dimmed but still pickable.
3. **The pick is kept by the bridge**, in `<stateDir>/coordinator-marks.json`, names only (`icon`,
   `tone`), for a coordinator the project lists (a deleted one's pick stays on disk, out of the
   snapshot), and comes to every browser as the project's `marks`
   in the snapshot; the write tells every session's browsers (`org` event). Never `localStorage`.
4. **The Work list is one list, a row per coordinator**, a coordinator under another one step in: its
   mark (the picker's button where the device may write), its name and what it holds, and on a desk
   what is live as three aligned columns (waits on you, to review, working) and when it last moved; on
   a phone what is live is the line under its name, which may take two lines.

## Consequences

- When Organizations gains a node mark (asked of herdr-org), Nenu should read it and drop its own
  store, carrying the picks over once; until then a pick lives only on the machine whose Nenu kept it.
- An own glyph can change when an earlier open coordinator that held the same hash is resolved, which
  frees its glyph. A pick does not change.
- `bun scripts/e2e/coordinator-marks.ts` fails when two open coordinators share a glyph, a row runs
  past a phone's edge, or a pick made on the desk is missing after a reload from the list, the bar, the
  chat's header, its panel or a phone.
