import { useEffect, useState } from "react";
import {
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  RefreshCw,
} from "lucide-react";
import { fetchProjectFiles, type ProjectFilesPage } from "@/lib/api";

type Props = {
  paneId: string;
  session?: string;
  onOpen: (path: string) => void;
};

export function ProjectFilesBrowser(props: Props) {
  const [refresh, setRefresh] = useState(0);
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">Working directory</span>
        <button
          type="button"
          aria-label="Refresh files"
          className="flex size-11 items-center justify-center rounded-md hover:bg-muted"
          onClick={() => setRefresh((n) => n + 1)}
        >
          <RefreshCw className="size-4" />
        </button>
      </div>
      <Directory
        key={`${props.paneId}:${props.session}:${refresh}`}
        {...props}
        path="."
        depth={0}
      />
    </div>
  );
}

/** Mounted on first expansion; collapsed folders retain children without more I/O. */
function Directory({
  paneId,
  session,
  onOpen,
  path,
  depth,
}: Props & { path: string; depth: number }) {
  const [page, setPage] = useState<ProjectFilesPage | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(false);
    void fetchProjectFiles(paneId, path, session, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setPage(next);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [paneId, session, path, attempt]);
  if (error)
    return (
      <div role="alert" className="text-xs">
        Could not read this folder.
        <button
          className="min-h-11 px-2 underline"
          onClick={() => setAttempt((n) => n + 1)}
        >
          Retry
        </button>
      </div>
    );
  if (!page)
    return (
      <p role="status" className="py-2 text-xs text-muted-foreground">
        Loading files…
      </p>
    );
  return (
    <ul aria-label={path === "." ? "Working directory files" : path}>
      {page.files.map((file) => (
        <li key={file.path}>
          {file.kind === "directory" ? (
            <FolderBranch
              {...{ paneId, session, onOpen, depth }}
              path={file.path}
              name={file.name}
            />
          ) : (
            <button
              type="button"
              title={file.path}
              onClick={() => onOpen(file.path)}
              style={{ paddingLeft: `${Math.min(depth, 10) * 12 + 24}px` }}
              className="flex min-h-11 w-full items-center gap-2 rounded-md pr-2 text-left text-sm hover:bg-muted/40"
            >
              <FileText
                aria-hidden="true"
                className="size-4 shrink-0 text-muted-foreground"
              />
              <span className="truncate">{file.name}</span>
            </button>
          )}
        </li>
      ))}
      {!page.files.length && (
        <li className="px-6 py-2 text-xs text-muted-foreground">
          Empty folder
        </li>
      )}
      {page.truncated && (
        <li className="py-2 text-xs text-muted-foreground">
          Showing the first 300 entries.
        </li>
      )}
    </ul>
  );
}

function FolderBranch({
  name,
  ...props
}: Props & { name: string; path: string; depth: number }) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const Icon = open ? FolderOpen : Folder;
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        title={props.path}
        onClick={() => {
          setLoaded(true);
          setOpen(!open);
        }}
        style={{ paddingLeft: `${Math.min(props.depth, 10) * 12}px` }}
        className="flex min-h-11 w-full items-center gap-2 rounded-md pr-2 text-left text-sm hover:bg-muted/40"
      >
        <ChevronRight
          aria-hidden="true"
          className={`size-4 shrink-0 text-muted-foreground ${open ? "rotate-90" : ""}`}
        />
        <Icon
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground"
        />
        <span className="truncate">{name}</span>
      </button>
      {loaded && (
        <div hidden={!open}>
          <Directory {...props} depth={props.depth + 1} />
        </div>
      )}
    </>
  );
}
