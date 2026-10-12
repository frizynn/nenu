import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { declarations } from "@/test/css-rules";

// The project pages, the activity views, the thread cards, the PR bar and the smaller blocks around
// the chat draw no hand-written px text size: a px size ignores the browser's text size, and a half
// pixel is a step the scale (index.css) doesn't have. The files in ON_SCALE also draw none of
// Tailwind's stock sizes (text-sm is 14px, which the scale has no step for): the project pages with
// the rows they share (node-row.tsx), so Project and Node read on the phone's steps, and the blocks
// whose every size is a scale step. The rest of COMPONENTS (the activity list, processes and workflow
// detail, the pickers, the menus, the file preview) still carry stock sizes and are held to the px
// rule only. type-scale.test.ts holds the navigation, the shell, the composer and the strips; jsdom
// lays nothing out, the bench measures the rendered sizes (redesign-shots/polish-pages).

const src = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(src, path), "utf8");

const ON_SCALE = [
  "components/project-coordinator.tsx",
  "components/project-missing.tsx",
  "components/project-tasks.tsx",
  "components/node-row.tsx",
  "routes/project.tsx",
  "routes/node.tsx",
  "components/start-agent.tsx",
  "components/connect-conversation.tsx",
  "components/thread-cards.tsx",
  "components/pr-bar.tsx",
  "components/activity/task-output.tsx",
  "components/autocomplete-block.tsx",
  "components/terminal-draft-preview.tsx",
  "components/agents-footer.tsx",
  "components/workbench-shell.tsx",
  "components/image-viewer.tsx",
];
const COMPONENTS = [
  ...ON_SCALE,
  "components/threads-panel.tsx",
  "components/activity/activity-panel.tsx",
  "components/activity/activity-parts.tsx",
  "components/activity/artifact-list.tsx",
  "components/activity/processes.tsx",
  "components/activity/workflow-detail.tsx",
  "components/skill-picker.tsx",
  "components/native-model-menu.tsx",
  "components/transcript-question.tsx",
  "components/file-preview.tsx",
];

describe("text sizes on the project pages, the activity views and the blocks around the chat", () => {
  it("draws no arbitrary px text size", () => {
    const offenders = COMPONENTS.flatMap((file) => [...read(file).matchAll(/\btext-\[[\d.]+px\]/g)].map((m) => `${file}: ${m[0]}`));
    expect(offenders).toEqual([]);
  });

  it("draws none of Tailwind's stock text sizes on the project pages, their rows and the blocks fully on the scale", () => {
    const offenders = ON_SCALE.flatMap((file) => [...read(file).matchAll(/\btext-(?:xs|sm|base|lg|[2-9]?xl)\b/g)].map((m) => `${file}: ${m[0]}`));
    expect(offenders).toEqual([]);
  });

  it("sets the navigation footer's host line in the footnote step on a touch screen, not the 12px caption", () => {
    const touch = ["@media (max-width: 1023px), (pointer: coarse)"];
    expect(declarations(read("styles/nav.css"), ".nav-host-meta", touch)["font-size"]).toBe("var(--text-footnote)");
  });
});
