import { designboardPreview } from "./designboard.ts";
import { paneFileResponse } from "./pane-files.ts";
import { HTML_PREVIEW_CSP } from "../web/src/lib/html-preview.ts";

/** A network document has its own CSP; srcdoc inherits the app's stricter script policy. */
export async function renderedHtmlResponse(
  cwd: string | undefined,
  path: string | null,
): Promise<Response> {
  if (!path || !/\.html?$/i.test(path))
    return new Response("An HTML file is required.", { status: 400 });
  const source = await paneFileResponse(cwd, path);
  if (!source.ok) return source;
  return new Response(designboardPreview(await source.text()), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": `${HTML_PREVIEW_CSP}; sandbox allow-scripts; frame-ancestors 'self'`,
      "referrer-policy": "no-referrer",
    },
  });
}
