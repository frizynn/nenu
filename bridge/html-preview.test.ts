import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderedHtmlResponse } from "./html-preview.ts";
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
