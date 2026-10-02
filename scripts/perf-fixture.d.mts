export interface PerfFixtureSizes {
  largeMarkdownBytes: number;
  chapterBytes: number;
  chapters: number;
  longTexBytes: number;
  notes: number;
  codeBlocks: number;
  pdfPages: number;
  logLines: number;
}

export declare const PLAYBOOK_FIXTURE: Readonly<PerfFixtureSizes>;

export declare function perfFixture(options?: Partial<PerfFixtureSizes>): {
  files: Map<string, string | Uint8Array>;
  buildLog: string;
  compiledPdf: Uint8Array;
};
