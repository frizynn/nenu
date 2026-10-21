import { useEffect, useRef, useState } from "react";
import { ChevronRight, Folder, History } from "@/components/ui/icon";

import { Button } from "@/components/ui/button";
import { fetchHomeDirs, type HomeDirs } from "@/lib/api";
import { baseName, crumbs, expandPath, matchDirs, parseQuery, shortcutLabels, tildePath } from "@/lib/dir-picker";
import { cn } from "@/lib/utils";

interface DirPickerProps {
  /** The bridge host's home, once known; "" until the first listing answers. */
  home: string;
  /** Folders worth one tap: where agents run now, then recent picks (absolute paths). */
  shortcuts: string[];
  onHome: (home: string) => void;
  onPick: (path: string) => void;
  /** The machine whose folders these are (lib/machines.ts); undefined = this one. */
  session?: string;
}

type Listing = { state: "loading" } | { state: "ready"; dirs: HomeDirs } | { state: "error" };

const row = "flex min-h-11 w-full items-center gap-3 rounded-lg px-2 text-left text-body active:bg-accent hover:bg-hover";

/**
 * Browse folders under home: tap to go in, type to filter or to give any path, "Use" to choose. The
 * host's header titles this step and steps back out of it.
 */
export function DirPicker({ home, shortcuts, onHome, onPick, session }: DirPickerProps) {
  const [query, setQuery] = useState("~/");
  const [listing, setListing] = useState<Listing>({ state: "loading" });
  const input = useRef<HTMLInputElement>(null);
  const { dir, filter } = parseQuery(query);
  const hidden = filter.startsWith(".");

  useEffect(() => {
    const abort = new AbortController();
    setListing({ state: "loading" });
    fetchHomeDirs(dir || "~", hidden, abort.signal, session).then(
      (dirs) => {
        setListing({ state: "ready", dirs });
        onHome(dirs.home);
      },
      () => !abort.signal.aborted && setListing({ state: "error" }),
    );
    return () => abort.abort();
    // onHome is a setter from the sheet; only the folder and dot-dir choice change what is listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir, hidden]);

  const dirs = listing.state === "ready" ? listing.dirs : null;
  const matches = dirs ? matchDirs(dirs.entries, filter) : [];
  const exact = dirs && filter && dirs.entries.includes(filter) ? `${dirs.path}/${filter}` : null;
  // What "Use" picks, and its label names: the folder the filter names exactly, else the listed one.
  // A path the bridge will not list (outside home) is taken as typed; creating reports if it exists.
  const target = exact ?? dirs?.path ?? (listing.state === "error" ? expandPath(query.trim().replace(/(.)\/+$/, "$1"), home) : null);
  const shown = dirs ? tildePath(dirs.path, dirs.home) : dir.replace(/(.)\/+$/, "$1") || "~";
  const showShortcuts = query === "~/" && shortcuts.length > 0;
  const labels = shortcutLabels(shortcuts, home);

  const enter = (name: string) => {
    setQuery(`${dir}${name}/`);
    input.current?.focus({ preventScroll: true });
  };

  return (
    <div className="flex flex-1 flex-col gap-2">
      <input
        ref={input}
        aria-label="Folder path"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          if (filter && matches[0] && !exact) enter(matches[0]);
          else if (target) onPick(target);
        }}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="go"
        className="h-10 w-full rounded-lg border border-border bg-background px-3 font-mono text-code outline-none focus-visible:ring-2 focus-visible:ring-ring coarse:h-11"
      />

      {/* The row scrolls sideways, which clips a .hit-area outside it; on touch each crumb is 44 px itself. */}
      <nav aria-label="Breadcrumb" className="-mx-1 flex items-center overflow-x-auto px-1 text-subhead [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {crumbs(shown).map((c, i, all) => (
          <span key={c.query} className="flex shrink-0 items-center">
            {i > 0 && <ChevronRight className="size-3.5 text-subtle-foreground" aria-hidden />}
            <button
              type="button"
              onClick={() => setQuery(c.query)}
              aria-current={i === all.length - 1 ? "location" : undefined}
              className={cn("h-8 rounded-md px-1.5 coarse:h-11", i === all.length - 1 ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}
            >
              {c.label === "~" ? "Home" : c.label}
            </button>
          </span>
        ))}
      </nav>

      {/* One row that scrolls sideways: as a column, five recent folders pushed home's own folders
          below the Use button on a phone. */}
      {showShortcuts && (
        <section aria-label="Recent folders">
          <h3 className="px-2 pb-1 text-footnote font-medium text-muted-foreground">Recent</h3>
          <ul className="-mx-4 flex gap-2 overflow-x-auto px-4 [scrollbar-width:none] lg:-mx-5 lg:px-5 [&::-webkit-scrollbar]:hidden">
            {shortcuts.map((path, i) => (
              <li key={path} className="shrink-0">
                <button
                  type="button"
                  aria-label={tildePath(path, home)}
                  title={tildePath(path, home)}
                  onClick={() => onPick(path)}
                  className="flex h-9 max-w-56 items-center gap-1.5 rounded-full border border-border bg-card px-3 text-subhead hover:bg-hover active:bg-accent coarse:h-11"
                >
                  <History className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="truncate">{labels[i]}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-label="Folders" className="flex-1">
        {showShortcuts && <h3 className="px-2 pt-2 pb-1 text-footnote font-medium text-muted-foreground">In {shown === "~" ? "Home" : baseName(shown)}</h3>}
        {listing.state === "loading" && <p className="px-2 py-3 text-subhead text-muted-foreground">Loading…</p>}
        {listing.state === "error" && <p className="px-2 py-3 text-subhead text-muted-foreground">Can't list this folder. You can still use the path as typed.</p>}
        {dirs && matches.length === 0 && <p className="px-2 py-3 text-subhead text-muted-foreground">{filter ? `No folder starts with “${filter}”.` : "No folders here."}</p>}
        <ul>
          {matches.map((name) => (
            <li key={name}>
              <button type="button" className={row} onClick={() => enter(name)}>
                <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{name}</span>
                <ChevronRight className="size-4 shrink-0 text-subtle-foreground" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
        {dirs?.truncated && <p className="px-2 py-2 text-footnote text-muted-foreground">Showing the first {dirs.entries.length}. Type to narrow.</p>}
      </section>

      <div className="sticky bottom-0 -mx-4 mt-auto border-t border-border/60 bg-background/95 px-4 pt-3 backdrop-blur-md lg:-mx-5 lg:px-5 lg:pb-4">
        <Button type="button" className="h-11 w-full" disabled={!target} onClick={() => target && onPick(target)}>
          {target ? `Use ${tildePath(target, home) === "~" ? "Home" : baseName(target)}` : "Use this folder"}
        </Button>
      </div>
    </div>
  );
}
