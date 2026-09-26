import { useEffect, useState } from "react";
import { ArrowLeft, FileText, Folder, RefreshCw } from "lucide-react";
import { fetchProjectFiles, type ProjectFilesPage } from "@/lib/api";

export function ProjectFilesBrowser({
  paneId,
  session,
  onOpen,
}: {
  paneId: string;
  session?: string;
  onOpen: (path: string) => void;
}) {
  const [path, setPath] = useState(".");
  const [page, setPage] = useState<ProjectFilesPage | null>(null);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setPage(null);
    setError(false);
    void fetchProjectFiles(paneId, path, session, controller.signal)
      .then(next => { if (!controller.signal.aborted) setPage(next); })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [paneId, session, path, refresh]);
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        {path !== "." && (
          <button
            type="button"
            aria-label="Parent folder"
            className="flex size-11 items-center justify-center"
            onClick={() =>
              setPath(path.split("/").slice(0, -1).join("/") || ".")
            }
          >
            <ArrowLeft className="size-4" />
          </button>
        )}
        <span className="min-w-0 flex-1 truncate">
          {path === "." ? "Project files" : path}
        </span>
        <button
          type="button"
          aria-label="Refresh files"
          className="flex size-11 items-center justify-center"
          onClick={() => setRefresh((n) => n + 1)}
        >
          <RefreshCw className="size-4" />
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-sm">
          Could not read this folder. Try refreshing.
        </p>
      ) : !page ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading files…
        </p>
      ) : (
        <>
          <ul className="divide-y divide-border/40">
            {page.files.map((file) => (
              <li key={file.path}>
                <button
                  type="button"
                  className="flex min-h-11 w-full items-center gap-2 py-2 text-left text-sm hover:bg-muted/40"
                  onClick={() =>
                    file.kind === "directory"
                      ? setPath(file.path)
                      : onOpen(file.path)
                  }
                >
                  {file.kind === "directory" ? (
                    <Folder className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <FileText className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{file.name}</span>
                </button>
              </li>
            ))}
          </ul>
          {!page.files.length && (
            <p className="text-sm text-muted-foreground">
              This folder is empty.
            </p>
          )}
          {page.truncated && (
            <p className="mt-2 text-xs text-muted-foreground">
              Showing the first 300 entries. Open a folder to narrow the list.
            </p>
          )}
        </>
      )}
    </div>
  );
}
