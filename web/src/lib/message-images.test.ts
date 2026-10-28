import { draftFromWire, dropStrayChips, editChips, imageChip, imageLabel, insertImageChips, isSlashCommand, isUploadPath, keepChipsWhole, messageMatchKey, pathPieces, serializeDraft, serializeMessage, splitDraftUploads, splitMessageImages, tokenPieces, uploadName, withoutImages } from "./message-images";

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

describe("pictures in their places", () => {
  const chip = (n: number) => imageChip(n);

  it("a draft goes on the wire with each picture's path where its chip is, files after the prose", () => {
    const pdf = `${UP}/w1_p1-mv8g-0a1b2c3d-spec.pdf`;
    const draft = `first the red one ${chip(1)} then the blue one ${chip(2)}and that is all`;
    expect(serializeDraft(draft, [a, b], [pdf])).toBe(`first the red one ${a} then the blue one ${b} and that is all ${pdf}`);
    expect(serializeDraft(`${chip(1)}look`, [a])).toBe(`${a} look`);
    // Still uploading: no path yet, so nothing goes; a picture no chip names goes after the prose.
    expect(serializeDraft(`x ${chip(1)} y`, [null, b])).toBe(`x  y ${b}`);
  });

  it("comes back from the wire as the same chips, numbered after what the box already holds", () => {
    const pdf = `${UP}/w1_p1-mv8g-0a1b2c3d-spec.pdf`;
    const wire = `first ${a} then ${b} end ${pdf}`;
    expect(draftFromWire(wire)).toEqual({ text: `first ${chip(1)} then ${chip(2)} end`, images: [a, b], files: [pdf] });
    expect(draftFromWire(wire, [b]).text).toBe(`first ${chip(2)} then ${chip(1)} end`);
    // An old draft, every path after the prose.
    expect(draftFromWire(`look ${a} ${b}`).text).toBe(`look ${chip(1)} ${chip(2)}`);
    expect(serializeDraft(draftFromWire(wire).text, [a, b], [pdf])).toBe(wire);
  });

  it("an edit that touches a chip takes the whole chip and its picture, and renumbers the rest", () => {
    const before = `a ${chip(1)} b ${chip(2)} c`;
    // Backspace at the end of chip 1.
    const end1 = before.indexOf(chip(1)) + chip(1).length;
    const bs = keepChipsWhole(before, before.slice(0, end1 - 1) + before.slice(end1), end1 - 1);
    expect(bs).toEqual({ text: `a  b ${chip(1)} c`, removed: [1], caret: 2 });
    // A letter typed inside chip 2.
    const mid = before.indexOf(chip(2)) + 4;
    expect(keepChipsWhole(before, before.slice(0, mid) + "x" + before.slice(mid), mid + 1).removed).toEqual([2]);
    // Typing right after a chip, or right before it, leaves it alone.
    expect(keepChipsWhole(before, before.slice(0, end1) + "x" + before.slice(end1), end1 + 1)).toEqual({ text: before.slice(0, end1) + "x" + before.slice(end1), removed: [], caret: end1 + 1 });
    const start2 = before.indexOf(chip(2));
    expect(keepChipsWhole(before, before.slice(0, start2) + "x" + before.slice(start2), start2 + 1).removed).toEqual([]);
    // A selection across both, replaced.
    expect(keepChipsWhole(before, "a z c", 3)).toEqual({ text: "a z c", removed: [1, 2], caret: 3 });
  });

  it("lets chip text that names no picture leave: pasted back, brought back by undo, or past the count", () => {
    const draft = `A ${chip(1)} B ${chip(2)} C`;
    // Cut "chip 1 B": picture 1 goes, chip 2 becomes 1.
    const cutAt = draft.indexOf(chip(1));
    const cutEnd = draft.indexOf(chip(2));
    const cut = editChips(draft, draft.slice(0, cutAt) + draft.slice(cutEnd), cutAt, 2);
    expect(cut.removed).toEqual([1]);
    expect(cut.text).toBe(`A ${chip(1)} C`);
    // Paste the cut text back at the end: its chip names a picture that is gone, so it leaves.
    const pasted = `${cut.text} ${chip(1)} B`;
    expect(editChips(cut.text, pasted, pasted.length, 1)).toEqual({ text: `A ${chip(1)} C  B`, removed: [], caret: `A ${chip(1)} C  B`.length });
    expect(dropStrayChips(`x ${chip(3)} y`, 2, 0)).toEqual({ text: "x  y", caret: 0 });
    // Part of a chip copied and pasted: its blank cells and joiner leave, its letters stay words.
    expect(dropStrayChips(`a\u2800\u2800Ima b ${chip(1)}`, 1, 9)).toEqual({ text: `aIma b ${chip(1)}`, caret: 7 });
  });

  it("keeps the cursor with its words when a removal turns #10 into #9", () => {
    const draft = Array.from({ length: 10 }, (_v, i) => chip(i + 1)).join("") + "z";
    const end1 = chip(1).length;
    const after = editChips(draft, draft.slice(0, end1 - 1) + draft.slice(end1), draft.length - 1, 10);
    expect(after.removed).toEqual([1]);
    expect(after.caret).toBe(after.text.length);
  });

  it("takes pictures out by number and renumbers the rest", () => {
    expect(withoutImages(`${chip(1)} ${chip(2)} ${chip(3)}`, [2])).toBe(`${chip(1)} ${chip(2)}`);
    expect(withoutImages(`x ${chip(1)} y`, [1])).toBe("x y");
  });

  it("glues a chip into one unit no line can break: a joiner at every seam, no space a textarea breaks at", () => {
    const chip = imageChip(12);
    // Chromium and Safari break between a blank cell and a letter, and Safari's textarea at a
    // no-break space; only the joiner (U+2060) and the narrow no-break space (U+202F) sit between pieces.
    expect(chip).toBe("\u2800\u2060\u2800\u2060Image\u2060\u202f\u2060#12\u2060");
    expect(chip).not.toMatch(/[ \u00a0]/);
  });

  it("inserts chips at the caret, as they are", () => {
    expect(insertImageChips("look here.", 9, [1])).toEqual({ text: `look here${chip(1)}.`, caret: 9 + chip(1).length });
    expect(insertImageChips("", 0, [1, 2])).toEqual({ text: `${chip(1)} ${chip(2)}`, caret: chip(1).length * 2 + 1 });
    expect(serializeDraft(`look here${chip(1)}.`, [a])).toBe(`look here ${a} .`);
    // A stale cursor inside a chip puts the new one after it, never into it.
    expect(insertImageChips(`see ${chip(1)}`, 8, [2]).text).toBe(`see ${chip(1)}${chip(2)}`);
  });

  it("cuts a logged message at its tokens, the k-th token the k-th picture whatever its number", () => {
    expect(tokenPieces("first [Image #7] then [Image #8] end", 2)).toEqual([
      { kind: "text", text: "first" }, { kind: "image", image: 0 }, { kind: "text", text: "then" }, { kind: "image", image: 1 }, { kind: "text", text: "end" },
    ]);
    expect(tokenPieces("certifi[Image #7] cado", 1)).toEqual([{ kind: "text", text: "certifi" }, { kind: "image", image: 0 }, { kind: "text", text: "cado" }]);
    // A token with no picture behind it stays words.
    expect(tokenPieces("a [Image #1] b [Image #2]", 1)).toEqual([{ kind: "text", text: "a" }, { kind: "image", image: 0 }, { kind: "text", text: "b [Image #2]" }]);
  });

  it("cuts a wire text at its picture paths", () => {
    expect(pathPieces(`first ${a} then ${b}`)).toEqual({
      pieces: [{ kind: "text", text: "first" }, { kind: "image", image: 0 }, { kind: "text", text: "then" }, { kind: "image", image: 1 }],
      paths: [a, b],
    });
  });

  it("matches a journal turn sent with pictures in place", () => {
    expect(messageMatchKey(`first ${a} then ${b} end`)).toBe(messageMatchKey("first [Image #3] then [Image #4]  end"));
  });
});

// The bridge's rule (guarded-send.ts NOT_LOGGED): a command is `/name`, a path never is.
it("reads a message as a slash command only when it opens with /name", () => {
  for (const command of ["/goal merge everything", "/compact", "/plugin:skill now", "/goal\nwith a second line"]) expect(isSlashCommand(command)).toBe(true);
  for (const prose of [`${a} what is this?`, "/Users/fran/app/crash.log has the error", "/", "status /goal", "/ goal"]) expect(isSlashCommand(prose)).toBe(false);
});
