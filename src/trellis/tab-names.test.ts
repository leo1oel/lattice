import { describe, expect, it } from "vitest";
import { tabDetails } from "./tab-names";

const details = (paths: string[]) => Object.fromEntries(tabDetails(paths));

describe("tabDetails", () => {
  it("leaves documents whose file names differ alone", () => {
    expect(details(["main.tex", "chapters/intro.tex", "refs.bib"])).toEqual({});
  });

  it("names the folder that sets two same-named documents apart", () => {
    expect(details(["chapters/intro.tex", "appendix/intro.tex", "main.tex"])).toEqual({
      "chapters/intro.tex": "chapters",
      "appendix/intro.tex": "appendix",
    });
  });

  it("goes up as many folders as it takes, the same number for every document sharing the name", () => {
    expect(details(["a/sec/intro.tex", "b/sec/intro.tex", "c/intro.tex"])).toEqual({
      "a/sec/intro.tex": "a/sec",
      "b/sec/intro.tex": "b/sec",
      "c/intro.tex": "c",
    });
  });

  it("gives a document at the project's top no detail, its namesake's setting the two apart", () => {
    expect(details(["main.tex", "old/main.tex"])).toEqual({ "old/main.tex": "old" });
  });

  it("counts a document open twice once", () => {
    expect(details(["sec/intro.tex", "sec/intro.tex"])).toEqual({});
  });
});
