import { imageLabel, isUploadPath, uploadName, messageMatchKey, serializeMessage, splitDraftUploads, splitMessageImages } from "./message-images";

const UP = "/home/you/.local/state/collie/uploads";
const a = `${UP}/w1-p1-mabc123-1234abcd.png`;
const b = `${UP}/w1-p1-mabc124-1234abce.jpg`;

describe("message images", () => {
  it("serializes prose then every path, the way the agent CLIs read them", () => {
    expect(serializeMessage("look at these  ", [a, b])).toBe(`look at these ${a} ${b}`);
    expect(serializeMessage("   ", [a])).toBe(a);
    expect(serializeMessage("no images\n", [])).toBe("no images");
  });

  it("splits a sent message back into prose and images without leaving paths behind", () => {
    expect(splitMessageImages(`look at these ${a} ${b}`)).toEqual({ text: "look at these", images: [a, b] });
    expect(splitMessageImages(`line one\n${a} and more`)).toEqual({ text: "line one\nand more", images: [a] });
    expect(splitMessageImages("plain text")).toEqual({ text: "plain text", images: [] });
  });

  it("round-trips through serialize and split", () => {
    const wire = serializeMessage("Still clipped here", [a, b]);
    expect(splitMessageImages(wire)).toEqual({ text: "Still clipped here", images: [a, b] });
  });

  it("only lifts Nenu's own uploads out of a stored draft; a typed image path stays prose", () => {
    const typed = "/home/you/project/screenshot.png";
    expect(isUploadPath(a)).toBe(true);
    // Where the bridge saves uploads now, beside the state dir (ADR 0098).
    expect(isUploadPath("/home/you/.local/state/nenu/uploads/w1-p1-mabc125-1234abcf.png")).toBe(true);
    expect(isUploadPath(typed)).toBe(false);
    expect(splitDraftUploads(`compare ${typed} ${a}`)).toEqual({ text: `compare ${typed}`, uploads: [a] });
  });

  it("lifts every kind of upload out of a stored draft, and names a file upload by what it was called", () => {
    const pdf = `${UP}/w1_p1-mv8g-0a1b2c3d-spec.pdf`;
    const zip = `${UP}/w1_p1-mv8g-0a1b2c3e-bundle.tar.gz`;
    const bare = `${UP}/w1_p1-mv8g-0a1b2c3f-Makefile`;
    for (const path of [pdf, zip, bare]) expect(isUploadPath(path)).toBe(true);
    expect(isUploadPath("/home/you/project/uploads/notes.pdf")).toBe(false);
    expect(splitDraftUploads(`read these ${pdf} ${a} ${zip} ${bare}`)).toEqual({ text: "read these", uploads: [pdf, a, zip, bare] });
    expect([pdf, zip, bare, a].map(uploadName)).toEqual(["spec.pdf", "bundle.tar.gz", "Makefile", null]);
  });

  it("matches a journal turn whether the harness kept the paths or swapped in [Image #N] tokens", () => {
    const sent = serializeMessage("check  this", [a]);
    expect(messageMatchKey(`check this ${a}`)).toBe(messageMatchKey(sent));
    expect(messageMatchKey("check this [Image #1]")).toBe(messageMatchKey(sent));
    expect(messageMatchKey("check this")).not.toBe(messageMatchKey(sent));
  });

  it("labels images from one", () => {
    expect([0, 1, 2].map(imageLabel)).toEqual(["Image 1", "Image 2", "Image 3"]);
  });
});
