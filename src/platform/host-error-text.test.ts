/** The host's English errors, read in the interface language. */
import { afterEach, describe, expect, it } from "vitest";
import { hostErrorMessage } from "../app-utils";
import { activateAppLocale, i18n } from "../i18n";
import { hostErrorText, rustLiteralPattern } from "./host-error-text";

afterEach(async () => {
  await activateAppLocale("en");
});

describe("hostErrorText", () => {
  it("shows the high-frequency host errors in Chinese", async () => {
    await activateAppLocale("zh-CN");
    expect(hostErrorText("SyncTeX could not locate this PDF position.")).toBe("SyncTeX 无法定位 PDF 中的这个位置");
    expect(hostErrorText("No LaTeX source was found for this PDF position.")).toBe("PDF 中的这个位置没有对应的 LaTeX 源码");
    expect(hostErrorText("This file is not UTF-8 text, so Lattice cannot open it. Convert it to UTF-8 (for example, re-save it as UTF-8 in another text editor) and open it again."))
      .toMatch(/^此文件不是 UTF-8 文本/);
    expect(hostErrorText("That folder already exists and is not empty.")).toBe("该文件夹已存在且不为空");
    expect(hostErrorText("The document being compiled and its bibliography cannot be deleted.")).toBe("正在编译的主文档及其参考文献文件不能删除");
    expect(hostErrorText("The citation key “vaswani2017” already exists.")).toBe("引用名“vaswani2017”已存在");
    expect(hostErrorText("The label “fig:model” already exists.")).toBe("标签“fig:model”已存在");
  });

  it("translates a host message nested in another, down to the operating system's error", async () => {
    await activateAppLocale("zh-CN");
    expect(hostErrorText("Could not read refs.bib: No such file or directory (os error 2)")).toBe("无法读取 refs.bib：文件或文件夹不存在");
    expect(hostErrorText("Could not reach Overleaf: Permission denied (os error 13)")).toBe("无法连接 Overleaf：没有访问权限");
    // An errno the catalog does not name keeps its English.
    expect(hostErrorText("Could not read a.tex: Bad file descriptor (os error 9)")).toBe("无法读取 a.tex：Bad file descriptor (os error 9)");
  });

  it("reads a command's rejection, a bare string or an Error, the same way", async () => {
    await activateAppLocale("zh-CN");
    expect(hostErrorMessage("Open a project first.")).toBe("请先打开项目");
    expect(hostErrorMessage(new Error("Open a project first."))).toBe("请先打开项目");
  });

  it("matches each line of a toast's detail on its own", async () => {
    await activateAppLocale("zh-CN");
    expect(hostErrorText("Open a project first.\n#a1b2c3")).toBe("请先打开项目\n#a1b2c3");
  });

  it("leaves unknown text, and every message in an English interface, as it is", async () => {
    await activateAppLocale("zh-CN");
    expect(hostErrorText("latexmk exited with status 12")).toBe("latexmk exited with status 12");
    expect(hostErrorText("")).toBe("");
    await activateAppLocale("en");
    expect(i18n.locale).toBe("en");
    expect(hostErrorText("Could not read refs.bib: No such file or directory (os error 2)"))
      .toBe("Could not read refs.bib: No such file or directory (os error 2)");
  });

  it("lets the entry with the most fixed text win", () => {
    const specific = rustLiteralPattern("Could not read the arXiv title lookup: {error}");
    const general = rustLiteralPattern("Could not read {}: {message}");
    expect(specific.specificity).toBeGreaterThan(general.specificity);
    expect(general.pattern.exec("Could not read a: b: c")?.slice(1)).toEqual(["a", "b: c"]);
    expect(rustLiteralPattern("Keep {{braces}} {x:?}.").pattern.exec("Keep {braces} 1.")?.slice(1)).toEqual(["1"]);
  });
});
