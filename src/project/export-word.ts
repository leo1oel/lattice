import { invoke } from "@tauri-apps/api/core";
import { message, save } from "@tauri-apps/plugin-dialog";
import { msg } from "@lingui/core/macro";
import { i18n } from "../i18n";
import { showNotice, showWarning } from "../app/notify";

type Result = { path: string; warnings: string };

export async function exportWord(name: string, saveEdits: () => Promise<boolean>) {
  await message(i18n._(msg`Word export creates editable text and equations for comments and Track Changes. Pagination, custom LaTeX commands, TikZ and complex layouts may differ or be omitted. Check the exported document against your PDF before sharing. Word edits are not imported back into LaTeX.`), {
    title: i18n._(msg`Export Word`), kind: "info",
  });
  const destination = await save({
    title: i18n._(msg`Export editable Word document`),
    defaultPath: `${name.replace(/[\\/:*?"<>|]+/g, "-") || "paper"}.docx`,
    filters: [{ name: "Word", extensions: ["docx"] }],
  });
  if (!destination || !(await saveEdits())) return;
  const result = await invoke<Result>("export_word", { destination });
  showNotice(i18n._(msg`Word document exported to ${result.path}`));
  if (result.warnings.trim()) showWarning(result.warnings, i18n._(msg`Word export`));
}
