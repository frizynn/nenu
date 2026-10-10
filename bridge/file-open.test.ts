import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HTML_PREVIEW_CSP } from "../web/src/lib/html-preview.ts";
import { checkOpenable, EXPIRED_MESSAGE, FileGrants, GRANT_TTL_MS, grantedFileResponse, MAX_OPEN_FILE_BYTES } from "./file-open.ts";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

describe("file open grants", () => {
  let dir: string;
  let state: string;
  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "nenu-file-open-")));
    state = join(dir, "state");
    await mkdir(state);
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test("validates an absolute, existing, regular, public file under the cap", async () => {
    await writeFile(join(dir, "board.html"), "<h1>hi</h1>");
    expect(await checkOpenable(join(dir, "board.html"), state)).toEqual({ path: join(dir, "board.html"), name: "board.html", size: 11, type: "text/html" });
    expect(await checkOpenable("board.html", state)).toMatchObject({ status: 400 });
    expect(await checkOpenable(42, state)).toMatchObject({ status: 400 });
    expect(await checkOpenable(join(dir, "missing.html"), state)).toMatchObject({ status: 404 });
    expect(await checkOpenable(dir, state)).toMatchObject({ status: 404 });
  });

  test("refuses private paths by name, by symlink target, and Nenu's own state", async () => {
    await mkdir(join(dir, ".ssh"));
    await writeFile(join(dir, ".ssh", "config"), "Host *");
    await writeFile(join(dir, ".env"), "TOKEN=1");
    await writeFile(join(dir, "server.pem"), "key");
    await writeFile(join(state, "audit.log"), "{}");
    await symlink(join(dir, ".ssh", "config"), join(dir, "innocent.txt"));
    await mkdir(join(dir, "Library", "Keychains"), { recursive: true });
    await writeFile(join(dir, "Library", "Keychains", "login.keychain-db"), "k");
    await mkdir(join(dir, "Library", "Application Support", "Google", "Chrome", "Default"), { recursive: true });
    await writeFile(join(dir, "Library", "Application Support", "Google", "Chrome", "Default", "Cookies.txt"), "c");
    for (const path of [join(dir, ".ssh", "config"), join(dir, ".env"), join(dir, "server.pem"), join(dir, "innocent.txt"), join(state, "audit.log"),
      join(dir, "Library", "Keychains", "login.keychain-db"), join(dir, "Library", "Application Support", "Google", "Chrome", "Default", "Cookies.txt")])
      expect(await checkOpenable(path, state)).toMatchObject({ status: 403 });
  });

  test("refuses a file over the cap", async () => {
    await writeFile(join(dir, "big.bin"), "");
    await truncate(join(dir, "big.bin"), MAX_OPEN_FILE_BYTES + 1);
    expect(await checkOpenable(join(dir, "big.bin"), state)).toMatchObject({ status: 413 });
  });

  test("a token is single-use, expires, and only works for the device that asked", () => {
    let now = 1_000;
    let n = 0;
    const grants = new FileGrants(() => now, () => `t${++n}`);
    const first = grants.issue("/a", "phone");
    expect(grants.consume(first, "phone")).toBe("/a");
    expect(grants.consume(first, "phone")).toBeNull();
    const second = grants.issue("/b", "phone");
    expect(grants.consume(second, "tablet")).toBeNull();
    expect(grants.consume(second, "phone")).toBeNull();
    const third = grants.issue("/c", null);
    now += GRANT_TTL_MS;
    expect(grants.consume(third, null)).toBeNull();
    expect(grants.consume(null, null)).toBeNull();
    expect(grants.consume("forged", null)).toBeNull();
  });

  test("outstanding tokens are bounded, oldest dropped first", () => {
    let n = 0;
    const grants = new FileGrants(() => 0, () => `t${++n}`);
    const tokens = Array.from({ length: 65 }, (_, i) => grants.issue(`/f${i}`, null));
    expect(grants.consume(tokens[0]!, null)).toBeNull();
    expect(grants.consume(tokens[64]!, null)).toBe("/f64");
  });

  test("HTML and SVG open in an opaque, no-network sandbox", async () => {
    for (const [name, type] of [["board.html", "text/html; charset=utf-8"], ["logo.svg", "image/svg+xml"]] as const) {
      await writeFile(join(dir, name), "<svg></svg>");
      const response = await grantedFileResponse(join(dir, name), state);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(type);
      expect(response.headers.get("content-security-policy")).toBe(`${HTML_PREVIEW_CSP}; frame-ancestors 'none'; sandbox allow-scripts`);
      expect(response.headers.get("content-disposition")).toStartWith("inline;");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(await response.text()).toBe("<svg></svg>");
    }
  });

  test("text stays text, images and PDFs must match their bytes, anything else downloads", async () => {
    await writeFile(join(dir, "notes.md"), "# hi");
    await writeFile(join(dir, "shot.png"), PNG);
    await writeFile(join(dir, "fake.png"), "<script>alert(1)</script>");
    await writeFile(join(dir, "doc.pdf"), "%PDF-1.7\n");
    await writeFile(join(dir, "archive.zip"), "PK");
    const cases = [
      ["notes.md", "text/plain; charset=utf-8", "inline"],
      ["shot.png", "image/png", "inline"],
      ["fake.png", "application/octet-stream", "attachment"],
      ["doc.pdf", "application/pdf", "inline"],
      ["archive.zip", "application/octet-stream", "attachment"],
    ] as const;
    for (const [name, type, disposition] of cases) {
      const response = await grantedFileResponse(join(dir, name), state);
      expect(response.headers.get("content-type")).toBe(type);
      expect(response.headers.get("content-disposition")).toStartWith(`${disposition};`);
      expect(response.headers.get("content-security-policy") ?? "").not.toContain("allow-scripts");
      if (name !== "doc.pdf") expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox; frame-ancestors 'none'");
      await response.arrayBuffer();
    }
  });

  test("opening re-checks the file: spent link, swapped symlink, private target, removed file", async () => {
    expect(await grantedFileResponse(null, state).then(async (r) => [r.status, await r.text()])).toEqual([410, EXPIRED_MESSAGE]);
    await writeFile(join(dir, "other.html"), "other");
    await writeFile(join(dir, ".env"), "TOKEN=1");
    // A grant stores the resolved name; a symlink put at that name later is not what was confirmed.
    await symlink(join(dir, "other.html"), join(dir, "granted.html"));
    expect((await grantedFileResponse(join(dir, "granted.html"), state)).status).toBe(404);
    await rm(join(dir, "granted.html"));
    await symlink(join(dir, ".env"), join(dir, "granted.html"));
    expect((await grantedFileResponse(join(dir, "granted.html"), state)).status).toBe(403);
    expect((await grantedFileResponse(join(dir, "missing.html"), state)).status).toBe(404);
  });
});
