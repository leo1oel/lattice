import { describe, expect, it } from "vitest";
import { applyLibraryChanges, compareLibrary, ENTRY_TYPE_FIELD } from "./linked-library";

const BASE = `@article{vaswani2017,
  title = {Attention Is All You Need},
  author = {Vaswani, Ashish and Shazeer, Noam},
  year = {2017},
  doi = {10.5555/3295222.3295349},
}

@misc{kingma2014,
  title = {Adam: A Method for Stochastic Optimization},
  author = {Kingma, Diederik P. and Ba, Jimmy},
  year = {2014},
  eprint = {1412.6980},
  archivePrefix = {arXiv},
}
`;

const compare = (base: string | null, library: string, local: string, cited: string[] = []) => compareLibrary({
  base, library, local, libraryName: "My Library.bib", localName: "references.bib", cited: new Set(cited),
});

describe("compareLibrary", () => {
  it("offers a field the library changed as an update, and the entry keeps its key", () => {
    const library = BASE.replace("year = {2017}", "year = {2018},\n  pages = {5998--6008}");
    const changes = compare(BASE, library, BASE);
    expect(changes).toEqual([expect.objectContaining({
      kind: "updated", key: "vaswani2017",
      fields: [
        { name: "year", local: "2017", library: "2018", conflict: false },
        { name: "pages", local: null, library: "5998--6008", conflict: false },
      ],
    })]);
    const next = applyLibraryChanges(BASE, library, changes);
    // A field new to the entry goes after its last, laid out like the rest.
    expect(next).toContain("year = {2018},\n  doi = {10.5555/3295222.3295349},\n  pages = {5998--6008},\n}");
    // The other entry is untouched, byte for byte.
    expect(next.slice(next.indexOf("@misc"))).toBe(BASE.slice(BASE.indexOf("@misc")));
    // Taken in, the same library has nothing more to offer.
    expect(compare(library, library, next)).toEqual([]);
  });

  it("never offers a field only the writer changed, and shows both sides when both did", () => {
    const local = BASE.replace("Attention Is All You Need", "Attention Is {All} You Need");
    expect(compare(BASE, BASE, local)).toEqual([]);
    const library = BASE.replace("Attention Is All You Need", "Attention is all you need").replace("year = {2017}", "year = {2018}");
    const changes = compare(BASE, library, local);
    // The library's own update comes apart from the field the writer changed too.
    expect(changes).toEqual([
      expect.objectContaining({ id: "entry:vaswani2017", kind: "updated", fields: [{ name: "year", local: "2017", library: "2018", conflict: false }] }),
      expect.objectContaining({
        id: "conflict:vaswani2017", kind: "conflict",
        fields: [{ name: "title", local: "Attention Is {All} You Need", library: "Attention is all you need", conflict: true }],
      }),
    ]);
    const updateOnly = applyLibraryChanges(local, library, [changes[0]]);
    expect(updateOnly).toContain("title = {Attention Is {All} You Need},");
    expect(updateOnly).toContain("year = {2018},");
    const both = applyLibraryChanges(local, library, changes);
    expect(both).toContain("title = {Attention is all you need},");
    expect(both).toContain("year = {2018},");
    expect(compare(library, library, both)).toEqual([]);
  });

  it("matches a paper whose key the library renamed by its DOI or arXiv id, keeping the key here", () => {
    const library = BASE.replace("vaswani2017", "Vaswani_Attention_2017").replace("{kingma2014", "{kingmaAdam").replace("year = {2014}", "year = {2015}");
    const changes = compare(BASE, library, BASE);
    expect(changes.map((change) => [change.kind, change.key])).toEqual([["updated", "kingma2014"]]);
    expect(applyLibraryChanges(BASE, library, changes)).toContain("@misc{kingma2014,\n  title = {Adam: A Method for Stochastic Optimization},\n  author = {Kingma, Diederik P. and Ba, Jimmy},\n  year = {2015},");
  });

  it("matches a paper with neither id by its title and year when the library renamed its key", () => {
    const local = BASE.replace("  doi = {10.5555/3295222.3295349},\n", "");
    const library = local.replace("vaswani2017", "vaswaniAttention").replace("Shazeer, Noam}", "Shazeer, Noam and Parmar, Niki}");
    const changes = compare(local, library, local);
    expect(changes.map((change) => [change.kind, change.key])).toEqual([["updated", "vaswani2017"]]);
    const next = applyLibraryChanges(local, library, changes);
    expect(next).toContain("@article{vaswani2017,\n  title = {Attention Is All You Need},\n  author = {Vaswani, Ashish and Shazeer, Noam and Parmar, Niki},");
    expect(next).not.toContain("vaswaniAttention");
  });

  it.each([["published first", true], ["preprint first", false]])("offers a published version sharing its preprint's title as new (%s)", (_order, conferenceFirst) => {
    const preprint = "@misc{foo_arxiv,\n  title = {Foo Bar},\n  year = {2023},\n  eprint = {2301.00001},\n  archivePrefix = {arXiv},\n}\n";
    const conference = "@inproceedings{foo_conf,\n  title = {Foo Bar},\n  year = {2023},\n  booktitle = {ICML},\n}\n";
    const updated = preprint.replace("@misc{foo_arxiv,", "@misc{foo_arxiv,\n  note = {v2},");
    const library = conferenceFirst ? `${conference}\n${updated}` : `${updated}\n${conference}`;
    for (const base of [preprint, null]) {
      const changes = compare(base, library, preprint);
      expect(changes).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "new", key: "foo_conf" }),
        expect.objectContaining({ key: "foo_arxiv", libraryKey: "foo_arxiv", fields: [{ name: "note", local: null, library: "v2", conflict: false }] }),
      ]));
      expect(changes).toHaveLength(2);
    }
    const next = applyLibraryChanges(preprint, library, compare(preprint, library, preprint));
    expect(next).toContain("@misc{foo_arxiv,\n  title = {Foo Bar},");
    expect(next).toContain("@inproceedings{foo_conf,");
  });

  it("lets a later entry's DOI win over an earlier one's title and year", () => {
    const local = "@article{smith2020,\n  title = {Deep Nets},\n  year = {2020},\n  doi = {10.1/x},\n}\n";
    const preprint = "@misc{smithDeepNets2020,\n  title = {Deep Nets},\n  year = {2020},\n  eprint = {2001.00001},\n  archivePrefix = {arXiv},\n}\n";
    const published = "@article{smithDeepNets2020a,\n  title = {Deep Nets},\n  year = {2020},\n  doi = {10.1/x},\n  pages = {1--9},\n}\n";
    const changes = compare(null, `${preprint}\n${published}`, local);
    expect(changes).toEqual([
      expect.objectContaining({ kind: "new", key: "smithDeepNets2020" }),
      expect.objectContaining({ key: "smith2020", libraryKey: "smithDeepNets2020a", fields: [{ name: "pages", local: null, library: "1--9", conflict: false }] }),
    ]);
  });

  it("says when the library dropped a paper whose title another one shares", () => {
    const preprint = "@misc{foo_arxiv,\n  title = {Foo Bar},\n  year = {2023},\n}\n";
    const conference = "@inproceedings{foo_conf,\n  title = {Foo Bar},\n  year = {2023},\n}\n";
    expect(compare(`${preprint}\n${conference}`, conference, `${preprint}\n${conference}`))
      .toEqual([expect.objectContaining({ kind: "removed", key: "foo_arxiv" })]);
  });

  it("applies an update matched only through the base, after the writer removed the DOI here", () => {
    const local = BASE.replace("  doi = {10.5555/3295222.3295349},\n", "").replace("Attention Is All You Need", "Attention, mine");
    const library = BASE.replace("vaswani2017", "Vaswani_2017").replace("year = {2017}", "year = {2018}");
    const changes = compare(BASE, library, local);
    expect(changes).toEqual([expect.objectContaining({ kind: "updated", key: "vaswani2017", libraryKey: "Vaswani_2017" })]);
    expect(applyLibraryChanges(local, library, changes)).toContain("year = {2018},");
  });

  it("writes out the library's @string macros, which the project may not define", () => {
    const library = `@string{jmlr = {Journal of Machine Learning Research}}\n\n${BASE}`
      .replace("year = {2017}", "year = {2018},\n  journal = {The } # jmlr")
      .concat("\n@article{he2016,\n  title = {Deep Residual Learning},\n  journal = jmlr,\n  month = jun,\n  year = 2016,\n}\n");
    const changes = compare(BASE, library, BASE);
    const next = applyLibraryChanges(BASE, library, changes);
    expect(next).toContain("  journal = {The Journal of Machine Learning Research},\n");
    expect(next).toContain("@article{he2016,\n  title = {Deep Residual Learning},\n  journal = {Journal of Machine Learning Research},\n  month = jun,\n  year = 2016,\n}\n");
    expect(next).not.toContain("@string");
  });

  it("takes in a published version's entry type", () => {
    const library = BASE.replace("@misc{kingma2014", "@inproceedings{kingma2014").replace("archivePrefix = {arXiv},", "archivePrefix = {arXiv},\n  booktitle = {ICLR},");
    const changes = compare(BASE, library, BASE);
    expect(changes[0].fields.map((field) => field.name)).toEqual([ENTRY_TYPE_FIELD, "booktitle"]);
    const next = applyLibraryChanges(BASE, library, changes);
    expect(next).toContain("@inproceedings{kingma2014,");
    expect(next).toContain("  archivePrefix = {arXiv},\n  booktitle = {ICLR},\n}");
  });

  it("adds a new paper once: declined, it is not offered again", () => {
    const library = `${BASE}\n@article{he2016,\n  title = {Deep Residual Learning},\n  year = {2016},\n}\n`;
    const changes = compare(BASE, library, BASE);
    expect(changes).toEqual([expect.objectContaining({ kind: "new", key: "he2016", title: "Deep Residual Learning" })]);
    const next = applyLibraryChanges(BASE, library, changes);
    expect(next.endsWith("}\n\n@article{he2016,\n  title = {Deep Residual Learning},\n  year = {2016},\n}\n")).toBe(true);
    expect(compare(library, library, next)).toEqual([]);
    // Not taken in, but the base moved on: the writer said no.
    expect(compare(library, library, BASE)).toEqual([]);
  });

  it("says when the library dropped a paper, and never removes one the paper cites", () => {
    const library = BASE.slice(BASE.indexOf("@misc"));
    const changes = compare(BASE, library, BASE, ["vaswani2017"]);
    expect(changes).toEqual([expect.objectContaining({ kind: "removed", key: "vaswani2017", cited: true })]);
    expect(applyLibraryChanges(BASE, library, changes)).toBe(BASE);
    const uncited = compare(BASE, library, BASE);
    expect(applyLibraryChanges(BASE, library, uncited)).toBe(library);
    // When the citations cannot be read, every dropped paper counts as cited.
    const unknown = compareLibrary({ base: BASE, library, local: BASE, libraryName: "My Library.bib", localName: "references.bib", cited: null });
    expect(unknown).toEqual([expect.objectContaining({ kind: "removed", cited: true })]);
    expect(applyLibraryChanges(BASE, library, unknown)).toBe(BASE);
  });

  it("before the first update, settles every difference with the writer and adds what is missing", () => {
    const library = BASE.replace("year = {2017}", "year = {2018}").replace("Kingma, Diederik P. and Ba, Jimmy", "Kingma, D. P. and Ba, J.");
    const local = `${BASE.slice(0, BASE.indexOf("@misc"))}`.replace("doi = {10.5555/3295222.3295349},\n", "doi = {10.5555/3295222.3295349},\n  note = {Mine},\n");
    const changes = compare(null, library, local);
    expect(changes.map((change) => [change.kind, change.key])).toEqual([["conflict", "vaswani2017"], ["new", "kingma2014"]]);
    // A field only here (note) is the writer's own.
    expect(changes[0].fields.map((field) => field.name)).toEqual(["year"]);
  });

  it("names the file that cannot be read", () => {
    expect(() => compare(BASE, "@article{broken,\n  title = {x\n", BASE)).toThrow(/My Library\.bib can't be read/);
  });
});
