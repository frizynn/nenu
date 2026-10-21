import { createContext } from "react";

export const FilePreviewContext = createContext<((path: string) => void) | null>(null);

/** The paths a view's opener can reach, when it reaches only some (a project's Context opens the files it
 *  lists): a name outside them draws its words, never a link that goes nowhere. Without it, every path. */
export const FileKnownContext = createContext<((path: string) => boolean) | null>(null);

export const FileMediaContext = createContext<((path: string) => string) | null>(null);

/** The address of a file's own page (lib/nav.ts `filePagePath`), for a link that opens it in a new tab. */
export const FileHrefContext = createContext<((path: string) => string) | null>(null);
