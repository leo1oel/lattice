// Adapt an already prepared pinned Synara web bundle for a same-origin path proxy.
// Native embedding keeps its '/' default. No provider authentication is performed.
import { readFile,writeFile,readdir } from "node:fs/promises";
import { resolve,join } from "node:path";
const directory=resolve(process.argv[2] || "");
if(!process.argv[2])throw new Error("Usage: node scripts/patch-headless-agent.mjs RUNTIME_ROOT");
const assets=join(directory,"server/dist/client/assets");
const anchor='defaultPreload:`intent`';
const replacement='basepath:globalThis.__LATTICE_AGENT_BASE__||"/",'+anchor;
let count=0;
for(const name of await readdir(assets)){
  if(!name.endsWith(".js"))continue;
  const path=join(assets,name),source=await readFile(path,"utf8");
  if(source.includes(replacement)){count++;continue;}
  if(!source.includes(anchor))continue;
  if(source.split(anchor).length!==2)throw new Error("Ambiguous Synara router patch anchor");
  await writeFile(path,source.replace(anchor,replacement));count++;
}
if(count!==1)throw new Error("Pinned Synara router changed; review the headless basepath patch");
console.log("Synara headless router patch verified");
