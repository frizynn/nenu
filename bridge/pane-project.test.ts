import { describe, expect, it } from "bun:test";

import { ProjectCache, projectOf, remoteName, type ProjectFs } from "./pane-project.ts";

/** A filesystem of `.git` folders and files, and the files they hold. */
function fakeFs(dirs: string[], files: Record<string, string>): ProjectFs {
  return {
    kind: (path) => dirs.includes(path) ? "dir" : path in files ? "file" : undefined,
    read: (path) => files[path],
  };
}

const config = (url: string, remote = "origin") => `[core]\n\tbare = false\n[remote "${remote}"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/${remote}/*\n[branch "main"]\n\tremote = ${remote}\n`;

describe("projectOf", () => {
  it("names a checkout by the repo its origin names, from any folder inside it", () => {
    const fs = fakeFs(["/w/shop-clone/.git"], { "/w/shop-clone/.git/config": config("git@github.com:acme/shop.git") });
    expect(projectOf("/w/shop-clone", fs, "/home")).toBe("shop");
    expect(projectOf("/w/shop-clone/web/src", fs, "/home")).toBe("shop");
  });

  it("puts a worktree with the repo it was made from", () => {
    const fs = fakeFs(["/main/shop/.git"], {
      "/pool/7/shop/.git": "gitdir: /main/shop/.git/worktrees/7\n",
      "/main/shop/.git/config": config("https://github.com/acme/shop"),
    });
    expect(projectOf("/pool/7/shop", fs, "/home")).toBe("shop");
  });

  it("falls back to the checkout's folder without a remote, and to the folder itself outside a repo", () => {
    expect(projectOf("/w/notes/drafts", fakeFs(["/w/notes/.git"], {}), "/home")).toBe("notes");
    expect(projectOf("/pool/7/shop", fakeFs([], { "/pool/7/shop/.git": "gitdir: /main/shop/.git/worktrees/7" }), "/home")).toBe("shop");
    expect(projectOf("/w/scratch", fakeFs([], {}), "/home")).toBe("scratch");
  });

  it("never takes the home folder's own repo for the project", () => {
    const fs = fakeFs(["/home/.git"], { "/home/.git/config": config("git@github.com:me/dotfiles.git") });
    expect(projectOf("/home/scratch", fs, "/home")).toBe("scratch");
  });

  it("says nothing for a pane with no folder", () => {
    expect(projectOf("", fakeFs([], {}), "/home")).toBeUndefined();
  });
});

describe("remoteName", () => {
  it("takes the repo's name from any URL shape, and nothing else of it", () => {
    expect(remoteName(config("git@github.com:acme/shop.git"))).toBe("shop");
    expect(remoteName(config("https://x-access-token:secret@github.com/acme/shop.git"))).toBe("shop");
    expect(remoteName(config("/Users/me/Developer/firstmate"))).toBe("firstmate");
    expect(remoteName(config("/srv/repos/shop/.git/"))).toBe("shop");
    expect(remoteName(config("ssh://git@host:22/acme/shop.git?ref=x"))).toBe("shop");
  });

  it("prefers origin, else the first remote", () => {
    expect(remoteName(config("git@github.com:me/fork.git", "mine") + config("git@github.com:acme/shop.git"))).toBe("shop");
    expect(remoteName(config("git@github.com:me/fork.git", "mine"))).toBe("fork");
    expect(remoteName("[core]\n\tbare = false\n")).toBeUndefined();
  });
});

describe("ProjectCache", () => {
  it("reads a folder once a minute and forgets folders no pane is in", () => {
    let now = 0;
    const reads: string[] = [];
    const cache = new ProjectCache(() => now, (cwd) => { reads.push(cwd); return cwd.slice(1); });
    expect(cache.get("/a")).toBe("a");
    now = 59_000;
    expect(cache.get("/a")).toBe("a");
    expect(reads).toEqual(["/a"]);
    now = 61_000;
    cache.get("/a");
    expect(reads).toEqual(["/a", "/a"]);
    cache.keep(new Set());
    cache.get("/a");
    expect(reads).toEqual(["/a", "/a", "/a"]);
  });
});
