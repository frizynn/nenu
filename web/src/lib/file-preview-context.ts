import { createContext } from "react";

export const FilePreviewContext = createContext<((path: string) => void) | null>(null);

export const FileMediaContext = createContext<((path: string) => string) | null>(null);

/** The address of a file's own page (lib/nav.ts `filePagePath`), for a link that opens it in a new tab. */
export const FileHrefContext = createContext<((path: string) => string) | null>(null);
