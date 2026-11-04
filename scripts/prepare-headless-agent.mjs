// Install a Linux runtime from a prepared, pinned Synara artifact. Never copies
// desktop node_modules, native executables, provider homes or account tokens.
import { cp,mkdir,readFile,readdir,writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve,join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
const [sourceArg,destinationArg]=process.argv.slice(2);
if(!sourceArg||!destinationArg)throw new Error("Usage: node scripts/prepare-headless-agent.mjs PREPARED_SYNARA_RUNTIME NEW_DESTINATION");
if(process.platform!=="linux")throw new Error("Prepare the headless runtime on the target Linux machine");
const source=resolve(sourceArg),destination=resolve(destinationArg);
const pin=JSON.parse(await readFile(new URL("./synara-runtime.json",import.meta.url),"utf8"));
const manifest=JSON.parse(await readFile(join(source,"manifest.json"),"utf8"));
if(manifest.synaraRevision!==pin.revision)throw new Error("The source artifact does not match the pinned Synara revision");
if(existsSync(destination)&&(await readdir(destination)).length)throw new Error("Choose a new empty destination; existing runtimes are never replaced");
const releases={x64:["linux-x64","855d581f8a4eb1a8117e3426de25fe02770592febcfb31369aee1ffbfee9e8ec"],arm64:["linux-arm64","3515603e2487879a39bc75716f1a2affd027500c64ba50e845cf72cb33219013"]};
const release=releases[process.arch];if(!release)throw new Error("Supported Linux architectures: x64, arm64");
await mkdir(join(destination,"node"),{recursive:true});
const archive=`node-v${pin.nodeVersion}-${release[0]}.tar.gz`;
const response=await fetch(`https://nodejs.org/dist/v${pin.nodeVersion}/${archive}`);
if(!response.ok)throw new Error("Could not download the pinned official Node distribution");
const bytes=Buffer.from(await response.arrayBuffer());
if(createHash("sha256").update(bytes).digest("hex")!==release[1])throw new Error("Node SHA-256 verification failed");
const archivePath=join(destination,archive);await writeFile(archivePath,bytes);
function run(command,args,cwd=destination){const result=spawnSync(command,args,{cwd,env:{...process.env,PATH:`${join(destination,"node/bin")}:${process.env.PATH||""}`,npm_config_cache:join(destination,"npm-cache")},stdio:"inherit"});if(result.status!==0)throw new Error(`Runtime preparation failed: ${command}`);}
run("tar",["-xzf",archivePath,"--strip-components=1","-C",join(destination,"node")]);
await mkdir(join(destination,"bin"),{recursive:true});await cp(join(destination,"node/bin/node"),join(destination,"bin/node"));
await mkdir(join(destination,"server"),{recursive:true});
await cp(join(source,"server/dist"),join(destination,"server/dist"),{recursive:true,filter:(path)=>!path.includes("device-helper")});
await cp(join(source,"server/package.json"),join(destination,"server/package.json"));
run(join(destination,"node/bin/npm"),["install","--omit=dev","--no-audit","--no-fund"],join(destination,"server"));
run(join(destination,"node/bin/npm"),["install","--global","--prefix",join(destination,"provider-cli"),"--no-audit","--no-fund","@openai/codex@0.166.0"]);
run(process.execPath,[new URL("./patch-headless-agent.mjs",import.meta.url).pathname,destination]);
await writeFile(join(destination,"manifest.json"),JSON.stringify({...manifest,target:`${process.arch}-linux`,headlessProxyVersion:1,codexVersion:"0.166.0"},null,2)+"\n");
console.log("Linux runtime prepared. No provider login was started.");
