import type { ArtifactMetadata } from "./api";
import { artifactSections, chatFileReferences, filePathsInText, artifactKind, markdownImagePaths } from "./chat-files";
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

  it("finds no file inside a web URL, after its port or in its query", () => {
    // The phone showed this link as a "resumen-del-dia.html · 8443/ · Not found" card.
    expect(filePathsInText("Resumen al día: https://rise-l.taild6bfcf.ts.net:8443/resumen-del-dia.html")).toEqual([]);
    expect(filePathsInText("https://ci.example.com/view?file=docs/report.pdf;mode=raw,next=out/log.txt")).toEqual([]);
    expect(filePathsInText("(http://localhost:5173/README)")).toEqual([]);
    // The prose around the URL still names its files.
    expect(filePathsInText("Ver https://example.com:8443/a.html y docs/plan.md")).toEqual(["docs/plan.md"]);
  });

  it("reads a file:// link by its target and never offers its label as a second, relative file", () => {
    // The shape that 404'd on the phone: the label resolved against the pane's folder.
    const target = "/Users/demo/Obsidian/acme/Research/artifacts/board-20261009/board-summary.html";
    expect(filePathsInText(`El tablero: [board-summary.html](file://${target}). Faltan capturas.`)).toEqual([target]);
    expect(filePathsInText("[`guide.md`](docs/guide.md)")).toEqual(["docs/guide.md"]);
    // A remote link keeps its label as a mention, as before.
    expect(filePathsInText("[docs/a.md](https://example.com/a)")).toEqual(["docs/a.md"]);
  });

  it("reads a bare file:// URL in prose as the absolute path it names", () => {
    const target = "/Users/demo/.herdr-projects/acme/library/t-0093/wholesale-orders-20261013.html";
    expect(filePathsInText(`Ya está abierto desde las 17:50:\nfile://${target}\n\nQué tiene:`)).toEqual([target]);
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

describe("journal media in file references", () => {
  it("skips image markers and counts SendUserFile deliveries as delivered", () => {
    const entries = [
      { uuid: "a", ts: "2026-10-10T10:00:00Z", role: "user", parts: [{ kind: "image", index: 0 }] },
      { uuid: "b", ts: "2026-10-10T10:01:00Z", role: "assistant", parts: [
        { kind: "tool", name: "SendUserFile", summary: "", result: { text: "sent", attachments: [{ kind: "file", path: "/tmp/out/report.html" }] } },
      ] },
    ] as unknown as TranscriptEntry[];
    const [report] = chatFileReferences(entries);
    expect(report).toMatchObject({ path: "/tmp/out/report.html", delivered: true });
    expect(markdownImagePaths("![a](x.png) and [b](y.png)")).toEqual(["x.png"]);
  });
});

describe("artifactSections", () => {
  const said = (uuid: string, role: "user" | "assistant", text: string) => ({ uuid, ts: "2026-10-14T14:00:00Z", role, parts: [{ kind: "text" as const, text }] });
  const refs = chatFileReferences([
    said("u", "user", "Use /srv/uploads/mine.png"),
    said("a", "assistant", [
      "![After](shots/after.png) [notes](docs/notes.pdf) [board](design/board.html)",
      "I read /srv/vault/one.png and /srv/vault/two.png, and `shots/named.png` is in the folder.",
      "[gone](shots/gone.png)",
    ].join(" ")),
  ]);
  const found = new Map<string, ArtifactMetadata>([
    ["shots/after.png", { path: "shots/after.png", state: "preview" }],
    ["/srv/vault/one.png", { path: "/srv/vault/one.png", state: "outside" }],
    ["/srv/vault/two.png", { path: "/srv/vault/two.png", state: "outside" }],
    ["/srv/uploads/mine.png", { path: "/srv/uploads/mine.png", state: "outside" }],
    ["shots/named.png", { path: "shots/named.png", state: "preview" }],
    ["shots/gone.png", { path: "shots/gone.png", state: "missing" }],
    ["design/board.html", { path: "design/board.html", state: "preview", designboard: "Checkout" }],
  ]);

  it("shows an image only when the agent delivered it and the bridge can serve it", () => {
    const { images } = artifactSections(refs, found);
    expect(images.map(r => r.path)).toEqual(["shots/after.png"]);
  });

  it("gathers the images the agent named beyond the pane's folder, never the operator's own", () => {
    expect(artifactSections(refs, found).outside.map(r => r.path)).toEqual(["/srv/vault/one.png", "/srv/vault/two.png"]);
  });

  it("lists delivered documents and designboards, and nothing it has not checked yet", () => {
    expect(artifactSections(refs, found).delivered.map(r => r.path).sort()).toEqual(["design/board.html", "docs/notes.pdf"]);
    expect(artifactSections(refs, new Map())).toMatchObject({ images: [], outside: [] });
  });
});
