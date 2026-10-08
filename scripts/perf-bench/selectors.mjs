/**
 * The app's elements the benchmark and the smoke check wait on and click.
 * Class names, never accessible names: those are translated (the Build button
 * is 编译 in zh-CN), and `--serve` prints URLs that take `lang=zh-CN|system`,
 * so a selector on a label would fail a healthy app in Chinese.
 * src/trellis/trellis-header-tools.test.tsx pins these against the real
 * header in every language.
 */

/**
 * The active document's Build button. Every document header also lays out an
 * inert copy (`.trellis-tools-reserve`) to hold its width; that one never
 * builds, so it must neither satisfy a wait nor take a click.
 */
export const BUILD_BUTTON = "button.trellis-build-button:not(.trellis-tools-reserve *)";

/** The fixture's root document open in the editor, with its Build button up. */
export const APP_READY = `Boolean(document.querySelector(".cm-editor .cm-content") && document.querySelector(${JSON.stringify(BUILD_BUTTON)}))`;
