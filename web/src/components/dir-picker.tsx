import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Folder, History } from "lucide-react";

import { Button } from "@/components/ui/button";
import { fetchHomeDirs, type HomeDirs } from "@/lib/api";
import { baseName, crumbs, expandPath, matchDirs, parseQuery, tildePath } from "@/lib/dir-picker";
import { cn } from "@/lib/utils";

interface DirPickerProps {
  /** The bridge host's home, once known; "" until the first listing answers. */
  home: string;
  /** Folders worth one tap: where agents run now, then recent picks (absolute paths). */
  shortcuts: string[];
  onHome: (home: string) => void;
  onPick: (path: string) => void;
  onBack: () => void;
}

type Listing = { state: "loading" } | { state: "ready"; dirs: HomeDirs } | { state: "error" };

const row = "flex min-h-11 w-full items-center gap-3 rounded-lg px-2 text-left text-sm active:bg-accent hover:bg-accent/60";

/** Browse folders under home: tap to go in, type to filter or to give any path, "Use" to choose. */
export function DirPicker({ home, shortcuts, onHome, onPick, onBack }: DirPickerProps) {
  const [query, setQuery] = useState("~/");
  const [listing, setListing] = useState<Listing>({ state: "loading" });
  const input = useRef<HTMLInputElement>(null);
  const { dir, filter } = parseQuery(query);
  const hidden = filter.startsWith(".");

  useEffect(() => {
    const abort = new AbortController();
    setListing({ state: "loading" });
    fetchHomeDirs(dir || "~", hidden, abort.signal).then(
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

  const enter = (name: string) => {
    setQuery(`${dir}${name}/`);
    input.current?.focus({ preventScroll: true });
  };

  return (
    <div className="flex flex-1 flex-col gap-2">
      <div className="flex items-center gap-1">
        <Button type="button" variant="ghost" size="icon" className="-ml-2 size-10 shrink-0" aria-label="Back" onClick={onBack}>
          <ChevronLeft className="size-5" />
        </Button>
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
          className="h-10 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>

      <nav aria-label="Breadcrumb" className="-mx-1 flex items-center overflow-x-auto px-1 text-sm [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {crumbs(shown).map((c, i, all) => (
          <span key={c.query} className="flex shrink-0 items-center">
            {i > 0 && <ChevronRight className="size-3.5 text-muted-foreground/60" aria-hidden />}
            <button
              type="button"
              onClick={() => setQuery(c.query)}
              aria-current={i === all.length - 1 ? "location" : undefined}
              className={cn("h-8 rounded-md px-1.5", i === all.length - 1 ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}
            >
              {c.label === "~" ? "Home" : c.label}
            </button>
          </span>
        ))}
      </nav>

      {showShortcuts && (
        <section aria-label="Recent folders">
          <h3 className="px-2 pb-1 text-xs font-medium text-muted-foreground">Recent</h3>
          <ul>
            {shortcuts.map((path) => {
              const short = tildePath(path, home);
              return (
                <li key={path}>
                  <button type="button" className={row} aria-label={short} onClick={() => onPick(path)}>
                    <History className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium">{baseName(short)}</span>{" "}
                      <span className="text-xs text-muted-foreground">{short.slice(0, -baseName(short).length - 1) || "/"}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section aria-label="Folders" className="flex-1">
        {showShortcuts && <h3 className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">In {shown === "~" ? "Home" : baseName(shown)}</h3>}
        {listing.state === "loading" && <p className="px-2 py-3 text-sm text-muted-foreground">Loading…</p>}
        {listing.state === "error" && <p className="px-2 py-3 text-sm text-muted-foreground">Can't list this folder. You can still use the path as typed.</p>}
        {dirs && matches.length === 0 && <p className="px-2 py-3 text-sm text-muted-foreground">{filter ? `No folder starts with “${filter}”.` : "No folders here."}</p>}
        <ul>
          {matches.map((name) => (
            <li key={name}>
              <button type="button" className={row} onClick={() => enter(name)}>
                <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{name}</span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground/60" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
        {dirs?.truncated && <p className="px-2 py-2 text-xs text-muted-foreground">Showing the first {dirs.entries.length}. Type to narrow.</p>}
      </section>

      <div className="sticky bottom-0 -mx-4 mt-auto border-t border-border/60 bg-background/95 px-4 pt-3 backdrop-blur-md">
        <Button type="button" className="h-11 w-full" disabled={!target} onClick={() => target && onPick(target)}>
          {target ? `Use ${tildePath(target, home) === "~" ? "Home" : baseName(target)}` : "Use this folder"}
        </Button>
      </div>
    </div>
  );
}
