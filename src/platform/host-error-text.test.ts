/** The host's English errors, read in the interface language. */
import { afterEach, describe, expect, it } from "vitest";
import { hostErrorMessage } from "../app-utils";
import { activateAppLocale, i18n } from "../i18n";
import { hostErrorText, rustLiteralPattern } from "./host-error-text";

afterEach(async () => {
  await activateAppLocale("en");
});

describe("hostErrorText", () => {
  // Review mode's marked PDF: where TeX stopped, in the paper's own files, in the interface language.
  it("says where the PDF with changes marked stopped building", async () => {
    await activateAppLocale("zh-CN");
    expect(hostErrorText("The PDF with changes marked did not build: TeX stopped at line 4 of main.bbl (Missing \\endcsname inserted)."))
      .toBe("标注修改的 PDF 编译失败：TeX 在 main.bbl 第 4 行出错（Missing \\endcsname inserted）。");
    expect(hostErrorText("The PDF with changes marked did not build: TeX stopped near “A sentence taken out” (Undefined control sequence)."))
      .toBe("标注修改的 PDF 编译失败：TeX 在“A sentence taken out”附近出错（Undefined control sequence）。");
  });

  it("shows the high-frequency host errors in Chinese", async () => {
    await activateAppLocale("zh-CN");
    expect(hostErrorText("SyncTeX could not locate this PDF position.")).toBe("SyncTeX 无法定位 PDF 中的这个位置");
    expect(hostErrorText("No LaTeX source was found for this PDF position.")).toBe("PDF 中的这个位置没有对应的 LaTeX 源码");
    expect(hostErrorText("This file is not UTF-8 text, so Lattice cannot open it. Convert it to UTF-8 (for example, re-save it as UTF-8 in another text editor) and open it again."))
      .toMatch(/^此文件不是 UTF-8 文本/);
    expect(hostErrorText("That folder already exists and is not empty.")).toBe("该文件夹已存在且不为空");
    expect(hostErrorText("The primary bibliography cannot be deleted.")).toBe("主参考文献文件不能删除");
    expect(hostErrorText("The citation key “vaswani2017” already exists.")).toBe("引用名“vaswani2017”已存在");
    expect(hostErrorText("The label “fig:model” already exists.")).toBe("标签“fig:model”已存在");
  });

  // The third audit's sample: each was still English in a Chinese interface.
  it("shows the setup, agent, build-root, terminal, PDF and settings errors in Chinese", async () => {
    await activateAppLocale("zh-CN");
    for (const english of [
      "Root document not found: main.tex",
      "The built-in agent did not become ready within 30 seconds.",
      "TeX Live's package manager is not installed.",
      "No supported LaTeX engine could be run as your macOS user.",
      "This terminal has closed.",
      "An encrypted PDF cannot be annotated.",
      "Name the deadline in at most 80 characters.",
      "No TeX Live package provides neurips_2026.sty. It may be a custom project or conference-template file; sync or copy it from Overleaf into the project folder.",
    ]) {
      expect(hostErrorText(english)).toMatch(/\p{Script=Han}/u);
    }
    expect(hostErrorText("Root document not found: main.tex")).toBe("找不到主文档：main.tex");
    // A main document a sync or Finder removed: which file, and where to choose another.
    expect(hostErrorText("main.tex is not in the project folder.")).toBe("main.tex 不在项目文件夹里");
    expect(hostErrorText("main.tex, the main document, is missing. Right-click another .tex file in the Project panel and choose Set as main document."))
      .toBe("主文档 main.tex 不见了。在“项目”面板里右键另一个 .tex 文件，选择“设为主文档”。");
    expect(hostErrorText("Keep the owner to at most 80 characters.")).toBe("负责人最多 80 个字符");
  });

  it("reads an argument Rust leaves empty", async () => {
    await activateAppLocale("zh-CN");
    expect(hostErrorText("The built-in agent stopped during startup with status exit status: 1."))
      .toBe("内置 AI 助手启动时退出（exit status: 1）");
    expect(hostErrorText("The built-in agent stopped during startup with status exit status: 1. Startup log: EADDRINUSE"))
      .toBe("内置 AI 助手启动时退出（exit status: 1）。启动日志：EADDRINUSE");
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
