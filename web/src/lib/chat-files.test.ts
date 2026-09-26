import { chatFileReferences, filePathsInText, artifactKind } from "./chat-files";
import type { TranscriptEntry } from "./types";

describe("chat file references", () => {
  it("finds markdown, inline-code, quoted and plain local paths without turning URLs into files", () => {
    expect(filePathsInText([
      "[plan](docs/plan.md), `src/app.tsx:42`, and ./shots/home.png.",
      "Open \"docs/My Report.pdf\" and docs/README but ignore https://example.com/public.pdf.",
    ].join("\n"))).toEqual(expect.arrayContaining([
      "docs/plan.md", "src/app.tsx", "./shots/home.png", "docs/My Report.pdf", "docs/README",
    ]));
    expect(filePathsInText("https://example.com/public.pdf javascript:bad.png")).toEqual([]);
  });

  it("extracts prose and tool references, classifies photos, and deduplicates per path", () => {
    const entries: TranscriptEntry[] = [
      { uuid: "one", ts: "2026-09-21T10:00:00Z", role: "user", parts: [{ kind: "text", text: "See ./docs/../assets/hero.png" }] },
      { uuid: "two", ts: "2026-09-21T10:01:00Z", role: "assistant", parts: [
        { kind: "tool", name: "read", summary: "Read assets/hero.png", result: { text: "Saved report to output/audit.pdf" } },
        { kind: "text", text: "Photo: assets/hero.png and [audit](output/audit.pdf)" },
      ] },
    ];
    expect(chatFileReferences(entries)).toEqual([
      expect.objectContaining({ path: "assets/hero.png", name: "hero.png", kind: "photo", mentions: 2, firstSeen: expect.objectContaining({ entryId: "one" }) }),
      expect.objectContaining({ path: "output/audit.pdf", name: "audit.pdf", kind: "file", mentions: 1 }),
    ]);
  });

  it("counts a path once per journal entry even when the same message formats it twice", () => {
    const entries: TranscriptEntry[] = [{ uuid: "one", ts: "", role: "assistant", parts: [{ kind: "text", text: "`README.md` and [README](README.md)" }] }];
    expect(chatFileReferences(entries)[0]).toMatchObject({ path: "README.md", mentions: 1 });
  });
});

it("keeps file edit provenance when prose already mentioned the same path", () => {
  const references = chatFileReferences([{ uuid: "edit", ts: "", role: "assistant", parts: [
    { kind: "text", text: "Updating report.md" },
    { kind: "tool", name: "Write", summary: "report.md", result: { text: "Written" } },
  ] }]);
  expect(references).toEqual([expect.objectContaining({ path: "report.md", edited: true, mentions: 1 })]);
});

it("scans slash-heavy tool output without blocking the chat", () => {
  const output = ` ${Array(24).fill("folder").join("/")}/noextension `;
  const start = performance.now();
  expect(filePathsInText(output)).toEqual([]);
  expect(performance.now() - start).toBeLessThan(500);
  expect(filePathsInText('Saved src/one.ts\\nweb/src/two.ts\\n')).not.toContain('src/one.ts\\nweb/src/two.ts');
});

it("tracks latest mentions and separates delivered documents from edited sources and HTML", () => {
  const refs = chatFileReferences([
    { uuid: "old", ts: "2026-09-25", role: "assistant", parts: [{ kind: "text", text: "[Report](report.pdf) and [entry](index.html)" }] },
    { uuid: "edit", ts: "2026-09-26", role: "assistant", parts: [{ kind: "tool", name: "Edit", summary: "src/main.ts", result: { text: "Done" } }] },
    { uuid: "latest", ts: "2026-09-26", role: "assistant", parts: [{ kind: "text", text: "[Report](report.pdf)" }] },
  ]);
  expect(refs.filter(file => artifactKind(file, false)).map(r => r.path)).toEqual(["report.pdf"]);
  expect(refs.find(r => r.path === "report.pdf")?.lastSeen).toMatchObject({ entryId: "latest", order: 2 });
  expect(refs.find(r => r.path === "src/main.ts")?.edited).toBe(true);
});
