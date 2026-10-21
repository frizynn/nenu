import { claudeAdapter } from "./claude";
import { codexAdapter } from "./codex";
import { draftIsPartOfSend, hasPlacedPictures, holdsCliToken, imageTokens, pathShows, placedPicturesCarrySend, sendPieces } from "./inline-images";

const UP = "/home/you/.local/state/nenu/uploads";
const red = `${UP}/w1_p1-mv8g-0a1b2c3d.png`;
const blue = `${UP}/w1_p1-mv8g-0a1b2c3e.png`;
const pdf = `${UP}/w1_p1-mv8g-0a1b2c3f-spec.pdf`;
const sent = `first the red one ${red} then the blue one ${blue} and that is all`;

describe("pictures in their places on the wire (ADR 0104)", () => {
  it("cuts a message at Nenu's picture uploads only: a typed path and a file upload stay words", () => {
    expect(sendPieces(sent)).toEqual([
      { kind: "text", text: "first the red one " }, { kind: "image", path: red },
      { kind: "text", text: " then the blue one " }, { kind: "image", path: blue }, { kind: "text", text: " and that is all" },
    ]);
    expect(hasPlacedPictures(`see /home/you/shot.png and ${pdf}`)).toBe(false);
    expect(sendPieces(`${red}\n${blue}`)).toEqual([{ kind: "image", path: red }, { kind: "text", text: "\n" }, { kind: "image", path: blue }]);
  });

  it("counts the tokens the CLI drew", () => {
    expect(imageTokens("a [Image #4] b [Image #5]")).toBe(2);
    expect(imageTokens(null)).toBe(0);
  });

  it("reads the box Claude and Codex draw for it as the message, and nothing else", () => {
    expect(placedPicturesCarrySend(sent, "first the red one [Image #1] then the blue one [Image #2] and that is all")).toBe(true);
    // Codex spaces its tokens; a box wraps.
    expect(placedPicturesCarrySend(sent, "first the red one [Image #1]  then the blue one\n[Image #2]  and that is all")).toBe(true);
    // Claude's numbers run per session.
    expect(placedPicturesCarrySend(sent, "first the red one [Image #7] then the blue one [Image #8] and that is all")).toBe(true);
    // A token missing, in the wrong place, or the words short: not this send.
    expect(placedPicturesCarrySend(sent, "first the red one [Image #1] then the blue one and that is all")).toBe(false);
    expect(placedPicturesCarrySend(sent, "[Image #1] [Image #2] first the red one then the blue one and that is all")).toBe(false);
    expect(placedPicturesCarrySend(sent, "first the red one [Image #1] then the blue one [Image #2] and that")).toBe(false);
    expect(placedPicturesCarrySend("no pictures here", "no pictures here")).toBe(false);
  });

  it("takes a long piece as the paste token each CLI collapses it into", () => {
    const long = "word ".repeat(250);
    const message = `${red} ${long}`;
    expect(claudeAdapter.draftCarriesSend!(message, "[Image #3] [Pasted text #4]")).toBe(true);
    expect(claudeAdapter.draftCarriesSend!(`${red} short`, "[Image #3] [Pasted text #4]")).toBe(false);
    const piece = ` ${long}`;
    expect(codexAdapter.draftCarriesSend!(message, `[Image #1] [Pasted Content ${[...piece].length} chars]`)).toBe(true);
    expect(codexAdapter.draftCarriesSend!(message, "[Image #1] [Pasted Content 12 chars]")).toBe(false);
  });

  it("is something Claude and Codex do, so only they get the message piece by piece", () => {
    expect(claudeAdapter.pastesImagePaths).toBe(true);
    expect(codexAdapter.pastesImagePaths).toBe(true);
  });
});

// These decide whether the bridge presses ctrl+k and Backspaces into a live terminal (ADR 0112).
describe("what Nenu may clear from the box", () => {
  const path = "/home/you/.local/state/nenu/uploads/w1_p1-mv8g-0a1b2c3d.png";
  const sent = `look at ${path} please`;

  it.each([
    ["the start of a word", "look at"],
    ["inside a word", "lo"],
    ["inside a path", `look at ${path.slice(0, 20)}`],
    ["the path kept as text", `look at ${path}`],
    ["right after a token", "look at [Image #3]"],
    ["the whole message", "look at [Image #3] please"],
    ["a word cut where the box wrapped", "look a t [Image #3] plea se"],
  ])("is Nenu's own typing: %s", (_case, draft) => {
    expect(draftIsPartOfSend(sent, draft)).toBe(true);
  });

  it.each([
    ["an empty box", ""],
    ["no box", null],
    ["a token alone where words go", "[Image #3]"],
    ["a token where the words are", "look [Image #3] at please"],
    ["more than the message", "look at [Image #3] please and mine"],
    ["a paste token", "look at [Pasted text #1 +3 lines]"],
    ["other words", "look here"],
  ])("may be the operator's: %s", (_case, draft) => {
    expect(draftIsPartOfSend(sent, draft)).toBe(false);
  });

  it("reads a picture as text only when its path ends the box", () => {
    expect(pathShows(`look at ${path}`, path)).toBe(true);
    expect(pathShows(`look at ${path.slice(0, 30)} ${path.slice(30)}`, path)).toBe(true);
    expect(pathShows(`look at ${path} and`, path)).toBe(false);
    expect(pathShows("look at [Image #1]", path)).toBe(false);
    expect(pathShows(null, path)).toBe(false);
  });

  it.each([
    ["[Image #1] fix this", true],
    ["why does this fail [Pasted text #1 +80 lines]", true],
    ["[Pasted text #2]", true],
    ["summarise [Pasted Content 1204 chars] #2", true],
    ["fix this [Ima ge #1]", true],
    ["[Image #1 2] wrapped in its number", true],
    ["x [Pasted Content 12 04 chars]", true],
    ["[Pasted text #3 +3 li nes]", true],
    ["[Pasted text #1][Pasted text #2 +4 lines]", true],
    ["plain words [Image] and #1", false],
    ["please review the diff", false],
    ["", false],
  ])("knows a box holding what only the CLI has: %s", (draft, held) => {
    expect(holdsCliToken(draft)).toBe(held);
  });
});
