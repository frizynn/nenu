import { createContext } from "react";

export const FilePreviewContext = createContext<((path: string) => void) | null>(null);

export const FileMediaContext = createContext<((path: string) => string) | null>(null);
