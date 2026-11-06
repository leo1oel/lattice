import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { InlineEdits } from "../components/ui/inline-edits";
import { activateAppLocale } from "../i18n";
import { typesetBibFix } from "./reference-typeset";

afterEach(async () => { cleanup(); await activateAppLocale("en"); });

const before = "@article{tay2022efficient, title={Efficient Transformers: A Survey}, author={Tay, Yi and Dehghani, Mostafa and Bahri, Dara and Metzler, Donald}, journal={ACM Computing Surveys}, year={2022}}";
const after = before.replace("year={2022}", "volume={55}, pages={1--28}, doi={10.1145/3530811}, year={2022}");
const changes = [
  { field: "doi", before: "", after: "10.1145/3530811" },
  { field: "pages", before: "", after: "1--28" },
  { field: "volume", before: "", after: "55" },
];

it("prints the reference and its field names in English in a Chinese interface", async () => {
  await activateAppLocale("zh-CN");
  const fix = typesetBibFix(before, after, changes);
  expect(fix.text).toBe("Yi Tay, Mostafa Dehghani, Dara Bahri et al. Efficient Transformers: A Survey. ACM Computing Surveys, 2022.");
  expect(fix.edits).toMatchObject([{ insert: "vol. 55, pp. 1–28, ", tag: "pages, volume" }]);
  expect(fix.unprinted).toEqual(["DOI"]);
});

it("keeps an edit's tag beside its words, not glued to the next one", () => {
  const fix = typesetBibFix(before, after, changes);
  const { container } = render(<InlineEdits text={fix.text} edits={fix.edits} />);
  // The tag follows the inserted words; the space that ended them follows the tag.
  expect(container.textContent).toBe("Yi Tay, Mostafa Dehghani, Dara Bahri et al. Efficient Transformers: A Survey. ACM Computing Surveys, vol. 55, pp. 1–28,⁠pages, volume 2022.");
});
