import { imageLabel, isUploadPath, messageMatchKey, serializeMessage, splitDraftUploads, splitMessageImages } from "./message-images";

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
    expect(isUploadPath(typed)).toBe(false);
    expect(splitDraftUploads(`compare ${typed} ${a}`)).toEqual({ text: `compare ${typed}`, uploads: [a] });
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
