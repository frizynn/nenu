/** Parse only the embedded document, never execute the canvas while identifying it. */
function readDesignboard(source: string) {
  const block = source.match(
    /<script\b(?=[^>]*\bid=["']canvas-doc["'])(?=[^>]*\btype=["']application\/json["'])[^>]*>([\s\S]*?)<\/script\s*>/i,
  );
  if (!block?.[1]) return null;
  try {
    // The seeder escapes HTML comment openers to keep the surrounding script parseable.
    const data: unknown = JSON.parse(block[1].replace(/<\\!--/g, "<!--"));
    if (
      !data ||
      typeof data !== "object" ||
      !("title" in data) ||
      typeof data.title !== "string" ||
      !("files" in data) ||
      !data.files ||
      typeof data.files !== "object" ||
      Array.isArray(data.files) ||
      !Object.entries(data.files).some(
        ([name, value]) => /\.html?$/i.test(name) && typeof value === "string",
      )
    )
      return null;
    const title = data.title.trim().slice(0, 200);
    return title ? { title, data, block: block[0] } : null;
  } catch {
    return null;
  }
}

export function designboardTitle(source: string): string | null {
  return readDesignboard(source)?.title ?? null;
}

const CANVAS_DOC_OPEN = /<script\b(?=[^>]*\bid=["']canvas-doc["'])(?=[^>]*\btype=["']application\/json["'])[^>]*>/i;

/**
 * Identify a designboard from the first bytes of its file. Canvases embed their artboards after the
 * title, so a large board is recognised without reading it whole: when the block does not close
 * inside `head`, the title and the first artboard name are read from the JSON prefix instead.
 */
export function designboardTitleFromHead(head: string, complete: boolean): string | null {
  const open = CANVAS_DOC_OPEN.exec(head);
  if (!open) return null;
  const prefix = head.slice(open.index + open[0].length);
  if (complete || /<\/script\s*>/i.test(prefix)) return designboardTitle(head);
  const title = /^\s*\{[^]*?"title"\s*:\s*("(?:[^"\\\n]|\\.)*")/.exec(prefix)?.[1];
  if (!title || !/"files"\s*:\s*\{\s*"(?:[^"\\]|\\.)*\.html?"\s*:\s*"/i.test(prefix)) return null;
  try {
    const text = (JSON.parse(title) as string).trim().slice(0, 200);
    return text || null;
  } catch {
    return null;
  }
}

/** The preview is for viewing; downloads retain the original editable canvas. */
export function designboardPreview(source: string): string {
  const canvas = readDesignboard(source);
  if (!canvas) return source;
  const data = JSON.stringify({ ...canvas.data, mode: "view" }).replace(
    /</g,
    "\\u003c",
  );
  return source.replace(
    canvas.block,
    // Older canvases hide the editor in view mode but still subtract its width during fit().
    () => `<script id="canvas-doc" type="application/json">${data}</script>
<style>body.view #t-toggle{display:none}</style>
<script>addEventListener("DOMContentLoaded",()=>{document.body.classList.add("no-side");dispatchEvent(new Event("resize"));},{once:true});</script>`,
  );
}
