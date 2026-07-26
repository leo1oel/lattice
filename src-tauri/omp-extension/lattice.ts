import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const run = promisify(execFile);

const BIBLIOGRAPHY_PATTERN = /(?:^|[\s'"=])[^\s'"<>|;&]*\.bib(?:$|[\s'"<>|;&])/i;
const READ_ONLY_COMMAND = /^\s*(?:cat|rg|grep|head|tail|wc|less|git\s+diff)\b/i;

function bibliographyPath(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const path = (input as { path?: unknown }).path;
  return typeof path === "string" && path.toLowerCase().endsWith(".bib")
    ? path
    : undefined;
}

function blockReason(target: string): string {
  return `Direct changes to ${target} are blocked by Lattice. Use the \`cite\` tool instead: it resolves the work, writes the bibliography entry, and fetches the paper's text — the same thing that happens when the user adds a paper themselves. Then use the citation key it returns.`;
}

/**
 * Adding a reference, through the one path the app itself uses.
 *
 * Lattice hands the sidecar its own executable, so this shells out to
 * `lattice cite <query>` rather than driving bibcite and arxiv2md by hand.
 * The app's import does more than write a `.bib` entry: it fetches the paper's
 * text and overview into the directory Lattice looks in, and records the change
 * as something the user can undo. A second implementation of that here would
 * have drifted from it the first time either side changed.
 */
export default function latticeExtension(omp: ExtensionAPI) {
  omp.on("tool_call", (event) => {
    if (event.toolName === "edit" || event.toolName === "write") {
      const path = bibliographyPath(event.input);
      if (path) return { block: true, reason: blockReason(path) };
    }

    if (event.toolName === "bash") {
      const command = (event.input as { command?: unknown }).command;
      const safeRead =
        typeof command === "string" &&
        READ_ONLY_COMMAND.test(command) &&
        !/[<>;|]/.test(command);
      if (
        typeof command === "string" &&
        BIBLIOGRAPHY_PATTERN.test(command) &&
        !/\bbibcite\b/i.test(command) &&
        !safeRead
      ) {
        return { block: true, reason: blockReason("a .bib file") };
      }
    }

    return undefined;
  });

  omp.registerTool({
    name: "cite",
    label: "Cite",
    description:
      "Add a work to this project's bibliography so it can be cited, and fetch its full text when there is one. Takes an arXiv id or URL, a DOI, a web page URL, or a paper title. Returns the citation key for \\cite{...}. This is the only way to change the .bib file, and it is the same path the user's own Papers box uses. Call it when a work is going to be cited — having read a paper is not a reason to call it.",
    parameters: omp.zod.object({
      query: omp.zod
        .string()
        .describe("arXiv id or URL, DOI, web page URL, or the paper's title."),
    }),
    approval: "write",
    // Top-level rather than discoverable: writing the .bib directly is blocked,
    // so a model that has not been shown this tool has no way to cite anything.
    loadMode: "essential",
    async execute(_id, params, signal) {
      const binary = process.env.LATTICE_BIN;
      if (!binary) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: "Lattice did not pass its executable path, so references cannot be added from here. Ask the user to add it through the Papers box.",
          }],
        };
      }
      try {
        const { stdout } = await run(binary, ["cite", params.query], { signal });
        const result = JSON.parse(stdout) as {
          title?: string;
          citationKey?: string | null;
          paperPath?: string;
          alreadyImported?: boolean;
        };
        const key = result.citationKey
          ? `\\cite{${result.citationKey}}`
          : "no citation key was returned";
        const opening = result.alreadyImported
          ? `"${result.title}" was already cited as ${key}.`
          : `Cited "${result.title}" as ${key}.`;
        const text = result.paperPath
          ? `${opening} Its full text is at ${result.paperPath}.`
          : `${opening} There is no full text for this one.`;
        return { content: [{ type: "text", text }] };
      } catch (reason) {
        const detail = reason instanceof Error ? reason.message : String(reason);
        return {
          isError: true,
          content: [{ type: "text", text: `Could not add that reference: ${detail}` }],
        };
      }
    },
  });
}
