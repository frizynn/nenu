import { useContext, type CSSProperties, type ReactNode } from "react";

import { FileHrefContext, FileKnownContext, FilePreviewContext } from "@/lib/file-preview-context";

/**
 * What opens a file. A tap opens Nenu's viewer in place. Where the pane can address the file, it is a
 * real link to the file's own page (lib/nav.ts `filePagePath`), so a long-press, a middle click or a
 * modified click opens it in a new tab, reading it through the same routes as the viewer. `onOpen`
 * replaces the plain tap (a list that closes its sheet first); without either way to open, it is the
 * content alone.
 */
export function FileLink({ path, onOpen, label, title, className, style, children }: {
  path: string;
  onOpen?: () => void;
  label?: string;
  title?: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const href = useContext(FileHrefContext);
  const openFile = useContext(FilePreviewContext);
  const known = useContext(FileKnownContext);
  const open = onOpen ?? (openFile && (!known || known(path)) ? () => openFile(path) : null);
  if (!open) return <>{children}</>;
  const props = { "aria-label": label, title, className, style };
  if (!href) return <button type="button" {...props} onClick={open}>{children}</button>;
  return (
    <a href={href(path)} {...props} onClick={(event) => {
      // A modified click is the browser's own: a new tab or window.
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      open();
    }}>{children}</a>
  );
}
