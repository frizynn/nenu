import { baseName, crumbs, expandPath, matchDirs, parseQuery, tildePath } from "./dir-picker";

describe("dir-picker helpers", () => {
  it("shortens and expands paths under home only", () => {
    expect(tildePath("/Users/me", "/Users/me")).toBe("~");
    expect(tildePath("/Users/me/code/app", "/Users/me")).toBe("~/code/app");
    expect(tildePath("/Users/meadow/x", "/Users/me")).toBe("/Users/meadow/x");
    expect(tildePath("/srv", "")).toBe("/srv");
    expect(expandPath("~/code", "/Users/me")).toBe("/Users/me/code");
    expect(expandPath("/srv", "/Users/me")).toBe("/srv");
  });

  it("splits the typed path into the folder to list and the filter", () => {
    expect(parseQuery("~")).toEqual({ dir: "~", filter: "" });
    expect(parseQuery("~/")).toEqual({ dir: "~/", filter: "" });
    expect(parseQuery("~/code/aw")).toEqual({ dir: "~/code/", filter: "aw" });
    expect(parseQuery("/srv/")).toEqual({ dir: "/srv/", filter: "" });
    expect(parseQuery("api")).toEqual({ dir: "", filter: "api" });
  });

  it("ranks prefix matches before substring matches, ignoring case", () => {
    expect(matchDirs(["Awam", "web", "api", "nenu-web"], "W")).toEqual(["web", "Awam", "nenu-web"]);
    expect(matchDirs(["a", "b"], "")).toEqual(["a", "b"]);
  });

  it("builds tappable steps for home-relative and absolute folders", () => {
    expect(crumbs("~")).toEqual([{ label: "~", query: "~/" }]);
    expect(crumbs("~/code/awam")).toEqual([
      { label: "~", query: "~/" },
      { label: "code", query: "~/code/" },
      { label: "awam", query: "~/code/awam/" },
    ]);
    expect(crumbs("/srv/data").map((c) => c.query)).toEqual(["/", "/srv/", "/srv/data/"]);
    expect([baseName("~/code/awam/"), baseName("~"), baseName("/")]).toEqual(["awam", "~", "/"]);
  });
});
