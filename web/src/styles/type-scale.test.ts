import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { cssRules, declarations } from "@/test/css-rules";

// Text sizes in the navigation, the shell's chrome, the composer, the project pages and the strips.
// Their stylesheets and these components draw no fixed px size: it ignores the browser's text size,
// and a half pixel is a step the scale doesn't have. The components that are fully on the scale also
// draw none of Tailwind's stock sizes (text-sm is 14px, which the scale has no step for). The files
// sheet and the two pages whose comments name text-sm are held to the px rule only. No
// label anywhere is set in tracked capitals: the app's labels are sentence case.
// jsdom lays nothing out; the bench measures the rendered sizes (redesign-shots/labels-type-reach,
// redesign-shots/glue-cleanup).

const src = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(src, path), "utf8");
const filesEndingIn = (dir: string, ext: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name);
  if (entry.isDirectory()) return filesEndingIn(path, ext);
  return entry.name.endsWith(ext) && !entry.name.includes(".test.") ? [path] : [];
});

const STYLESHEETS = ["styles/nav.css", "styles/shell.css", "styles/composer.css", "styles/project.css", "styles/strips.css"];
const ON_SCALE = [
  "components/ui/section-label.tsx",
  "components/attachment-chips.tsx",
  "components/workspace-tree.tsx",
  "components/workbench-sidebar.tsx",
  "components/bottom-tab-bar.tsx",
  "components/option-button.tsx",
  "components/session-switcher.tsx",
  "components/question-card.tsx",
  "components/queued-message.tsx",
  "components/message-queue-strip.tsx",
  "components/message-images.tsx",
  "components/pane-gone.tsx",
  "components/composer.tsx",
  "components/conversation-actions.tsx",
  "components/command-palette.tsx",
  "components/ui/workbench-popover.tsx",
  "components/ui/panel-header.tsx",
  "components/workbench-model-panel.tsx",
  "components/local-model-picker.tsx",
  "components/workbench-telemetry.tsx",
  "components/agent-chat.tsx",
  "components/home-panels.tsx",
];
const COMPONENTS = [...ON_SCALE, "components/chat-files-browser.tsx", "routes/not-found.tsx", "routes/history.tsx"];

describe("text sizes and labels in the navigation, the shell, the composer, the project pages and the strips", () => {
  it("takes every font size in their stylesheets from the scale", () => {
    const offenders = STYLESHEETS.flatMap((file) =>
      cssRules(read(file))
        .filter((rule) => rule.decls["font-size"] && !/^(var\(--text-[a-z-]+\)|inherit)$/.test(rule.decls["font-size"]))
        .map((rule) => `${file}: ${rule.selectors.join(", ")} { font-size: ${rule.decls["font-size"]} }`),
    );
    expect(offenders).toEqual([]);
  });

  it("draws no arbitrary px text size in their components", () => {
    const offenders = COMPONENTS.flatMap((file) => [...read(file).matchAll(/\btext-\[[\d.]+px\]/g)].map((m) => `${file}: ${m[0]}`));
    expect(offenders).toEqual([]);
  });

  it("draws none of Tailwind's stock text sizes in the components already on the scale", () => {
    const offenders = ON_SCALE.flatMap((file) => [...read(file).matchAll(/\btext-(?:xs|sm|base|lg|[2-9]?xl)\b/g)].map((m) => `${file}: ${m[0]}`));
    expect(offenders).toEqual([]);
  });

  it("sets the tab bar's badge in the micro step, the one the direction keeps for badges", () => {
    expect(declarations(read("styles/shell.css"), ".bottom-tab-badge", ["@layer components"])["font-size"]).toBe("var(--text-micro)");
  });

  it("sets no label in tracked capitals, in a component or a stylesheet", () => {
    const tsx = filesEndingIn(src, ".tsx").flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/"([^"\n]*)"|`([^`]*)`/g)]
        .map((m) => m[1] ?? m[2]!)
        .filter((classes) => /\buppercase\b/.test(classes) && /\btracking-/.test(classes))
        .map((classes) => `${relative(src, file)}: ${classes}`),
    );
    const css = filesEndingIn(src, ".css").flatMap((file) =>
      cssRules(readFileSync(file, "utf8")).filter((rule) => rule.decls["text-transform"] === "uppercase").map((rule) => `${relative(src, file)}: ${rule.selectors.join(", ")}`),
    );
    expect([...tsx, ...css]).toEqual([]);
  });
});
