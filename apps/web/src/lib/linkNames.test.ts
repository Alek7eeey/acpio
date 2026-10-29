import { describe, it, expect } from "vitest";
import { splitLinkNames } from "./linkNames";

// The composers paint an attached file's name as the link it is, and this is
// the split both of them paint (a textarea cannot colour a range of its text).
describe("splitLinkNames", () => {
  it("marks the run that is a file's name and leaves the rest alone", () => {
    expect(splitLinkNames("посмотри shot.png и всё", ["shot.png"])).toEqual([
      { text: "посмотри ", link: false },
      { text: "shot.png", link: true },
      { text: " и всё", link: false },
    ]);
  });

  it("marks every mention, not only the first", () => {
    const runs = splitLinkNames("shot.png и ещё раз shot.png", ["shot.png"]);

    expect(runs.filter((run) => run.link).map((run) => run.text)).toEqual(["shot.png", "shot.png"]);
  });

  // A name that begins another one must still be found whole: the longest wins,
  // or the short one would split the long one down the middle.
  it("prefers the longest of two names that start alike", () => {
    const runs = splitLinkNames("файл shot-final.png тут", ["shot.png", "shot-final.png"]);

    expect(runs.filter((run) => run.link).map((run) => run.text)).toEqual(["shot-final.png"]);
  });

  // A name is text, not a pattern: a dot, a bracket or a plus in it is a
  // character of the file name and nothing else.
  it("treats a name with regex characters as text", () => {
    const name = "shot (1)+final.png";
    const runs = splitLinkNames(`вот ${name} и всё`, [name]);

    expect(runs).toEqual([
      { text: "вот ", link: false },
      { text: name, link: true },
      { text: " и всё", link: false },
    ]);
  });

  it("returns the text whole when no name is in it", () => {
    expect(splitLinkNames("просто текст", ["shot.png"])).toEqual([
      { text: "просто текст", link: false },
    ]);
  });

  it("returns nothing for an empty text", () => {
    expect(splitLinkNames("", ["shot.png"])).toEqual([]);
  });
});
