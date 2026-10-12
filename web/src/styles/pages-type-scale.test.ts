import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { declarations } from "@/test/css-rules";

// The project pages, the activity views, the thread cards, the PR bar and the smaller blocks around
// the chat take their text sizes from the scale (index.css), not from a hand-written px size: a px
// size ignores the browser's text size, and a half pixel is a step the scale doesn't have. The
// project pages also draw none of Tailwind's stock sizes (text-sm is 14px, which the scale has no
// step for), so Project and Node read on the phone's steps. type-scale.test.ts holds the navigation,
// the shell, the composer and the strips; jsdom lays nothing out, the bench measures the rendered
// sizes (redesign-shots/polish-pages).

const src = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(src, path), "utf8");

const PROJECT_PAGES = [
  "components/project-coordinator.tsx",
  "components/project-missing.tsx",
  "components/project-tasks.tsx",
  "routes/project.tsx",
  "routes/node.tsx",
];
const COMPONENTS = [
  ...PROJECT_PAGES,
  "components/threads-panel.tsx",
  "components/start-agent.tsx",
  "components/connect-conversation.tsx",
  "components/activity/activity-panel.tsx",
  "components/activity/activity-parts.tsx",
  "components/activity/artifact-list.tsx",
  "components/activity/processes.tsx",
  "components/activity/task-output.tsx",
  "components/activity/workflow-detail.tsx",
  "components/thread-cards.tsx",
  "components/pr-bar.tsx",
  "components/skill-picker.tsx",
  "components/native-model-menu.tsx",
  "components/autocomplete-block.tsx",
  "components/transcript-question.tsx",
  "components/terminal-draft-preview.tsx",
  "components/workbench-shell.tsx",
  "components/file-preview.tsx",
  "components/image-viewer.tsx",
];

describe("text sizes on the project pages, the activity views and the blocks around the chat", () => {
  it("draws no arbitrary px text size", () => {
    const offenders = COMPONENTS.flatMap((file) => [...read(file).matchAll(/\btext-\[[\d.]+px\]/g)].map((m) => `${file}: ${m[0]}`));
    expect(offenders).toEqual([]);
  });

  it("draws none of Tailwind's stock text sizes on the project pages", () => {
    const offenders = PROJECT_PAGES.flatMap((file) => [...read(file).matchAll(/\btext-(?:xs|sm|base|lg|[2-9]?xl)\b/g)].map((m) => `${file}: ${m[0]}`));
    expect(offenders).toEqual([]);
  });

  it("sets the navigation footer's host line in the footnote step on a touch screen, not the 12px caption", () => {
    const touch = ["@media (max-width: 1023px), (pointer: coarse)"];
    expect(declarations(read("styles/nav.css"), ".nav-host-meta", touch)["font-size"]).toBe("var(--text-footnote)");
  });
});
