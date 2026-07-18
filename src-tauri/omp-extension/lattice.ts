import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

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
  return `Direct changes to ${target} are blocked by Lattice. Read and follow the bundled bibcite skill, then use the bibcite CLI. After adding a paper, use the exact citation key returned by bibcite.`;
}

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
}
