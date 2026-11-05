// Execute the pinned production Vite preload consumer against the actual proxy
// bootstrap. HTTP integration separately establishes root assets=404, scoped=200.
// node --experimental-vm-modules server/tests/browser_assets.mjs [RUNTIME|-] [RUST_SOURCE]
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {SourceTextModule} from 'node:vm';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
const [runtime, sourcePath='server/src/agent_transport.rs']=process.argv.slice(2);
const fixture=fileURLToPath(new URL('./fixtures/vite-preload/',import.meta.url));
const metadata=JSON.parse(readFileSync(join(fixture,'metadata.json'),'utf8'));
const pin=JSON.parse(readFileSync('scripts/synara-runtime.json','utf8'));
assert.equal(metadata.synaraRevision,pin.revision,'Refresh the production preloader fixture after a Synara upgrade');
const source=readFileSync(sourcePath,'utf8');
const start=source.indexOf('r#"');
const raw=source.slice(start+3,source.indexOf('"#,',start));
const prefix='/api/agent/browser-preload-fixture-0001/';
const origin='https://private.tail.example:8444';
const dom=new JSDOM('<!doctype html><html><head></head><body></body></html>',{url:origin+prefix,runScripts:'outside-only'});
const w=dom.window;
const workers=[];
w.Worker=class Worker {constructor(url,options){workers.push({url,options});}};
w.eval(raw.replaceAll('{{','{').replaceAll('}}','}').replaceAll('{base}',JSON.stringify(prefix)));
const requests=[];
const append=w.document.head.appendChild.bind(w.document.head);
w.document.head.appendChild=(link)=>{
  requests.push(link.href);
  append(link);
  queueMicrotask(()=>link.dispatchEvent(new w.Event(link.href.startsWith(origin+prefix)?'load':'error')));
  return link;
};
const helperSource=readFileSync(runtime&&runtime!=='-'?join(runtime,metadata.originalPath):join(fixture,'helper.mjs'),'utf8');
assert.equal(createHash('sha256').update(helperSource).digest('hex'),metadata.sha256,'The pinned production helper changed');
const module=new SourceTextModule(helperSource,{
  context:dom.getInternalVMContext(),
  initializeImportMeta(meta){meta.url=origin+prefix+'assets/preload-helper-Czpn1I53.js';meta.resolve=(url)=>new URL(url,meta.url).href;},
});
await module.link(()=>{throw new Error('Unexpected preloader module dependency');});
await module.evaluate();
let imported=false;
// This stylesheet is in the actual entry's first main-import dependency array.
await module.namespace.t(()=>{imported=true;return Promise.resolve();},['assets/fluid-hover-surface-I1aPfIaO.css']);
assert(imported,'The stylesheet preloader blocked main import');
assert.equal(requests[0],origin+prefix+'assets/fluid-hover-surface-I1aPfIaO.css');
const script=w.document.createElement('script');script.src='/assets/entry.js';
assert.equal(script.src,origin+prefix+'assets/entry.js');
const external=w.document.createElement('link');external.href='https://fonts.example/font.css';
assert.equal(external.href,'https://fonts.example/font.css');
const options={type:'module',name:'retained-worker',credentials:'same-origin'};
new w.Worker('/assets/worker-CZbxxU35.js',options);
assert.equal(workers[0].url,origin+prefix+'assets/worker-CZbxxU35.js');
assert.equal(workers[0].options,options);
for(const url of ['blob:'+origin+'/opaque-id','https://external.example/worker.js',origin+prefix+'assets/already.js']){
  new w.Worker(url,options);assert.equal(workers.at(-1).url,url);assert.equal(workers.at(-1).options,options);
}
const urlObject=new w.URL(origin+prefix+'assets/same-object.js');new w.Worker(urlObject,options);
assert.equal(workers.at(-1).url,urlObject);
assert.equal(workers.at(-1).options,options);
console.log('PASS: production CSS preloader imports main; direct script and Worker paths scoped; external/blob/prefixed URLs and Worker options preserved');
dom.window.close();
