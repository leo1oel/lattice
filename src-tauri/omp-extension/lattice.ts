import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const run = promisify(execFile);
const bibliography = /(?:^|[\s'"=])[^\s'"<>|;&]*\.bib(?:$|[\s'"<>|;&])/i;
const safeRead = /^\s*(?:cat|rg|grep|head|tail|wc|less|git\s+diff)\b/i;

function bibliographyPath(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const path = (input as { path?: unknown }).path;
  return typeof path === "string" && path.toLowerCase().endsWith(".bib")
    ? path
    : undefined;
}

function blockReason(target: string): string {
  return `Direct changes to ${target} are blocked by Lattice. Use cite, upgrade_bibliography, or remove_reference.`;
}

export default function latticeExtension(omp: ExtensionAPI) {
  omp.on("tool_call", (event) => {
    if (event.toolName === "edit" || event.toolName === "write") {
      const path = bibliographyPath(event.input);
      if (path) return { block: true, reason: blockReason(path) };
    }
    if (event.toolName === "bash") {
      const command = (event.input as { command?: unknown }).command;
      if (typeof command !== "string") return undefined;
      const readsOnly = safeRead.test(command) && !/[<>;|]/.test(command);
      if (/\bbibcite\b/i.test(command) || (bibliography.test(command) && !readsOnly)) {
        return { block: true, reason: blockReason("a .bib file") };
      }
    }
    return undefined;
  });

  async function dispatch(tool: string, params: unknown, signal?: AbortSignal) {
    const binary = process.env.LATTICE_BIN;
    if (!binary) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: "Lattice did not pass its executable path." }],
      };
    }
    try {
      const request = JSON.stringify({ tool, params });
      const { stdout } = await run(binary, ["literature", request], { signal });
      const value = JSON.parse(stdout) as Record<string, unknown>;
      let text = JSON.stringify(value, null, 2);
      if (tool === "cite") {
        const key = typeof value.citationKey === "string" ? value.citationKey : undefined;
        if (!key) throw new Error("Lattice returned no citation key.");
        const title = typeof value.title === "string" ? value.title : key;
        const path = typeof value.paperPath === "string" ? value.paperPath : "";
        text = `Cited "${title}" as \\cite{${key}}.`;
        text += path ? ` Full text: ${path}` : " This work has no cached full text.";
      }
      return { content: [{ type: "text" as const, text }] };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Lattice ${tool} failed: ${detail}` }],
      };
    }
  }

  const tools = [
    {
      name: "search_literature",
      label: "Search literature",
      description: "Search alphaXiv and OpenAlex for related academic works. Returns normalized arXiv and non-arXiv results; it does not download or cite them.",
      approval: "read" as const,
      parameters: omp.zod.object({
        query: omp.zod.string().describe("Topic, title, author, or keywords."),
        precise: omp.zod.boolean().optional().describe("Prefer a title-like search."),
        page: omp.zod.number().optional().describe("Zero-based result page."),
      }),
    },
    {
      name: "fetch_paper",
      label: "Fetch paper",
      description: "Download and cache the complete text, overview, and metadata for an arXiv paper. Reuses an existing complete copy and does not add a citation.",
      approval: "write" as const,
      parameters: omp.zod.object({
        arxivId: omp.zod.string().describe("An arXiv id or URL, optionally versioned."),
      }),
    },
    {
      name: "cite",
      label: "Cite",
      description: "Add a work to the bibliography and return the exact \\cite{...} key. Resolves current publication metadata, avoids duplicating the supplied work, and reuses or fetches arXiv full text.",
      approval: "write" as const,
      parameters: omp.zod.object({
        query: omp.zod.string().describe("An arXiv id, DOI, URL, or title."),
      }),
    },
    {
      name: "upgrade_bibliography",
      label: "Upgrade bibliography",
      description: "Find published versions of preprints in the bibliography and update them while preserving citation keys. Use dry-run mode to preview changes.",
      approval: "write" as const,
      parameters: omp.zod.object({
        dryRun: omp.zod.boolean().optional().describe("Preview without writing or recording history."),
      }),
    },
    {
      name: "remove_reference",
      label: "Remove reference",
      description: "Remove one bibliography entry by citation key while keeping downloaded paper files. The removal fails if the manuscript still cites that key.",
      approval: "write" as const,
      parameters: omp.zod.object({
        key: omp.zod.string().describe("Citation key to remove."),
      }),
    },
  ];

  for (const tool of tools) {
    omp.registerTool({
      ...tool,
      loadMode: "essential",
      execute: (_id, params, signal) => dispatch(tool.name, params, signal),
    });
  }
}
