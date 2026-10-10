import { dirname, extname, resolve } from "node:path";
import { designboardPreview } from "./designboard.ts";
import { openPaneFile, readPaneBytes, readPaneText, type PaneFile } from "./pane-files.ts";
import { imageExtFromBytes } from "./uploads.ts";
import { HTML_PREVIEW_CSP } from "../web/src/lib/html-preview.ts";

/** Total bytes of sibling assets one preview may carry inline (ADR 0059). */
export const MAX_INLINED_ASSET_BYTES = 8 * 1024 * 1024;

/** A reference that stays inside the document's own directory, or null for anything else. */
function siblingPath(dir: string, ref: string | null): string | null {
  const name = ref?.trim().split(/[?#]/, 1)[0];
  if (!name || /^[a-z][a-z0-9+.-]*:/i.test(name) || /^[\\/]/.test(name)) return null;
  try {
    const path = resolve(dir, decodeURIComponent(name));
    return dirname(path) === dir ? path : null;
  } catch {
    return null;
  }
}

/**
 * Replace same-directory stylesheets, scripts and images with inline copies, so a multi-file page
 * renders inside the no-network sandbox. Every asset goes through `open`, which applies the same
 * containment, privacy and size rules as `/file`; anything else is left as written and stays blocked
 * by the preview CSP.
 */
export async function inlineSiblingAssets(
  source: string,
  dir: string,
  open: (path: string) => Promise<PaneFile | Response>,
  budget = MAX_INLINED_ASSET_BYTES,
): Promise<string> {
  const read = async (ref: string | null, extensions: readonly string[]) => {
    const path = siblingPath(dir, ref);
    if (!path || !extensions.includes(extname(path).toLowerCase())) return null;
    const file = await open(path).catch(() => null);
    if (!file || file instanceof Response) return null;
    try {
      if (file.size > budget) return null;
      const bytes = await readPaneBytes(file);
      budget -= bytes.length;
      return { bytes, ext: extname(file.path).toLowerCase() };
    } finally {
      await file.handle.close();
    }
  };
  const readText = async (ref: string | null, extensions: readonly string[]) => {
    const asset = await read(ref, extensions);
    return asset && !asset.bytes.includes(0) ? asset.bytes.toString("utf8") : null;
  };
  return new HTMLRewriter()
    .on("link[href]", {
      async element(link) {
        const rel = link.getAttribute("rel") ?? "";
        if (!/(?:^|\s)stylesheet(?:\s|$)/i.test(rel) || /(?:^|\s)alternate(?:\s|$)/i.test(rel) || link.hasAttribute("disabled")) return;
        const css = await readText(link.getAttribute("href"), [".css"]);
        if (css === null) return;
        const media = link.getAttribute("media");
        const open = media === null ? "<style>" : `<style media="${Bun.escapeHTML(media)}">`;
        link.replace(`${open}${css.replace(/<\/style/gi, "<\\/style")}</style>`, { html: true });
      },
    })
    .on("script[src]", {
      async element(script) {
        // An inline classic script ignores defer and async and would run before the body exists.
        const module = script.getAttribute("type")?.trim().toLowerCase() === "module";
        if (!module && (script.hasAttribute("defer") || script.hasAttribute("async"))) return;
        const js = await readText(script.getAttribute("src"), [".js", ".mjs", ".cjs"]);
        if (js === null) return;
        script.removeAttribute("src");
        script.setInnerContent(js.replace(/<\/script/gi, "<\\/script"), { html: true });
      },
    })
    .on("img[src]", {
      async element(img) {
        const asset = await read(img.getAttribute("src"), [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
        if (!asset) return;
        // SVG only ever reaches the page as an image, where it runs no script (ADR 0059).
        const raster = imageExtFromBytes(asset.bytes);
        const mime = asset.ext === ".svg"
          ? (asset.bytes.includes(0) ? null : "image/svg+xml")
          : raster && (raster === "jpg" ? "image/jpeg" : `image/${raster}`);
        if (mime) img.setAttribute("src", `data:${mime};base64,${asset.bytes.toString("base64")}`);
      },
    })
    .transform(new Response(source))
    .text();
}

/**
 * A network document has its own CSP; srcdoc inherits the app's stricter script policy. The file is
 * found exactly as `/file` finds it, delivered-outside-cwd exception included.
 */
export async function renderedHtmlResponse(
  cwd: string | undefined,
  path: string | null,
  options: { delivered?: () => Promise<readonly string[]>; inlineAssets?: boolean } = {},
): Promise<Response> {
  if (!path || !/\.html?$/i.test(path))
    return new Response("An HTML file is required.", { status: 400 });
  const file = await openPaneFile(cwd, path, options.delivered);
  if (file instanceof Response) return file;
  let source: string | null;
  try {
    source = await readPaneText(file);
  } finally {
    await file.handle.close();
  }
  if (source === null) return new Response("Binary files cannot be displayed as text.", { status: 415 });
  let document = designboardPreview(source);
  if (options.inlineAssets)
    document = await inlineSiblingAssets(document, dirname(file.path), (asset) => openPaneFile(cwd, asset, options.delivered));
  return new Response(document, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": `${HTML_PREVIEW_CSP}; sandbox allow-scripts; frame-ancestors 'self'`,
      "referrer-policy": "no-referrer",
    },
  });
}
