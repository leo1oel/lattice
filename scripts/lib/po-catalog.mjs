// Reading the Lingui catalogs and the i18n guard's allowlist. Both are text
// files that Windows checkouts get with CRLF line endings, so every line
// split here accepts "\r\n" as well as "\n".

/** The `{ msgid, msgstr }` entries of a .po catalog, header excluded. */
export function parsePo(text) {
  const entries = [];
  let entry = null;
  let field = null;
  for (const line of text.split(/\r?\n/)) {
    const start = line.match(/^(msgid|msgstr) (".*")$/);
    if (start) {
      if (start[1] === "msgid") entries.push(entry = { msgid: "", msgstr: "" });
      field = start[1];
      entry[field] = JSON.parse(start[2]);
    } else if (entry && field && line.startsWith("\"")) {
      entry[field] += JSON.parse(line);
    } else {
      field = null;
    }
  }
  return entries.filter((item) => item.msgid);
}

/** One source string per line; blank lines and `#` comments are skipped. */
export function parseAllowlist(text) {
  return new Set(text.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith("#")));
}
