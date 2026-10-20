import { claudeAdapter } from "./claude";
import { codexAdapter } from "./codex";
import { hasPlacedPictures, imageTokens, placedPicturesCarrySend, sendPieces } from "./inline-images";

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
