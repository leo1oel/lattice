import type { CatalogV2 } from "../protocol/collab-v2";
import type { CollabCredentialStore } from "./collab-credentials";
import { createCredentialRef } from "./collab-credentials";
import { loadCollabFeaturePolicy, type CollabFeaturePolicy } from "./collab-feature-policy";

export type ImportFileV2 = { fileId: string; path: string; kind: "text" | "binary" | "board"; size: number; hash: string; bytes: Uint8Array; contentType?: string };
export type NativeImportSourceV2 = { inventory(): Promise<Array<{ path: string; kind?: "text" | "binary" }>>; read(path: string): Promise<Uint8Array> };
export type ImportProjectRecordV2 = { version: 2; deployment: string; projectInstanceId: string; credentialRef: string };
export type ImportResumeV2 = { projectInstanceId: string; credentialRef: string; manifestHash: string; operationId: string; fileIds: Record<string, string>; completed: string[]; error: string };
export class CollabImportV2Error extends Error { constructor(message: string, readonly resume: ImportResumeV2, cause?: unknown) { super(message, { cause }); } }
export type ImportV2Options = { deployment: string; projectName?: string; source: NativeImportSourceV2; credentialStore: CollabCredentialStore; fetch?: typeof fetch; projectInstanceId?: string; idFactory?: () => string; resume?: ImportResumeV2; policy?: CollabFeaturePolicy; onPhase?: (phase: "importing") => void; onPrepareProgress?: (completed: number, total: number) => void; onProgress?: (completed: number, total: number) => void; onRecord: (record: ImportProjectRecordV2) => Promise<void> };

export class TextImportErrorV2 extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`text_import_failed: ${code} (${status})`);
  }
}

const IMPORT_CONCURRENCY = 8;

export async function canonicalImportManifestHash(entries: Omit<ImportFileV2, "bytes" | "contentType">[]): Promise<string> { return sha(new TextEncoder().encode(canonicalJson(entries))); }

export async function createProjectV2(options: ImportV2Options): Promise<ImportProjectRecordV2> { return run(options); }

async function run(options: ImportV2Options): Promise<ImportProjectRecordV2> {
  const policy = options.policy ?? loadCollabFeaturePolicy();
  if (policy.emergencyDisableWrites) throw new Error("collaboration_writes_disabled");
  if (!policy.allowCreateV2) throw new Error("v2_creation_disabled");
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis); const id = options.resume?.projectInstanceId ?? options.projectInstanceId ?? randomId(); const credentialRef = options.resume?.credentialRef ?? createCredentialRef(); const secret = options.resume ? await options.credentialStore.get(credentialRef, id, options.deployment) : randomSecret(); if (!secret) throw new Error("Import resume credential is unavailable"); const completed: string[] = [...(options.resume?.completed ?? [])]; let manifestHash = options.resume?.manifestHash ?? ""; const importOperationId = options.resume?.operationId ?? options.idFactory?.() ?? crypto.randomUUID(); let fileIds = { ...(options.resume?.fileIds ?? {}) }; let remoteRequestStarted = false;
  try {
    if (!options.resume) await options.credentialStore.put(credentialRef, secret, id, options.deployment);
    const files = await buildFiles(options.source, fileIds, options.onPrepareProgress); fileIds = Object.fromEntries(files.map((file) => [file.path, file.fileId]));
    const plain = files.map(({ bytes: _bytes, contentType: _type, ...entry }) => entry); const computedManifestHash = await canonicalImportManifestHash(plain); if (manifestHash && manifestHash !== computedManifestHash) throw new Error("resume_manifest_changed"); manifestHash = computedManifestHash;
    remoteRequestStarted = true;
    let catalog = await getCatalog(fetcher, options.deployment, id, secret).catch(() => undefined);
    if (!catalog) { const response = await jsonFetch(fetcher, projectUrl(options.deployment, id, "bootstrap"), { projectInstanceId: id, projectName: options.projectName, hostSecret: secret, importManifest: plain, expectedManifestHash: manifestHash, operationId: importOperationId }); if (!response.ok) throw new Error("v2_bootstrap_failed"); catalog = await response.json() as CatalogV2; }
    if (catalog.lifecycle === "live") { await options.onRecord({ version: 2, deployment: options.deployment, projectInstanceId: id, credentialRef }); return { version: 2, deployment: options.deployment, projectInstanceId: id, credentialRef }; }
    let progress = 0;
    const pending = files.filter((file) => {
      const alreadyLive = catalog!.files.some((item) => item.fileId === file.fileId && item.state === "live");
      if (alreadyLive) { completed.push(file.fileId); progress += 1; }
      return !alreadyLive;
    });
    options.onProgress?.(progress, files.length);
    const textFiles = pending.filter((file) => file.kind !== "binary");
    for (let offset = 0; offset < textFiles.length; offset += IMPORT_CONCURRENCY) {
      const results = await Promise.allSettled(textFiles.slice(offset, offset + IMPORT_CONCURRENCY).map(async (file) => {
        const operationId = `import_${file.fileId}`.replace(/[^A-Za-z0-9_-]/g, "_");
        await putTextFileV2({ fetch: fetcher, deployment: options.deployment, projectInstanceId: id, credential: secret, fileId: file.fileId, documentEpoch: 1, bytes: file.bytes, hash: file.hash, operationId });
        completed.push(file.fileId); options.onProgress?.(++progress, files.length);
      }));
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    }
    if (textFiles.length) catalog = await getCatalog(fetcher, options.deployment, id, secret);
    for (const file of pending.filter((entry) => entry.kind === "binary")) {
      const operationId = `import_${file.fileId}`.replace(/[^A-Za-z0-9_-]/g, "_");
      await putBinary(fetcher, options.deployment, id, secret, file, catalog.catalogRevision, operationId);
      completed.push(file.fileId); options.onProgress?.(++progress, files.length);
      catalog = await getCatalog(fetcher, options.deployment, id, secret);
    }
    verifyCatalog(catalog, plain); const finalized = await jsonFetch(fetcher, projectUrl(options.deployment, id, "import-finalize"), { operationId: `finalize_${importOperationId}`, expectedCatalogRevision: catalog.catalogRevision, importOperationId, expectedManifestHash: manifestHash }, secret); if (!finalized.ok) throw new Error("v2_finalize_failed");
    catalog = await getCatalog(fetcher, options.deployment, id, secret); if (catalog.lifecycle !== "live") throw new Error("v2_not_live");
    const record = { version: 2 as const, deployment: options.deployment, projectInstanceId: id, credentialRef }; await options.onRecord(record); return record;
  } catch (error) { const resume = { projectInstanceId: id, credentialRef, manifestHash, operationId: importOperationId, fileIds, completed, error: error instanceof Error ? error.message : String(error) }; if (!remoteRequestStarted && !options.resume) await options.credentialStore.delete(credentialRef, id, options.deployment).catch(() => {}); throw new CollabImportV2Error(resume.error, resume, error); }
}

async function buildFiles(source: NativeImportSourceV2, resumedIds: Record<string, string> = {}, onProgress?: (completed: number, total: number) => void): Promise<ImportFileV2[]> {
  const inventory = await source.inventory(); const seen = new Set<string>();
  const entries = inventory.map((item) => { const path = safePath(item.path); const folded = path.toLocaleLowerCase("en-US"); if (seen.has(folded)) throw new Error("path_case_collision"); seen.add(folded); return { ...item, path }; });
  let completed = 0; onProgress?.(completed, entries.length);
  const out: ImportFileV2[] = [];
  for (let offset = 0; offset < entries.length; offset += IMPORT_CONCURRENCY) {
    out.push(...await Promise.all(entries.slice(offset, offset + IMPORT_CONCURRENCY).map(async (item) => { const bytes = await source.read(item.path); const kind = item.kind ?? (isUtf8(bytes) ? "text" : "binary"); const file = { fileId: resumedIds[item.path] ?? await stableFileId(item.path), path: item.path, kind: kind === "text" && item.path.toLocaleLowerCase("en-US").endsWith(".tldr") ? "board" as const : kind, size: bytes.length, hash: await sha(bytes), bytes, contentType: kind === "binary" ? "application/octet-stream" : undefined }; onProgress?.(++completed, entries.length); return file; })));
  }
  return out.sort((a,b) => a.path.localeCompare(b.path));
}
function verifyCatalog(catalog: CatalogV2, manifest: Omit<ImportFileV2,"bytes"|"contentType">[]) { if (catalog.files.length !== manifest.length) throw new Error("catalog_manifest_mismatch"); for (const entry of manifest) { const file = catalog.files.filter(item => item.path === entry.path); if (file.length !== 1 || file[0].fileId !== entry.fileId || file[0].size !== entry.size || file[0].hash !== entry.hash || file[0].state !== "live") throw new Error("catalog_manifest_mismatch"); } }
export async function putTextFileV2(options: { fetch?: typeof fetch; deployment: string; projectInstanceId: string; credential: string; fileId: string; documentEpoch: number; bytes: Uint8Array; hash?: string; operationId: string }): Promise<{ size: number; hash: string }> {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const hash = options.hash ?? await sha(options.bytes);
  const response = await fetcher(projectUrl(options.deployment, options.projectInstanceId, `text/imports/${encodeURIComponent(options.fileId)}`), {
    method: "PUT",
    headers: { ...auth(options.credential), "x-document-epoch": String(options.documentEpoch), "x-content-sha256": hash, "x-operation-id": options.operationId },
    body: options.bytes,
  });
  if (!response.ok) {
    let code = response.statusText || "unknown_error";
    try {
      const body = await response.json() as { error?: unknown };
      if (typeof body.error === "string" && body.error) code = body.error;
    } catch { /* preserve the HTTP fallback */ }
    throw new TextImportErrorV2(response.status, code);
  }
  return { size: options.bytes.byteLength, hash };
}
async function putBinary(f:typeof fetch,d:string,id:string,s:string,x:ImportFileV2,rev:number,op:string){const t=await jsonFetch(f,projectUrl(d,id,"binary/upload-tickets"),{fileId:x.fileId,documentEpoch:1,declaredHash:x.hash,declaredSize:x.size,contentType:x.contentType,expectedCatalogRevision:rev,expectedContentRevision:0,operationId:op,import:true},s);if(!t.ok)throw new Error("binary_ticket_failed");const ticket=(await t.json() as {ticket:string}).ticket;const u=await f(projectUrl(d,id,`binary/uploads/${encodeURIComponent(ticket)}`),{method:"PUT",headers:{"content-type":x.contentType!},body:x.bytes});if(!u.ok)throw new Error("binary_import_failed");const c=await jsonFetch(f,projectUrl(d,id,"binary/commit"),{ticket,operationId:op},s);if(!c.ok)throw new Error("binary_commit_failed");}
function projectUrl(d:string,id:string,p:string){return `${d.replace(/\/$/,"")}/v2/projects/${encodeURIComponent(id)}/${p}`;} function auth(s:string){return {Authorization:`Bearer ${s}`};} async function jsonFetch(f:typeof fetch,u:string,b:object,s?:string){return f(u,{method:"POST",headers:{"content-type":"application/json",...(s?auth(s):{})},body:JSON.stringify(b)});} async function getCatalog(f:typeof fetch,d:string,id:string,s:string){const r=await f(projectUrl(d,id,"catalog"),{headers:auth(s)});if(!r.ok)throw new Error("catalog_failed");return r.json() as Promise<CatalogV2>;} function safePath(p:string){p=p.normalize("NFC");if(!p||p.startsWith("/")||p.endsWith("/")||p.includes("\\")||p.split("/").some(x=>!x||x==="."||x===".."))throw new Error("unsafe_path");return p;} function isUtf8(b:Uint8Array){try{new TextDecoder("utf-8",{fatal:true}).decode(b);return true;}catch{return false;}} async function sha(b:Uint8Array){return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",b)),x=>x.toString(16).padStart(2,"0")).join("");} function canonicalJson(v:unknown):string{if(Array.isArray(v))return`[${v.map(canonicalJson).join(",")}]`;if(v&&typeof v==="object")return`{${Object.entries(v as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>`${JSON.stringify(k)}:${canonicalJson(x)}`).join(",")}}`;return JSON.stringify(v);} async function stableFileId(p:string){return `file_${(await sha(new TextEncoder().encode(p))).slice(0,32)}`;} function randomId(){return `project_${crypto.randomUUID().replaceAll("-","")}`;} function randomSecret(){const b=crypto.getRandomValues(new Uint8Array(32));return btoa(String.fromCharCode(...b)).replaceAll("+","-").replaceAll("/","_").replaceAll("=","");}
