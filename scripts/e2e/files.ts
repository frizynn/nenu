import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DESKTOP, PHONE, type Browser, type Page } from "./browser.ts";
import type { TestBridge } from "./bridge.ts";
import { appendJournal } from "./scenario.ts";

// The files bench: every way a chat hands the operator a file, followed for real in WebKit on a phone
// and a desk. It taps each link and row, opens each one in a new tab, takes the confirmed Open for a
// file beyond the folder, and asks the bridge for what it must refuse. Each check passes or fails; the
// command exits 1 on any failure (run.ts `files`).

export interface Check { name: string; ok: boolean; detail?: string }

// One page with "Spec" on it, enough for pdf.js; it rebuilds the cross-reference table itself.
const PDF = [
  "%PDF-1.4",
  "1 0 obj <</Type /Catalog /Pages 2 0 R>> endobj",
  "2 0 obj <</Type /Pages /Kids [3 0 R] /Count 1>> endobj",
  "3 0 obj <</Type /Page /Parent 2 0 R /MediaBox [0 0 200 120] /Contents 4 0 R /Resources <</Font <</F1 5 0 R>>>>>> endobj",
  "4 0 obj <</Length 37>> stream\nBT /F1 24 Tf 20 50 Td (Spec) Tj ET\nendstream endobj",
  "5 0 obj <</Type /Font /Subtype /Type1 /BaseFont /Helvetica>> endobj",
  "trailer <</Root 1 0 R>>",
  "%%EOF",
].join("\n");

export async function filesBench(bridge: TestBridge, browser: Browser, outDir: string): Promise<Check[]> {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail?: string) => { checks.push({ name, ok, ...(detail ? { detail } : {}) }); };
  // A step that throws fails as itself, and the bench goes on to the next.
  const step = async (name: string, run: () => Promise<void>) => {
    try { await run(); } catch (error) { check(name, false, String(error).split("\n")[0]); }
  };
  // As a finger leaves the viewer: its Done, or Escape on a desk where Done is hidden.
  const closeViewer = async (page: Page) => {
    const done = page.getByRole("button", { name: "Done" });
    if (await done.count() && await done.last().isVisible()) await done.last().click();
    else await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
  };
  const vault = await mkdtemp(join(tmpdir(), "nenu-e2e-files-"));
  try {
    const pane = bridge.herd!.idle;
    const cwd = bridge.dir;
    const picture = await Bun.file(join(import.meta.dir, "../../web/public/nenu-pwa-192x192.png")).bytes();
    const seed: Record<string, string | Uint8Array> = {
      [join(cwd, "reports/test-report.md")]: "# Test report\n\nAll 48 checkout tests pass. See [the notes](notes.md).\n",
      [join(cwd, "reports/notes.md")]: "# Notes\n\nThe second document.\n",
      [join(cwd, "docs/spec.pdf")]: PDF,
      [join(cwd, "shots/after.png")]: picture,
      [join(cwd, "design/page.html")]: "<!doctype html><title>Page</title><h1>Checkout page</h1>",
      [join(cwd, ".env")]: "SECRET_TOKEN=bench\n",
      [join(cwd, ".claude.json")]: '{"oauthAccount":{"token":"bench"}}\n',
      [join(vault, "attachments/reference.png")]: picture,
      [join(vault, "secret.md")]: "outside the folder\n",
    };
    for (const [path, body] of Object.entries(seed)) {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, body);
    }
    await symlink(join(vault, "secret.md"), join(cwd, "escape.md"));
    await appendJournal(bridge.herd!.journals.get(pane)!, [
      ["user", "Show me what you made."],
      ["assistant", [
        "The [test report](reports/test-report.md) and the spec, `docs/spec.pdf`.",
        "![After](shots/after.png)",
        "The page is design/page.html.",
        `The reference lives outside the folder: ${join(vault, "attachments/reference.png")}`,
      ].join("\n\n")],
    ], bridge.now() - 60_000);

    const chat = `${bridge.url}/pane/${encodeURIComponent(pane)}`;
    const filePage = (path: string) => `/pane/${encodeURIComponent(pane)}/file?${new URLSearchParams({ path })}`;
    const shot = async (page: Page, name: string) => page.screenshot({ path: join(outDir, `${name}.png`), animations: "disabled" });

    const context = await browser.newContext({ ...PHONE, timezoneId: "UTC", locale: "en-US" });
    const page = await context.newPage();
    await page.goto(chat);
    await page.getByText("The page is").waitFor({ timeout: 15_000 });
    await page.waitForTimeout(1500);
    await shot(page, "phone-chat");

    // 1. A link in prose: a real link to the file's own page, opened in place by a tap.
    await step("1. A link in prose", async () => {
      const report = page.getByRole("link", { name: "test report" });
      check("prose link is a link to the file's own page", await report.getAttribute("href") === filePage("reports/test-report.md"), await report.getAttribute("href") ?? "no href");
      await report.click();
      const reportViewer = page.getByRole("dialog", { name: "test-report.md" });
      const reportOpened = await reportViewer.getByRole("heading", { name: "Test report" }).waitFor({ timeout: 8_000 }).then(() => true, () => false);
      check("a tap opens the document in the viewer", reportOpened && page.url() === chat);
      await shot(page, "phone-viewer-markdown");
      // A link inside the document opens the sibling, from the document's folder.
      const notes = reportViewer.getByRole("link", { name: "the notes" });
      check("a document's link points at its sibling's page", await notes.getAttribute("href") === filePage("reports/notes.md"), await notes.getAttribute("href") ?? "no href");
      await notes.click();
      check("a document's link opens its sibling", await page.getByRole("dialog", { name: "notes.md" }).getByText("The second document.").waitFor({ timeout: 8_000 }).then(() => true, () => false));
      // On a phone the new tab sits in More actions.
      await page.getByRole("dialog", { name: "notes.md" }).getByRole("button", { name: "More actions" }).click();
      const [popup] = await Promise.all([
        context.waitForEvent("page", { timeout: 8_000 }).catch(() => null),
        page.getByRole("button", { name: "Open in new tab" }).click().catch(() => null),
      ]);
      const popupOk = popup ? await popup.getByRole("dialog", { name: "notes.md" }).getByText("The second document.").waitFor({ timeout: 10_000 }).then(() => true, () => false) : false;
      check("More → Open in new tab opens the file's own page", popupOk, popup?.url());
      if (popup) {
        await shot(popup, "phone-new-tab-markdown");
        // Done on the file's own page lands on the pane's chat.
        await popup.getByRole("button", { name: "Done" }).click();
        check("Done on the file's page goes to the chat", await popup.waitForURL(chat, { timeout: 8_000 }).then(() => true, () => false), popup.url());
        await popup.close();
      }
      await closeViewer(page);
    });

    // 2. A code span that is a path: the PDF, rendered by Nenu's own renderer.
    await step("2. A code span that is a path", async () => {
      const spec = page.getByRole("link", { name: "docs/spec.pdf" });
      await spec.click();
      const pdfViewer = page.getByRole("dialog", { name: "spec.pdf" });
      const pdfDrawn = await pdfViewer.locator("canvas").first().waitFor({ timeout: 10_000 }).then(() => true, () => false);
      check("a code path opens the PDF and draws it", pdfDrawn);
      await shot(page, "phone-viewer-pdf");
      // The same page opened as a new tab would: straight from its address.
      const tab = await context.newPage();
      await tab.goto(bridge.url + filePage("docs/spec.pdf"));
      check("the PDF's own page draws it too", await tab.getByRole("dialog", { name: "spec.pdf" }).locator("canvas").first().waitFor({ timeout: 10_000 }).then(() => true, () => false));
      await shot(tab, "phone-page-pdf");
      await tab.close();
      await closeViewer(page);
    });

    // 3. An image in place, and the HTML page's card.
    await step("3. An inline image and an HTML page", async () => {
      const image = page.getByRole("link", { name: "Open After" });
      check("an inline image is a link to its page", await image.getAttribute("href") === filePage("shots/after.png"), await image.getAttribute("href") ?? "no href");
      await image.click();
      await page.waitForTimeout(800);
      check("a tap on the image opens it in the viewer", await page.locator(".image-viewer img").first().evaluate((element) => { const img = element as HTMLImageElement; return img.complete && img.naturalWidth > 0; }).catch(() => false));
      await closeViewer(page);
      const card = page.getByRole("link", { name: "Open page.html" });
      const cardShown = await card.waitFor({ timeout: 8_000 }).then(() => true, () => false);
      check("the HTML page has a card", cardShown);
      if (cardShown) {
        await card.click();
        const frame = page.getByTitle("Rendered preview of page.html");
        check("the HTML page renders in a script-only sandbox", await frame.getAttribute("sandbox").catch(() => null) === "allow-scripts");
        await closeViewer(page);
      }
    });

    // 4. The file beyond the folder: a card, the viewer's refusal, then the confirmed single-use Open.
    await step("4. The file beyond the folder", async () => {
      const outside = page.getByRole("link", { name: "Open reference.png" });
      const outsideShown = await outside.waitFor({ timeout: 8_000 }).then(() => true, () => false);
      check("a file outside the folder has a card", outsideShown);
      if (outsideShown) {
        await outside.click();
        const open = page.getByRole("button", { name: /^Open/ }).last();
        await open.waitFor({ timeout: 8_000 }).catch(() => {});
        await shot(page, "phone-outside-refused");
        await open.click().catch(() => {});
        const confirm = page.getByRole("dialog", { name: "Open this file outside Nenu's preview?" });
        const asked = await confirm.waitFor({ timeout: 8_000 }).then(() => true, () => false);
        check("opening it asks first", asked);
        if (asked) {
          await shot(page, "phone-outside-confirm");
          const link = confirm.getByRole("link", { name: /Open/ });
          await link.waitFor({ timeout: 8_000 }).catch(() => {});
          const href = await link.getAttribute("href").catch(() => null);
          const first = href ? await page.request.get(new URL(href, bridge.url).toString()) : null;
          const again = href ? await page.request.get(new URL(href, bridge.url).toString()) : null;
          check("the confirmed link opens the file once", first?.status() === 200, `status ${first?.status()}`);
          check("and never twice", again !== null && again.status() >= 400, `status ${again?.status()}`);
        }
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
        await closeViewer(page);
      }
    });

    // 5. The lists: every row a link to its page, a tap opening the viewer.
    await step("5. The lists", async () => {
      await page.getByRole("button", { name: "Conversation actions" }).click();
      await page.getByRole("button", { name: "Artifacts and files" }).click();
      const sheet = page.getByRole("dialog", { name: "Artifacts and files" });
      await sheet.waitFor({ timeout: 8_000 });
      await sheet.getByRole("group", { name: "File type" }).getByRole("button", { name: /^Files/ }).click();
      const row = sheet.getByRole("link", { name: "Open test-report.md" });
      const rowShown = await row.waitFor({ timeout: 8_000 }).then(() => true, () => false);
      check("the Files list rows are links to each file's page", rowShown && await row.getAttribute("href") === filePage("reports/test-report.md"));
      await shot(page, "phone-files-list");
      const listedNames = await sheet.getByRole("link").allTextContents();
      check("the Files list names no private file", !listedNames.some((name) => /\.env|\.claude\.json/.test(name)), listedNames.join(" | "));
      if (rowShown) {
        await row.click();
        check("a Files row opens the viewer", await page.getByRole("dialog", { name: "test-report.md" }).waitFor({ timeout: 8_000 }).then(() => true, () => false));
        await closeViewer(page);
      }
      await page.getByRole("button", { name: "Conversation actions" }).click();
      await page.getByRole("button", { name: "Artifacts and files" }).click();
      await sheet.getByRole("group", { name: "File type" }).getByRole("button", { name: /^Project/ }).click();
      await sheet.getByRole("button", { name: "reports" }).click().catch(() => {});
      const treeRow = sheet.getByRole("link", { name: "test-report.md" });
      const treeShown = await treeRow.waitFor({ timeout: 8_000 }).then(() => true, () => false);
      check("the Project tree's files are links to each file's page", treeShown && await treeRow.getAttribute("href") === filePage("reports/test-report.md"));
      const treeNames = await sheet.innerText();
      check("the Project tree lists no private file", !/\.env\b|\.claude\.json/.test(treeNames), treeNames.replace(/\s+/g, " ").slice(0, 300));
      await shot(page, "phone-project-tree");
      await context.close();
    });

    // 6. On a desk: the viewer's own new-tab button, and a modified click on a link.
    await step("6. On a desk", async () => {
      const desk = await browser.newContext({ ...DESKTOP, timezoneId: "UTC", locale: "en-US" });
      const deskPage = await desk.newPage();
      await deskPage.goto(chat);
      await deskPage.getByText("The page is").waitFor({ timeout: 15_000 });
      await deskPage.waitForTimeout(1000);
      await deskPage.getByRole("link", { name: "test report" }).click();
      const button = deskPage.getByRole("dialog", { name: "test-report.md" }).getByRole("link", { name: "Open in new tab" });
      check("the viewer offers a new tab on a desk", await button.getAttribute("href").catch(() => null) === filePage("reports/test-report.md") && await button.getAttribute("target").catch(() => null) === "_blank");
      await deskPage.screenshot({ path: join(outDir, "desk-viewer.png"), animations: "disabled" });
      await closeViewer(deskPage);
      const [modified] = await Promise.all([
        desk.waitForEvent("page", { timeout: 8_000 }).catch(() => null),
        deskPage.getByRole("link", { name: "test report" }).click({ modifiers: ["Meta"] }),
      ]);
      check("a modified click opens a new tab and leaves the chat as it was",
        modified !== null && await deskPage.getByRole("dialog", { name: "test-report.md" }).count() === 0, modified?.url() ?? "no new tab");
      await desk.close();
    });

    // 7. What the bridge must refuse, asked straight from the page's origin.
    await step("7. What the bridge must refuse", async () => {
      const api = (path: string) => `${bridge.url}/api/pane/${encodeURIComponent(pane)}/file?${new URLSearchParams({ path })}`;
      const probe = await browser.newContext({});
      for (const [name, path] of [
        ["a .env file", ".env"],
        ["Claude's config with its token", ".claude.json"],
        ["a path that climbs out of the folder", "../../../etc/hosts"],
        ["a link that points outside the folder", "escape.md"],
        ["an absolute path outside the folder", join(vault, "secret.md")],
      ] as const) {
        const response = await probe.request.get(api(path));
        check(`the bridge refuses ${name}`, response.status() >= 400, `status ${response.status()}`);
      }
      const served = await probe.request.get(api("reports/test-report.md"));
      const csp = served.headers()["content-security-policy"] ?? "";
      check("a served file carries a sandbox CSP and nosniff", /sandbox/.test(csp) && served.headers()["x-content-type-options"] === "nosniff", csp);
      const listing = await probe.request.get(`${bridge.url}/api/pane/${encodeURIComponent(pane)}/files?path=`);
      const listed = JSON.stringify(await listing.json().catch(() => ({})));
      check("the folder listing hides private files", !/"\.env"|\.claude\.json/.test(listed), listed.slice(0, 300));
      await probe.close();
    });

    return checks;
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
}
