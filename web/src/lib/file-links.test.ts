import { localFilePath, paneOwningPath } from "./file-links";
import { parseInline } from "./markdown";

describe("local document links", () => {
  it.each(["./docs/guide.md", "report.pdf", "/project/file.ts:42", "<docs/My Report.md>", "docs/a.md#L8-L12"])("recognizes %s", (path) => {
    expect(localFilePath(path)).not.toBeNull();
  });
  it.each(["https://example.com/a.pdf", "//example.com/a.pdf", "javascript:alert.md", "data:text/plain,a.md", "%2f%2fevil/a.pdf", "foo%00.md", "C:\\file.md", "/pane/w1:p1", "#section"])("never turns %s into a local document request", (path) => {
    expect(localFilePath(path)).toBeNull();
  });
  it("parses a path with spaces and removes line references without making a navigation URL", () => {
    expect(parseInline("[Read me](</project/My Report.md:12>)")).toEqual([{ kind: "file", path: "/project/My Report.md", spans: [{ kind: "text", text: "Read me" }] }]);
  });
  it("preserves external links", () => {
    expect(parseInline("[PDF](https://example.com/a.pdf)")[0]).toMatchObject({ kind: "link", href: "https://example.com/a.pdf" });
  });
  it("reads a local file:// URL as the absolute path it names", () => {
    expect(localFilePath("file:///Users/fran/board/resultado-shopify.html")).toBe("/Users/fran/board/resultado-shopify.html");
    expect(localFilePath("file://localhost/srv/My%20Report.md")).toBe("/srv/My Report.md");
    expect(localFilePath("<file:///srv/notes.md:12>")).toBe("/srv/notes.md");
    expect(parseInline("[board](file:///srv/board.html)")).toEqual([{ kind: "file", path: "/srv/board.html", spans: [{ kind: "text", text: "board" }] }]);
  });
  it.each(["file://evil.example/srv/a.md", "file:////srv/a.md", "file:///srv/a.md?x=1", "file:relative.md", "file:///srv/%0a.md"])("never reads %s as a local file", (path) => {
    expect(localFilePath(path)).toBeNull();
  });
  it("accepts line numbers on a relative file instead of mistaking them for a URL scheme", () => {
    expect(localFilePath("report.pdf:12")).toBe("report.pdf");
    expect(localFilePath("README.md:8:2")).toBe("README.md");
  });
});

describe("the pane that holds a path", () => {
  const panes = [
    { paneId: "coord", cwd: "/repo", label: "coordinator" },
    { paneId: "worker", cwd: "/repo/.worktrees/fix", label: "worker" },
    { paneId: "root", cwd: "/", label: "root shell" },
  ];
  it("picks the deepest folder that contains it, never the pane already asked", () => {
    expect(paneOwningPath(panes, "/repo/.worktrees/fix/out/board.html", "coord")?.paneId).toBe("worker");
    expect(paneOwningPath(panes, "/repo/.worktrees/fix/out/board.html", "worker")?.paneId).toBe("coord");
  });
  it("offers nobody for a relative path, a sibling folder or a root-folder pane", () => {
    expect(paneOwningPath(panes, "out/board.html", "coord")).toBeUndefined();
    expect(paneOwningPath(panes, "/repository/a.md", "x")).toBeUndefined();
    expect(paneOwningPath(panes, "/etc/hosts.txt", "x")).toBeUndefined();
  });
});
