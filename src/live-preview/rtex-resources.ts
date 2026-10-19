// Adapted from realtime-tex-vsc-plugin (https://github.com/HenryXiaoYang/realtime-tex-vsc-plugin),
// src/resources.ts, MIT License, Copyright (c) 2026 Henry Yang; see THIRD_PARTY_NOTICES.md.
//
// Loading the font and image files display lists refer to. The plugin reads
// them with Node; here the host reads them (live_preview_read_file, which
// finds TeX fonts with kpsewhich and refuses anything that is not a font, an
// encoding, a map file or a project image) and this module turns the bytes
// into what the renderer draws.
import { fontKey, type FontResource, type ImageResource } from "./rtex-render";
import type { DisplayList, FontDesc } from "./rtex-protocol";
import { parseEncFile, parseMapFile, type1Outlines, type MapEntry } from "./rtex-type1";

/** Reads a file through the host: `kind` is "font" or "image". */
export type ReadFile = (kind: "font" | "image", path: string) => Promise<Uint8Array>;

const message = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

export class ResourceLoader {
  private mapFile: Promise<Map<string, MapEntry>> | undefined;
  private fonts = new Map<string, Promise<FontResource>>();
  private images = new Map<string, Promise<ImageResource>>();

  constructor(private readonly read: ReadFile) {}

  /** Font resources needed by `dls` that are not in `have`, keyed by fontKey. */
  async fontsFor(dls: readonly DisplayList[], have: (key: string) => boolean): Promise<Map<string, FontResource>> {
    const want = new Map<string, FontDesc>();
    for (const dl of dls) {
      for (const desc of Object.values(dl.fonts ?? {})) {
        const k = fontKey(desc);
        if (!have(k) && !want.has(k)) want.set(k, desc);
      }
    }
    const out = new Map<string, FontResource>();
    await Promise.all([...want].map(async ([k, desc]) => {
      out.set(k, await this.font(k, desc));
    }));
    return out;
  }

  /** Image files referenced by `dls` (images_info) that are not in `have`, keyed by file name. */
  async imagesFor(dls: readonly DisplayList[], have: (file: string) => boolean): Promise<Map<string, { resource: ImageResource; page: number }>> {
    const want = new Map<string, number>();
    for (const dl of dls) {
      for (const info of Object.values(dl.images_info ?? {})) {
        // cached pictures live in the pass PDF, which draws their (degraded) page
        if (info.file && !info.cached_picture && !have(info.file)) want.set(info.file, info.page ?? 1);
      }
    }
    const out = new Map<string, { resource: ImageResource; page: number }>();
    await Promise.all([...want].map(async ([file, page]) => {
      out.set(file, { resource: await this.image(file), page });
    }));
    return out;
  }

  private font(key: string, desc: FontDesc): Promise<FontResource> {
    let p = this.fonts.get(key);
    if (!p) {
      p = this.loadFont(desc).catch((reason: unknown): FontResource => ({ kind: "missing", reason: message(reason) }));
      this.fonts.set(key, p);
    }
    return p;
  }

  private async loadFont(desc: FontDesc): Promise<FontResource> {
    if (desc.filename) {
      const lower = desc.filename.toLowerCase();
      if (/\.(otf|ttf|ttc|otc)$/.test(lower)) return { kind: "sfnt", data: await this.read("font", desc.filename) };
      if (/\.(pfb|pfa)$/.test(lower)) {
        const entry = desc.name ? (await this.map()).get(desc.name) : undefined;
        return this.loadType1(desc.filename, entry);
      }
      return { kind: "missing", reason: `unsupported font format: ${desc.filename}` };
    }
    const name = desc.name ?? "";
    const entry = (await this.map()).get(name);
    if (!entry?.fontFile) return { kind: "missing", reason: `no outline font for ${name} in pdftex.map` };
    if (/\.(otf|ttf)$/i.test(entry.fontFile)) return { kind: "missing", reason: `TFM font mapped to OpenType (${entry.fontFile})` };
    return this.loadType1(entry.fontFile, entry);
  }

  private async loadType1(file: string, entry: MapEntry | undefined): Promise<FontResource> {
    let encoding: string[] | undefined;
    if (entry?.encFile) {
      const enc = await this.read("font", entry.encFile).catch(() => null);
      if (enc) encoding = parseEncFile(new TextDecoder("latin1").decode(enc));
    }
    const { upem, glyphs } = type1Outlines(await this.read("font", file), encoding);
    return { kind: "type1", upem, glyphs, slant: entry?.slant, extend: entry?.extend };
  }

  private image(file: string): Promise<ImageResource> {
    let p = this.images.get(file);
    if (!p) {
      p = this.loadImage(file);
      this.images.set(file, p);
    }
    return p;
  }

  private async loadImage(file: string): Promise<ImageResource> {
    const extension = file.toLowerCase().split(".").pop() ?? "";
    const mime = extension === "png" ? "image/png" : extension === "jpg" || extension === "jpeg" ? "image/jpeg" : extension === "pdf" ? "application/pdf" : "";
    if (!mime) return { kind: "missing", reason: `unsupported image format .${extension}` };
    try {
      const data = await this.read("image", file);
      return { kind: mime === "application/pdf" ? "pdf" : "bitmap", mime, data };
    } catch (reason) {
      return { kind: "missing", reason: message(reason) };
    }
  }

  private map(): Promise<Map<string, MapEntry>> {
    this.mapFile ??= this.read("font", "pdftex.map")
      .then((bytes) => parseMapFile(new TextDecoder().decode(bytes)))
      // Without it, Type 1 (TFM) fonts are drawn from the PDF instead.
      .catch(() => new Map<string, MapEntry>());
    return this.mapFile;
  }
}
