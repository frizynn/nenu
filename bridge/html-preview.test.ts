import { afterEach, beforeEach, describe, test, expect } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { frameAncestors, inlineSiblingAssets, renderedHtmlResponse } from "./html-preview.ts";
import { openPaneFile } from "./pane-files.ts";
test("HTML executes only with a response-enforced opaque sandbox and no network", async () => {
  const root = await mkdtemp(join(tmpdir(), "nenu-html-"));
  try {
    await writeFile(
      join(root, "demo.html"),
      '<script>fetch("/api/snapshot")</script><button onclick="this.textContent=1">Test</button>',
    );
    const response = await renderedHtmlResponse(root, "demo.html");
    expect(response.status).toBe(200);
    const csp = response.headers.get("content-security-policy")!;
    for (const policy of [
      "sandbox allow-scripts",
      "connect-src 'none'",
      "form-action 'none'",
      "script-src 'unsafe-inline'",
      "frame-ancestors 'self'",
    ])
      expect(csp).toContain(policy);
    expect(csp).not.toContain("allow-same-origin");
    expect((await renderedHtmlResponse(root, "../outside.html")).status).toBe(
      404,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Render finds a delivered file outside the project exactly as /file does", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nenu-html-delivered-"));
  try {
    const root = join(dir, "project");
    const outside = join(dir, "downloads");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(outside, "report.html"), "<h1>Delivered</h1>");
    await writeFile(join(outside, "other.html"), "<h1>Not delivered</h1>");
    const delivered = async () => [join(outside, "report.html")];
    for (const path of [join(outside, "report.html"), "report.html"]) {
      const response = await renderedHtmlResponse(root, path, { delivered });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("<h1>Delivered</h1>");
    }
    expect((await renderedHtmlResponse(root, join(outside, "other.html"), { delivered })).status).toBe(404);
    expect((await renderedHtmlResponse(root, join(outside, "report.html"))).status).toBe(404);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("sibling asset inlining", () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8, 1)]);
  let dir: string;
  let root: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nenu-html-assets-"));
    root = join(dir, "project");
    await mkdir(join(root, "site", "assets"), { recursive: true });
    await writeFile(join(root, "site", "style.css"), "body{color:red}/*</style><script>x()</script>*/");
    await writeFile(join(root, "site", "app.js"), 'document.title="</script>"');
    await writeFile(join(root, "site", "assets", "nested.js"), "nested()");
    await writeFile(join(root, "site", "print.css"), "body{color:gray}");
    await writeFile(join(root, "site", "logo.png"), png);
    await writeFile(join(root, "site", "icon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    await writeFile(join(root, "top.css"), "body{color:blue}");
    await writeFile(join(root, "site", ".env.css"), "secret");
    await writeFile(join(dir, "outside.css"), "body{color:green}");
    await symlink(join(dir, "outside.css"), join(root, "site", "escape.css"));
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const page = [
    '<link rel="stylesheet" href="./style.css?v=1">',
    '<script type="module" src="app.js"></script>',
    '<script defer src="app.js"></script><script async src="app.js"></script>',
    '<script src="assets/nested.js"></script>',
    '<link rel="stylesheet" media="print" href="print.css">',
    '<link rel="alternate stylesheet" href="print.css"><link rel="stylesheet" disabled href="print.css">',
    '<img src="logo.png"><img src="icon.svg">',
    '<link rel="stylesheet" href="../top.css">',
    '<link rel="stylesheet" href="/top.css">',
    '<link rel="stylesheet" href="https://example.com/x.css">',
    '<link rel="stylesheet" href=".env.css">',
    '<link rel="stylesheet" href="escape.css">',
    '<link rel="icon" href="logo.png">',
  ].join("\n");

  test("inlines contained same-directory assets and leaves every other reference as written", async () => {
    await writeFile(join(root, "site", "index.html"), page);
    const response = await renderedHtmlResponse(root, "site/index.html", { inlineAssets: true });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text();
    expect(html).toContain("<style>body{color:red}/*<\\/style><script>x()</script>*/</style>");
    expect(html).toContain('<script type="module">document.title="<\\/script>"</script>');
    expect(html).toContain('<style media="print">body{color:gray}</style>');
    expect(html).toContain(`<img src="data:image/png;base64,${png.toString("base64")}">`);
    expect(html).toContain('<img src="data:image/svg+xml;base64,');
    for (const kept of ['href="../top.css"', 'href="/top.css"', 'href="https://example.com/x.css"',
      'href=".env.css"', 'href="escape.css"', '<link rel="icon" href="logo.png">',
      '<script defer src="app.js"></script>', '<script async src="app.js"></script>',
      '<script src="assets/nested.js"></script>', '<link rel="alternate stylesheet" href="print.css">',
      '<link rel="stylesheet" disabled href="print.css">'])
      expect(html).toContain(kept);
    expect(html).not.toContain("secret");
    expect(html).not.toContain("color:green");
    expect(html).not.toContain("color:blue");
  });

  test("stops inlining at the byte budget and is off unless asked for", async () => {
    await writeFile(join(root, "site", "index.html"), page);
    const off = await (await renderedHtmlResponse(root, "site/index.html")).text();
    expect(off).toBe(page);
    const source = '<link rel="stylesheet" href="style.css"><img src="logo.png">';
    const open = (path: string) => openPaneFile(root, path);
    const tight = await inlineSiblingAssets(source, join(await realpath(root), "site"), open, png.length);
    expect(tight).toContain('href="style.css"');
    expect(tight).toContain("data:image/png;base64,");
  });
});

test("the preview may be framed by Nenu's own host, not just the sandbox's opaque 'self'", () => {
  expect(frameAncestors("macbook.tail.ts.net")).toBe("'self' https://macbook.tail.ts.net http://macbook.tail.ts.net");
  expect(frameAncestors("127.0.0.1:8787")).toBe("'self' https://127.0.0.1:8787 http://127.0.0.1:8787");
  expect(frameAncestors(undefined)).toBe("'self'");
  expect(frameAncestors("evil.com; script-src *")).toBe("'self'");
});
