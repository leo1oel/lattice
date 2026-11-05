import{n as e}from"./rolldown-runtime-C0FnF6B9.js";import{a as t,c as n,i as r,o as i,r as a,s as o,t as s}from"./project-HTCPIbGl.js";function c(e){let t=d.find(([t])=>e.startsWith(t));return t&&{text:t[1],reason:t[2],reasonZh:t[3]}}function l({project:e,seed:n,numberBase:r=0,extra:i,zh:a,author:o=`Leo`}){let s=null,l=new Map,f=()=>{if(s)return s;let t=n();if(!t)return{annotations:[],rounds:[]};let f=e.text(`main.tex`),p=u.flatMap(([e,t,n,i,a],s)=>{let c=f.indexOf(e);if(c<0)return[];let l=new Date(Date.now()-i*6e4).toISOString();return[{id:`bench-annotation-${s+1}`,number:r+s+1,path:`main.tex`,from:c,to:c+e.length,quote:e,prefix:f.slice(Math.max(0,c-32),c),suffix:f.slice(c+e.length,c+e.length+32),body:t,...n?{intent:n}:{},...a?{pdf:{page:1,rects:[{x:.408,y:.552,width:.322,height:.0125}],text:e}}:{},authorId:`me`,authorName:o,resolved:!1,replies:[],createdAt:l,updatedAt:l}]});if(t===`settled`)for(let e of p)e.resolved=!0;i&&p.push(...i(f,r+p.length));let m=[];if(t===`review`||t===`rounds`){let n=(e,t)=>({number:e,startedAt:new Date(Date.now()-t*36e5).toISOString(),settledAt:new Date(Date.now()-(t-.2)*36e5).toISOString(),outcomes:{},historyId:`bench-round-${e}`}),i=f.replace(`A sequence model must decide how information at one position can influence another.`,`A sequence model has to decide, at every step, how information at one position can influence another one.`),o=n(1,3);if(o.outcomes={"bench-old-1":`accepted`,"bench-old-2":`accepted`},l.set(1,[{path:`main.tex`,before:i,after:f}]),m.push(o),t===`rounds`){let t=n(2,1);t.outcomes={"bench-annotation-2":`accepted`,"bench-annotation-3":`rejected`};let r=f.replace(`The Transformer made a stronger design choice`,d[3][1]);l.set(2,[{path:`main.tex`,before:f,after:r}]),e.files.set(`main.tex`,r),m.push(t)}else{let e=a(),t={number:2,startedAt:new Date(Date.now()-3e5).toISOString(),outcomes:{}};for(let n of p){let i=n.number-r,a=c(n.quote),o=a&&(e?a.reasonZh:a.reason);i===4?n.revision={round:2,state:`asked`,question:e?`直觉放在式 (2) 之前还是之后？`:`Should the intuition go before equation (2) or after it?`}:i===2&&a?(n.revision={round:2,state:`accepted`,original:n.quote,text:a.text,reason:o},n.resolved=!0):a&&(n.revision={round:2,state:`proposed`,original:n.quote,text:a.text,reason:o}),n.revision&&(t.outcomes[n.id]=String(n.revision.state))}l.set(2,[{path:`main.tex`,before:f,after:null}]),m.push(t)}}return s={annotations:p,rounds:m},s};return(n,r)=>{switch(n){case`list_annotations`:return f();case`save_annotations`:return s={annotations:r?.annotations??[],rounds:r?.rounds??[]},null;case`save_annotation_round`:{let e=Number(r?.number);return l.set(e,r?.files??[]),r?.settled?`bench-round-${e}`:null}case`read_annotation_round`:return l.get(Number(r?.number))??[];case`restore_annotation_round`:for(let t of r?.files??[])typeof t.after==`string`&&e.files.set(t.path,t.after);return null;default:return t}}}var u,d;function f(){return(f=e((()=>{i(),u=[[`Attention turns a collection of token representations into context-sensitive representations by learning which pieces of information should interact.`,`Too abstract for the opening line; start with what the reader will be able to do`,`rewrite`,42],[`The Transformer made a stronger design choice`,`Say what the choice was before calling it stronger`,null,31],[`That choice exposes parallel computation during training`,`One line contrasting this with an RNN`,`clarify`,20],[`The factor $1/\\sqrt{d_k}$ controls score magnitude`,`Add one sentence of intuition before the variance argument`,null,12],[`Multiplicative variants made this retrieval efficient`,`Name the variants (dot-product, general)`,`clarify`,1,!0]],d=[[`Attention turns a collection`,`This tutorial shows how attention lets each token choose which others to read from, and why that one choice made the Transformer possible. Attention turns a collection of token representations into context-sensitive representations by learning which pieces of information should interact.`,`Opens with what the reader gets; the definition moves to the next sentence.`,`先说读者能得到什么，定义挪到下一句。`],[`Multiplicative variants`,`Multiplicative variants (dot-product and general scoring) made this retrieval efficient`,`Names the two variants Luong et al. compare.`,`点名 Luong 等人比较的两种变体。`],[`That choice exposes`,`Unlike a recurrent network, which must step through tokens one by one, that choice exposes parallel computation during training`,`Contrasts the Transformer with an RNN in one clause.`,`用一个从句对比 RNN。`],[`The Transformer made`,`The Transformer made attention the only path between positions, a stronger design choice`,`Says what the choice was before judging it.`,`先说是什么选择，再评价它。`]]})))()}function p(e,t){let n=RegExp(`\\b${t}\\s*=\\s*\\{`,`i`).exec(e);if(!n)return``;let r=n.index+n[0].length,i=1;for(let t=r;t<e.length;t+=1)if(e[t]===`\\`)t+=1;else if(e[t]===`{`)i+=1;else if(e[t]===`}`&&--i===0)return e.slice(r,t);return``}function m(e){let t=[];for(let[n,r]of e)!n.endsWith(`.tex`)||typeof r!=`string`||r.split(`
`).forEach((e,r)=>{for(let i of e.matchAll(/\\(?:no)?cite[a-z]*\*?(?:\[[^\]]*\])*\{([^}]*)\}/g))for(let a of i[1].split(`,`).map(e=>e.trim()).filter(Boolean))t.push({kind:`citation`,symbol:a,role:`reference`,path:n,line:r+1,snippet:e.trim().slice(0,160)})});return t}function ee(e){let t=(e,t)=>p(e,t).replace(/[{}]/g,``).replace(/\s+/g,` `).trim();return h(e).flatMap(({bibtex:e})=>{let n=g(e);if(!n)return[];let r=t(e,`eprint`),i=t(e,`doi`);return[{key:n,title:t(e,`title`),authors:t(e,`author`),year:t(e,`year`),venue:t(e,`journal`)||t(e,`booktitle`)||(r?`arXiv`:``),...r?{arxivId:r}:{},...i?{doi:i}:{}}]})}function te(e){let t=h(e).flatMap(({path:e,bibtex:t})=>{let n=g(t),r=p(t,`title`);return n?[{path:e,key:n,title:r,bibtex:t.trim(),issues:[]}]:[]});return{entries:t,issues:[],coverage:[...e].flatMap(([e,n])=>e.endsWith(`.bib`)&&typeof n==`string`?[{path:e,kind:`bibliography`,entries:t.filter(t=>t.path===e).length}]:[])}}function ne(e){let t=[];for(let[n,r]of e){if(!n.endsWith(`.tex`)||typeof r!=`string`)continue;let e=r.split(`
`),i=`reference`,a=``;e.forEach((e,r)=>{for(let[,o,s,c,l,u]of e.matchAll(_))o?[i,a]=[`section`,s??``]:c?[i,a]=[c===`align`?`equation`:c,``]:l?a=l:u&&t.push({label:u,kind:i,title:a,snippet:e.trim().slice(0,160),path:n,line:r+1})})}return t}var h,g,_;function v(){return(v=e((()=>{h=e=>[...e].flatMap(([e,t])=>e.endsWith(`.bib`)&&typeof t==`string`?t.split(/\n(?=@)/).map(t=>({path:e,bibtex:t})):[]),g=e=>/^\s*@\w+\s*\{\s*([^,\s]+)\s*,/.exec(e)?.[1],_=/\\(section|subsection|subsubsection|chapter)\*?\{([^}]*)\}|\\begin\{(figure|table|equation|align)\*?\}|\\caption\{([^}]*)\}|\\label\{([^}]+)\}/g})))()}function re(e){let t=e.get(`main.tex`);typeof t!=`string`||t.includes(`\\cietp`)||e.set(`main.tex`,t.includes(`\\citep{`)?t.replace(`\\citep{`,`\\cietp{`):t.replace(`\\end{document}`,`Attention follows \\citep{bahdanau2015} and \\citep{vaswani2017}; see \\cietp{luong2015effective}.
\\end{document}`))}function ie(e){let t=e.split(`
`),n=t.findIndex(e=>e.includes(`\\cietp`));if(n<0)return null;let r=n+1,i=t[n],a=i.indexOf(`\\cietp`)+6,o=/\\cietp\{([^,}]+)/.exec(i)?.[1]??`luong2015effective`;return{log:[`./main.tex:${r}: Undefined control sequence.`,`l.${r} ${i.slice(0,a)}`,`${` `.repeat(a+4)}${i.slice(a)}`],diagnostics:[{level:`error`,message:`Undefined control sequence.`,file:`main.tex`,line:r},{level:`warning`,message:`Citation \`${o}' on page 1 undefined on input line ${r}.`},{level:`warning`,message:`Overfull \\hbox (6.1pt too wide) in paragraph at lines 38--41`,file:`main.tex`,line:38}]}}function ae(e,t){let n=e.split(`
`),r=Math.floor(n.length*2/3);return n.splice(r,0,...t),n.join(`
`)}var y;function b(){return(b=e((()=>{y=[{tool:`pdflatex`,run:1,draft:!1,startedMs:0,durationMs:612},{tool:`bibtex`,run:1,draft:!1,startedMs:612,durationMs:96},{tool:`pdflatex`,run:2,draft:!1,startedMs:708,durationMs:431}]})))()}function oe({project:e,now:n=()=>new Date}){let r=[],i=0;function a(e,t,a){let o=t.filter(e=>e.before!==e.after);if(!o.length)return null;let s=n(),c={id:`${s.toISOString().replace(/[-:]/g,``)}-${++i}`,label:e,timestamp:s.toISOString(),actor:a.actor??`user`,kind:a.kind,source:a.source,undoOf:a.undoOf??null,changes:o};return r.unshift(c),c}function o(e,t,i){let o=`Edit ${e}`,s=r[0];return s?.label===o&&s.changes.length===1&&s.kind===`edit`&&n().getTime()-Date.parse(s.timestamp)<=x?s.changes[0].before===i?(r.shift(),null):(s.changes[0].after=i,s.timestamp=n().toISOString(),s):a(o,[{path:e,before:t,after:i}],{kind:`edit`,source:`editor`})}let s=e=>{let t=r.find(t=>t.id===e);if(!t)throw Error(`That history entry no longer exists.`);return t};return Object.assign((n,i)=>{switch(n){case`write_project_file`:{let t=e.path(i),r=S(e.files.get(t));e.answer(n,i);let a=S(e.files.get(t)),s=o(t,r,a);return{content:a??``,transactionId:s?.id??``,externalChangesMerged:!1,hadConflicts:!1}}case`list_history`:return r.map(({changes:e,...t})=>({...t,files:e.map(e=>e.path)}));case`get_history_entry`:{let{id:e,changes:t}=s(i?.transactionId);return{id:e,changes:t}}case`revert_history_file`:{let t=s(i?.transactionId),n=i?.path==null?null:String(i.path),r=t.changes.filter(e=>n===null||e.path===n);if(!r.length)throw Error(`That file is not part of this history entry.`);let o=[];for(let t of r){let n=S(e.files.get(t.path));if(n!==t.before){if(n!==t.after)throw Error(`Cannot restore ${t.path} because it changed after this history entry. Review the newer changes first.`);o.push({path:t.path,before:n,after:t.before})}}if(!o.length)throw Error(`The selected files are already at the requested state.`);for(let t of o)t.after===null?e.files.delete(t.path):e.files.set(t.path,t.after);return a(n===null?`Restore ${t.label}`:`Restore ${n} from ${t.label}`,o,{kind:`restore`,source:`history`,undoOf:t.id})}case`delete_history_entry`:return r.splice(r.indexOf(s(i?.transactionId)),1),null;default:return t}},{cite(t,n,r){let i=S(e.files.get(t)),o=`${i?.trimEnd()??``}${i?.trim()?`

`:``}${r.trim()}\n`;e.files.set(t,o),a(`Cite ${n}`,[{path:t,before:i,after:o}],{actor:`citation`,kind:`citation`,source:`citation`})}})}var x,S;function C(){return(C=e((()=>{i(),x=45e3,S=e=>typeof e==`string`?e:null})))()}function w(e,t,n,r){let i=[],a=e;for(let e of ue){let o=t(e),s=typeof o==`string`?a.includes(o)?o:null:o.exec(a)?.[0];s&&(a=a.replace(s,n(e)),i.push(`${s} => ${n(e)} | ${r}`))}return i.length?{text:a,reasons:i}:null}function se(e){let t=e=>e.replace(/\\[a-zA-Z]+/g,` `).match(/[\p{L}\p{N}]+/gu)?.length??0;if(t(e)<=T*1.1)return{text:e,reasons:[]};let n=e.match(/[^.!?]+[.!?]+(?:''|")?\s*/g)??[e],r=``;for(let e of n){if(r&&t(r+e)>T)break;r+=e}let i=e.slice(r.length).trim();return{text:r.trimEnd(),reasons:i?[`${i} =>  | concision`]:[]}}function ce(e,t,n){let r=le.find(([,t])=>t.test(e))?.[0];return(r===`passive`?w(t,e=>e.english,e=>e.passive,`clarity | ${n?`按要求改为被动语态`:`Passive voice, as asked`}`):r===`chinese`?w(t,e=>e.english,e=>e.chinese,`translation`):r===`english`?de.test(t)?w(t,e=>e.chinese,e=>e.original,`translation`):{text:t,reasons:[]}:r===`shorten`?se(t):null)??{failure:fe(n)}}var le,ue,de,T,fe;function pe(){return(pe=e((()=>{le=[[`chinese`,/chinese|中文|汉语/i],[`english`,/english|英文|英语/i],[`passive`,/passive|被动/i],[`shorten`,/shorten|shorter|condense|\bcut\b|缩短|精简|压缩/i]],ue=[{english:/Consider the four-token fragment ``attention connects every position\.''/,original:"Consider the four-token fragment ``attention connects every position.''",passive:"The four-token fragment ``attention connects every position.'' is considered here.",chinese:"考虑由四个词元组成的片段 ``attention connects every position.''。"},{english:/For (?:the|an? example) query at \\emph\{connects\}, suppose the scaled scores are \$\[0\.4,1\.2,0\.1,0\.8\]\$\./,original:`For an example query at \\emph{connects}, suppose the scaled scores are $[0.4,1.2,0.1,0.8]$.`,passive:`For an example query at \\emph{connects}, the scaled scores are taken to be $[0.4,1.2,0.1,0.8]$.`,chinese:`以 \\emph{connects} 处的查询为例，设缩放后的得分为 $[0.4,1.2,0.1,0.8]$。`},{english:/Applying softmax gives approximately \$\[0\.18,0\.41,0\.14,0\.27\]\$ after rounding\./,original:`Applying softmax gives approximately $[0.18,0.41,0.14,0.27]$ after rounding.`,passive:`Approximately $[0.18,0.41,0.14,0.27]$ is obtained once softmax is applied and the result is rounded.`,chinese:`应用 softmax 并四舍五入后，结果约为 $[0.18,0.41,0.14,0.27]$。`},{english:/The new representation at \\emph\{connects\} is therefore a convex combination of all four value vectors, with the largest contribution coming from its own value in this illustrative head\./,original:`The new representation at \\emph{connects} is therefore a convex combination of all four value vectors, with the largest contribution coming from its own value in this illustrative head.`,passive:`The new representation at \\emph{connects} is therefore formed as a convex combination of all four value vectors, with the largest contribution made by its own value in this illustrative head.`,chinese:`因此，\\emph{connects} 处的新表示是全部四个值向量的凸组合；在这个示意性的注意力头中，它自身的值贡献最大。`},{english:/Changing (?:the|teh) softmax temperature alters concentration but not the underlying value vectors; the interactive HTML file in this project lets the reader inspect that distinction\./,original:`Changing the softmax temperature alters concentration but not the underlying value vectors; the interactive HTML file in this project lets the reader inspect that distinction.`,passive:`Concentration is altered by changing the softmax temperature, but the underlying value vectors are not; the interactive HTML file in this project lets the reader inspect that distinction.`,chinese:`改变 softmax 温度会改变注意力的集中程度，但不会改变底层的值向量；读者可以用本项目中的交互式 HTML 文件查看这一区别。`}],de=/[\u3400-\u9fff]/,T=100,fe=e=>e?`演示里的改写是脚本模拟的：它只认得建议的几条指令，并且只改写标有“Demo”的那一段。Mac 上的 Lattice 会让你的 AI 按任意指令改写任意段落。`:`Rewrite is scripted in this demo: it knows the suggested instructions, for the paragraph marked “Demo”. Lattice on your Mac has your AI rewrite any passage as you ask.`})))()}function me({mode:e=()=>null,model:t=()=>null}={}){let n=new Map;return r=>{let i=String(r?.action??``);if(i===`start`){if(e()===`unavailable`)throw`agent_route_unavailable`;let t=String(r?.prompt??``);if(t.startsWith(`Revise a passage`)){let e=`text-task:${n.size+1}`;return n.set(e,{text:ge(t),ready:performance.now()+1200+Math.random()*1600}),{taskId:e}}let i=/<excerpt>\n([\s\S]*)\n<\/excerpt>$/.exec(t)?.[1]??``,a=t.includes(`in Simplified Chinese`),o=/^Revise the LaTeX excerpt [^\n]*\n<instruction>\n([\s\S]*?)\n<\/instruction>/.exec(t)?.[1];if(o!==void 0){let e=ce(o,i,a),t=`text-task:${n.size+1}`;return n.set(t,`failure`in e?{text:``,failure:e.failure,ready:performance.now()+1200}:{text:he(e.text,e.reasons),ready:performance.now()+1600}),{taskId:t}}let s=[..._e,...t.startsWith(`Polish`)?ve:[],...e()===`unsafe`?ye:[]],c=[],l=s.reduce((e,[t,n,r,i,o])=>e.replace(t,e=>{let s=e.replace(new RegExp(t.source,t.flags.replace(`g`,``)),n);return r&&c.push([`${e} => ${s}`,r,...i?[a?o:i]:[]].join(` | `)),s}),i),u=`text-task:${n.size+1}`;return n.set(u,{text:he(l,c),ready:performance.now()+1600}),{taskId:u}}let a=n.get(String(r?.taskId??``));if(!a)throw`Agent task not found.`;if(i===`cancel`||performance.now()<a.ready)return{status:`running`};if(e()===`failed`)return{status:`failed`,message:`Codex is not signed in.`};if(a.failure)return{status:`failed`,message:a.failure};let o=t();return{status:`completed`,text:a.text,...o?{model:o}:{}}}}function he(e,t){return`Here is the revised excerpt.\n<proofread>\n${e}\n</proofread>\n<reasons>\n${t.join(`
`)}\n</reasons>`}function ge(e){let t=/<passage>\n([\s\S]*)\n<\/passage>/.exec(e)?.[1]??``,n=e.includes(`in Simplified Chinese`);if(e.includes(`<bibliography>`))return`<question>${n?`要引用哪篇论文？参考文献里没有直接支持这句话的。`:`Which paper should support this? Nothing in the bibliography states it directly.`}</question>`;let r=c(t.trim());return`<revision>${r?.text??t.replace(/\bvery\b\s*/g,``).replace(/\bin order to\b/g,`to`).replace(/\bdeliberately\b\s*/g,``)}</revision>\n<reason>${r?n?r.reasonZh:r.reason:n?`更紧凑，意思不变。`:`Tighter, same meaning.`}</reason>`}var _e,ve,ye;function be(){return(be=e((()=>{f(),pe(),_e=[[/\bteh\b/g,`the`,`spelling`],[/\bwich\b/g,`which`,`spelling`],[/\bbeleive\b/g,`believe`,`spelling`],[/\brecieves?\b/g,`receives`,`spelling`],[/\boccured\b/g,`occurred`,`spelling`],[/\bseperate\b/g,`separate`,`spelling`],[/\bachieve state of the art\b/g,`achieves state-of-the-art`,`grammar`,`Agreement, and a hyphenated modifier`,`主谓一致，复合修饰语加连字符`],[/\ba ([aeiou])/g,`an $1`,`grammar`,`“an” before a vowel sound`,`元音前用 an`],[/ {2,}/g,` `],[/ ,/g,`,`,`punctuation`,`No space before a comma`,`逗号前不空格`]],ve=[[/\bIn this paper,? we show that\b/g,`This paper shows that`,`concision`],[/\bin order to\b/g,`to`,`concision`,`Shorter, same meaning`,`更简短，意思不变`],[/\bdue to the fact that\b/g,`because`,`concision`],[/\bvery important\b/g,`essential`,`word choice`,`Stronger than an intensifier`,`比加强副词更有力`],[/\ba lot of\b/g,`many`,`word choice`,`Less colloquial`,`更书面`]],ye=[[/\$([^$]+)\$/,`$\\hat{$1}$`,`consistency`],[/\\cite\{([^}]+)\}/,`\\cite{$1-2024}`,`consistency`]]})))()}function xe(e){return Array.from({length:5},(t,n)=>((e+1)*2654435761+n*40503>>>0).toString(16).padStart(8,`0`)).join(``)}function E(e,t){return[...new Set([...e.keys(),...t.keys()])].filter(e=>!O(e)).sort().flatMap(n=>{let r=e.get(n),i=t.get(n);return r===i?[]:[{path:n,kind:r===void 0?`added`:i===void 0?`deleted`:`modified`}]})}function Se({project:e,author:n=`Lattice`,now:r=()=>new Date}){let i=[],a=()=>new Map([...e.files].filter(([e])=>!O(e))),o=()=>i.at(-1);function s(e){let t=a(),s=i.length?E(o().tree,t):[...t.keys()].sort().map(e=>({path:e,kind:`added`}));if(!s.length)return null;let c=xe(i.length);return i.push({hash:c,shortHash:c.slice(0,7),authorName:n,timestamp:r().toISOString(),message:e,files:s,tree:t}),c}s(Ce);function c(e){let t=String(e??``),n=t===`HEAD`?o():i.find(e=>e.hash===t||e.shortHash===t);if(!n)throw Error(`Unknown revision: ${t}`);return n}let l=e=>e==null?a():c(e).tree;function u(){return{available:!0,repository:!0,branch:`main`,remote:null,remoteUrl:null,upstream:null,ahead:0,behind:0,files:E(o().tree,a()).map(({path:e,kind:t})=>({path:e,status:t===`added`?`untracked`:t,staged:!1,unstaged:!0}))}}return(n,r)=>{switch(n){case`git_status`:case`git_init`:return u();case`git_log`:return i.slice().reverse().slice(0,Number(r?.limit??100)).map(({tree:e,...t})=>t);case`git_auto_commit`:{let e=String(r?.message??``).trim();if(!e)throw Error(`Commit message cannot be empty.`);return s(e)}case`git_compare_files`:return E(l(r?.from),l(r?.to));case`git_compare_file`:{let e=String(r?.path??``),t=l(r?.from).get(String(r?.fromPath??e)),n=l(r?.to).get(e);return t instanceof Uint8Array||n instanceof Uint8Array?{before:null,after:null,binary:!0}:{before:k(t),after:k(n),binary:!1}}case`git_show_diff`:{let e=c(r?.rev),t=i[i.indexOf(e)-1],n=String(r?.path??``),a=e.tree.get(n);return a instanceof Uint8Array?{before:null,after:null,binary:!0}:{before:k(t?.tree.get(n)),after:k(a),binary:!1}}case`git_restore_file`:{let t=c(r?.rev),n=String(r?.path??``),i=t.tree.get(n);if(i===void 0)throw Error(`${n} did not exist at revision ${t.shortHash}.`);return s(D),e.files.set(n,i),null}case`git_restore_project`:{let t=c(r?.rev);s(D);for(let n of[...e.files.keys()])!O(n)&&o().tree.has(n)&&!t.tree.has(n)&&e.files.delete(n);for(let[n,r]of t.tree)e.files.set(n,r);return s(`Restore project to ${t.shortHash}`)??o().hash}default:return t}}}var Ce,D,O,k;function A(){return(A=e((()=>{i(),Ce=`Initialize version tracking`,D=`Auto-saved version`,O=e=>e===`.research`||e.startsWith(`.research/`),k=e=>typeof e==`string`?e:null})))()}var j,M,we,N;function Te(){return(Te=e((()=>{j=1027,M=[],we=`This is pdfTeX, Version 3.141592653-2.6-1.40.29 (TeX Live 2026) (preloaded format=pdflatex 2026.7.21)  1 JAN 2026 00:00
entering extended mode
 restricted \\write18 enabled.
 file:line:error style messages enabled.
 %&-line parsing enabled.
**main.tex
(./main.tex
LaTeX2e <2025-11-01>
L3 programming layer <2026-01-19>
(/usr/local/texlive/2026basic/texmf-dist/tex/latex/base/article.cls
Document Class: article 2025/01/22 v1.4n Standard LaTeX document class
(/usr/local/texlive/2026basic/texmf-dist/tex/latex/base/size10.clo
File: size10.clo 2025/01/22 v1.4n Standard LaTeX file (size option)
)
\\c@part=\\count275
\\c@section=\\count276
\\c@subsection=\\count277
\\c@subsubsection=\\count278
\\c@paragraph=\\count279
\\c@subparagraph=\\count280
\\c@figure=\\count281
\\c@table=\\count282
\\abovecaptionskip=\\skip49
\\belowcaptionskip=\\skip50
\\bibindent=\\dimen148
)
(./neurips.sty
Package: neurips 2026-01-29 NeurIPS 2026 submission/camera-ready style file

(/usr/local/texlive/2026basic/texmf-dist/tex/latex/environ/environ.sty
Package: environ 2014/05/04 v0.3 A new way to define environments

(/usr/local/texlive/2026basic/texmf-dist/tex/latex/trimspaces/trimspaces.sty
Package: trimspaces 2009/09/17 v1.1 Trim spaces around a token list
)
\\@envbody=\\toks17
)
(/usr/local/texlive/2026basic/texmf-dist/tex/latex/natbib/natbib.sty
Package: natbib 2010/09/13 8.31b (PWD, AO)
\\bibhang=\\skip51
\\bibsep=\\skip52
LaTeX Info: Redefining \\cite on input line 694.
\\c@NAT@ctr=\\count283
)
(/usr/local/texlive/2026basic/texmf-dist/tex/latex/geometry/geometry.sty
Package: geometry 2020/01/02 v5.9 Page Geometry

(/usr/local/texlive/2026basic/texmf-dist/tex/latex/graphics/keyval.sty
Package: keyval 2022/05/29 v1.15 key=value parser (DPC)
\\KV@toks@=\\toks18
)
(/usr/local/texlive/2026basic/texmf-dist/tex/generic/iftex/ifvtex.sty
Package: ifvtex 2019/10/25 v1.7 ifvtex legacy package. Use iftex instead.

(/usr/local/texlive/2026basic/texmf-dist/tex/generic/iftex/iftex.sty
Package: iftex 2024/12/12 v1.0g TeX engine tests
))
\\Gm@cnth=\\count284
\\Gm@cntv=\\count285
\\c@Gm@tempcnt=\\count286
\\Gm@bindingoffset=\\dimen149
\\Gm@wd@mp=\\dimen150
\\Gm@odd@mp=\\dimen151
\\Gm@even@mp=\\dimen152
\\Gm@layoutwidth=\\dimen153
\\Gm@layoutheight=\\dimen154
\\Gm@layouthoffset=\\dimen155
\\Gm@layoutvoffset=\\dimen156
\\Gm@dimlist=\\toks19
)
\\@neuripsabovecaptionskip=\\skip53
\\@neuripsbelowcaptionskip=\\skip54
)
(/usr/local/texlive/2026basic/texmf-dist/tex/latex/base/inputenc.sty
Package: inputenc 2024/02/08 v1.3d Input encoding file
\\inpenc@prehook=\\toks20
\\inpenc@posthook=\\toks21
)
(/usr/local/texlive/2026basic/texmf-dist/tex/latex/base/fontenc.sty
Package: fontenc 2025/07/18 v2.1d Standard LaTeX package
LaTeX Font Info:    Trying to load font information for T1+ptm on input line 11
6.

(/usr/local/texlive/2026basic/texmf-dist/tex/latex/psnfss/t1ptm.fd
File: t1ptm.fd 2001/06/04 font definitions for T1/ptm.
))
(/usr/local/texlive/2026basic/texmf-dist/tex/latex/amsmath/amsmath.sty
Package: amsmath 2025/07/09 v2.17z AMS math features
\\@mathmargin=\\skip55

For additional information on amsmath, use the \`?' option.
(/usr/local/texlive/2026basic/texmf-dist/tex/latex/amsmath/amstext.sty
Package: amstext 2024/11/17 v2.01 AMS text

(/usr/local/texlive/2026basic/texmf-dist/tex/latex/amsmath/amsgen.sty
File: amsgen.sty 1999/11/30 v2.0 generic functions
\\@emptytoks=\\toks22
\\ex@=\\dimen157
))
(/usr/local/texlive/2026basic/texmf-dist/tex/latex/amsmath/amsbsy.sty
Package: amsbsy 1999/11/29 v1.2d Bold Symbols
\\pmbraise@=\\dimen158
)
(/usr/local/texlive/2026basic/texmf-dist/tex/latex/amsmath/amsopn.sty
Package: amsopn 2022/04/08 v2.04 operator names
)
\\inf@bad=\\count287
LaTeX Info: Redefining \\frac on input line 233.
\\uproot@=\\count288
\\leftroot@=\\count289
LaTeX Info: Redefining \\overline on input line 398.
LaTeX Info: Redefining \\colon on input line 409.
\\classnum@=\\count290
\\DOTSCASE@=\\count291
LaTeX Info: Redefining \\ldots on input line 495.
LaTeX Info: Redefining \\dots on input line 498.
LaTeX Info: Redefining \\cdots on input line 619.
\\Mathstrutbox@=\\box53
\\strutbox@=\\box54
LaTeX Info: Redefining \\big on input line 721.
LaTeX Info: Redefining \\Big on input line 722.
LaTeX Info: Redefining \\bigg on input line 723.
LaTeX Info: Redefining \\Bigg on input line 724.
\\big@size=\\dimen159
LaTeX Font Info:    Redeclaring font encoding OML on input line 742.
LaTeX Font Info:    Redeclaring font encoding OMS on input line 743.
\\macc@depth=\\count292
LaTeX Info: Redefining \\bmod on input line 904.
LaTeX Info: Redefining \\pmod on input line 909.
LaTeX Info: Redefining \\smash on input line 939.
LaTeX Info: Redefining \\relbar on input line 969.
LaTeX Info: Redefining \\Relbar on input line 970.
\\c@MaxMatrixCols=\\count293
\\dotsspace@=\\muskip17
\\c@parentequation=\\count294
\\dspbrk@lvl=\\count295
\\tag@help=\\toks23
\\row@=\\count296
\\column@=\\count297
\\maxfields@=\\count298
\\andhelp@=\\toks24
\\eqnshift@=\\dimen160
\\alignsep@=\\dimen161
\\tagshift@=\\dimen162
\\tagwidth@=\\dimen163
\\totwidth@=\\dimen164
\\lineht@=\\dimen165
\\@envbody=\\toks25
\\multlinegap=\\skip56
\\multlinetaggap=\\skip57
\\mathdisplay@stack=\\toks26
LaTeX Info: Redefining \\[ on input line 2950.
LaTeX Info: Redefining \\] on input line 2951.
)
(/usr/local/texlive/2026basic/texmf-dist/tex/latex/amsfonts/amssymb.sty
Package: amssymb 2013/01/14 v3.01 AMS font symbols

(/usr/local/texlive/2026basic/texmf-dist/tex/latex/amsfonts/amsfonts.sty
Package: amsfonts 2013/01/14 v3.01 Basic AMSFonts support
\\symAMSa=\\mathgroup4
\\symAMSb=\\mathgroup5
LaTeX Font Info:    Redeclaring math symbol \\hbar on input line 98.
LaTeX Font Info:    Overwriting math alphabet \`\\mathfrak' in version \`bold'
(Font)                  U/euf/m/n --> U/euf/b/n on input line 106.
))
(/usr/local/texlive/2026basic/texmf-dist/tex/latex/booktabs/booktabs.sty
Package: booktabs 2020/01/12 v1.61803398 Publication quality tables
\\heavyrulewidth=\\dimen166
\\lightrulewidth=\\dimen167
\\cmidrulewidth=\\dimen168
\\belowrulesep=\\dimen169
\\belowbottomsep=\\dimen170
\\aboverulesep=\\dimen171
\\abovetopsep=\\dimen172
\\cmidrulesep=\\dimen173
\\cmidrulekern=\\dimen174
\\defaultaddspace=\\dimen175
\\@cmidla=\\count299
\\@cmidlb=\\count300
\\@aboverulesep=\\dimen176
\\@belowrulesep=\\dimen177
\\@thisruleclass=\\count301
\\@lastruleclass=\\count302
\\@thisrulewidth=\\dimen178
)
(/usr/local/texlive/2026basic/texmf-dist/tex/latex/graphics/graphicx.sty
Package: graphicx 2024/12/31 v1.2e Enhanced LaTeX Graphics (DPC,SPQR)

(/usr/local/texlive/2026basic/texmf-dist/tex/latex/graphics/graphics.sty
Package: graphics 2024/08/06 v1.4g Standard LaTeX Graphics (DPC,SPQR)

(/usr/local/texlive/2026basic/texmf-dist/tex/latex/graphics/trig.sty
Package: trig 2023/12/02 v1.11 sin cos tan (DPC)
)
(/usr/local/texlive/2026basic/texmf-dist/tex/latex/graphics-cfg/graphics.cfg
File: graphics.cfg 2016/06/04 v1.11 sample graphics configuration
)
Package graphics Info: Driver file: pdftex.def on input line 106.

(/usr/local/texlive/2026basic/texmf-dist/tex/latex/graphics-def/pdftex.def
File: pdftex.def 2025/09/29 v1.2d Graphics/color driver for pdftex
))
\\Gin@req@height=\\dimen179
\\Gin@req@width=\\dimen180
)
(/usr/local/texlive/2026basic/texmf-dist/tex/latex/microtype/microtype.sty
Package: microtype 2026/03/01 v3.2d Micro-typographical refinements (RS)

(/usr/local/texlive/2026basic/texmf-dist/tex/latex/etoolbox/etoolbox.sty
Package: etoolbox 2025/10/02 v2.5m e-TeX tools for LaTeX (JAW)
\\etb@tempcnta=\\count303
)
\\MT@toks=\\toks27
\\MT@tempbox=\\box55
\\MT@count=\\count304
LaTeX Info: Redefining \\noprotrusionifhmode on input line 1084.
LaTeX Info: Redefining \\leftprotrusion on input line 1085.
\\MT@prot@toks=\\toks28
LaTeX Info: Redefining \\rightprotrusion on input line 1104.
LaTeX Info: Redefining \\textls on input line 1449.
\\MT@outer@kern=\\dimen181
LaTeX Info: Redefining \\microtypecontext on input line 2053.
LaTeX Info: Redefining \\textmicrotypecontext on input line 2070.
\\MT@listname@count=\\count305

(/usr/local/texlive/2026basic/texmf-dist/tex/latex/microtype/microtype-pdftex.d
ef
File: microtype-pdftex.def 2026/03/01 v3.2d Definitions specific to pdftex (RS)

LaTeX Info: Redefining \\lsstyle on input line 944.
LaTeX Info: Redefining \\lslig on input line 944.
\\MT@outer@space=\\skip58
)
Package microtype Info: Loading configuration file microtype.cfg.
 (/usr/local/texlive/2026basic/texmf-dist/tex/latex/microtype/microtype.cfg
File: microtype.cfg 2026/03/01 v3.2d microtype main configuration file (RS)
)
LaTeX Info: Redefining \\microtypesetup on input line 3065.
) (/usr/local/texlive/2026basic/texmf-dist/tex/latex/xcolor/xcolor.sty
Package: xcolor 2024/09/29 v3.02 LaTeX color extensions (UK)

(/usr/local/texlive/2026basic/texmf-dist/tex/latex/graphics-cfg/color.cfg
File: color.cfg 2016/01/02 v1.6 sample color configuration
)
Package xcolor Info: Driver file: pdftex.def on input line 274.

(/usr/local/texlive/2026basic/texmf-dist/tex/latex/graphics/mathcolor.ltx)
Package xcolor Info: Model \`cmy' substituted by \`cmy0' on input line 1349.
Package xcolor Info: Model \`hsb' substituted by \`rgb' on input line 1353.
Package xcolor Info: Model \`RGB' extended on input line 1365.
Package xcolor Info: Model \`HTML' substituted by \`rgb' on input line 1367.
Package xcolor Info: Model \`Hsb' substituted by \`hsb' on input line 1368.
Package xcolor Info: Model \`tHsb' substituted by \`hsb' on input line 1369.
Package xcolor Info: Model \`HSB' substituted by \`hsb' on input line 1370.
Package xcolor Info: Model \`Gray' substituted by \`gray' on input line 1371.
Package xcolor Info: Model \`wave' substituted by \`hsb' on input line 1372.
)
(/usr/local/texlive/2026basic/texmf-dist/tex/latex/url/url.sty
\\Urlmuskip=\\muskip18
Package: url 2013/09/16  ver 3.4  Verb mode for urls, etc.
)
(/usr/local/texlive/2026basic/texmf-dist/tex/latex/hyperref/hyperref.sty
Package: hyperref 2026-01-29 v7.01p Hypertext links for LaTeX

(/usr/local/texlive/2026basic/texmf-dist/tex/latex/kvsetkeys/kvsetkeys.sty
Package: kvsetkeys 2022-10-05 v1.19 Key value parser (HO)
)
(/usr/local/texlive/2026basic/texmf-dist/tex/generic/kvdefinekeys/kvdefinekeys.
sty
Package: kvdefinekeys 2019-12-19 v1.6 Define keys (HO)
)
(/usr/local/texlive/2026basic/texmf-dist/tex/generic/pdfescape/pdfescape.sty
Package: pdfescape 2019/12/09 v1.15 Implements pdfTeX's escape features (HO)

(/usr/local/texlive/2026basic/texmf-dist/tex/generic/ltxcmds/ltxcmds.sty
Package: ltxcmds 2023-12-04 v1.26 LaTeX kernel commands for general use (HO)
)
(/usr/local/texlive/2026basic/texmf-dist/tex/generic/pdftexcmds/pdftexcmds.sty
Package: pdftexcmds 2020-06-27 v0.33 Utility functions of pdfTeX for LuaTeX (HO
)

(/usr/local/texlive/2026basic/texmf-dist/tex/generic/infwarerr/infwarerr.sty
Package: infwarerr 2019/12/03 v1.5 Providing info/warning/error messages (HO)
)
Package pdftexcmds Info: \\pdf@primitive is available.
Package pdftexcmds Info: \\pdf@ifprimitive is available.
Package pdftexcmds Info: \\pdfdraftmode found.
)) (/usr/local/texlive/2026basic/texmf-dist/tex/latex/hycolor/hycolor.sty
Package: hycolor 2020-01-27 v1.10 Color options for hyperref/bookmark (HO)
)
(/usr/local/texlive/2026basic/texmf-dist/tex/latex/hyperref/nameref.sty
Package: nameref 2026-01-29 v2.58 Cross-referencing by name of section

(/usr/local/texlive/2026basic/texmf-dist/tex/latex/refcount/refcount.sty
Package: refcount 2019/12/15 v3.6 Data extraction from label references (HO)
)
(/usr/local/texlive/2026basic/texmf-dist/tex/generic/gettitlestring/gettitlestr
ing.sty
Package: gettitlestring 2019/12/15 v1.6 Cleanup title references (HO)

(/usr/local/texlive/2026basic/texmf-dist/tex/latex/kvoptions/kvoptions.sty
Package: kvoptions 2022-06-15 v3.15 Key value format for package options (HO)
))
\\c@section@level=\\count306
)
(/usr/local/texlive/2026basic/texmf-dist/tex/generic/stringenc/stringenc.sty
Package: stringenc 2019/11/29 v1.12 Convert strings between diff. encodings (HO
)
)
\\@linkdim=\\dimen182
\\Hy@linkcounter=\\count307
\\Hy@pagecounter=\\count308

(/usr/local/texlive/2026basic/texmf-dist/tex/latex/hyperref/pd1enc.def
File: pd1enc.def 2026-01-29 v7.01p Hyperref: PDFDocEncoding definition (HO)
Now handling font encoding PD1 ...
... no UTF-8 mapping file for font encoding PD1
)
(/usr/local/texlive/2026basic/texmf-dist/tex/generic/intcalc/intcalc.sty
Package: intcalc 2019/12/15 v1.3 Expandable calculations with integers (HO)
)
\\Hy@SavedSpaceFactor=\\count309

(/usr/local/texlive/2026basic/texmf-dist/tex/latex/hyperref/puenc.def
File: puenc.def 2026-01-29 v7.01p Hyperref: PDF Unicode definition (HO)
Now handling font encoding PU ...
... no UTF-8 mapping file for font encoding PU
)
Package hyperref Info: Option \`colorlinks' set \`true' on input line 4072.
Package hyperref Info: Hyper figures OFF on input line 4201.
Package hyperref Info: Link nesting OFF on input line 4206.
Package hyperref Info: Hyper index ON on input line 4209.
Package hyperref Info: Plain pages OFF on input line 4216.
Package hyperref Info: Backreferencing OFF on input line 4221.
Package hyperref Info: Implicit mode ON; LaTeX internals redefined.
Package hyperref Info: Bookmarks ON on input line 4468.
\\c@Hy@tempcnt=\\count310
LaTeX Info: Redefining \\url on input line 4807.
\\XeTeXLinkMargin=\\dimen183

(/usr/local/texlive/2026basic/texmf-dist/tex/generic/bitset/bitset.sty
Package: bitset 2019/12/09 v1.3 Handle bit-vector datatype (HO)

(/usr/local/texlive/2026basic/texmf-dist/tex/generic/bigintcalc/bigintcalc.sty
Package: bigintcalc 2019/12/15 v1.5 Expandable calculations on big integers (HO
)
))
\\Fld@menulength=\\count311
\\Field@Width=\\dimen184
\\Fld@charsize=\\dimen185
Package hyperref Info: Hyper figures OFF on input line 6084.
Package hyperref Info: Link nesting OFF on input line 6089.
Package hyperref Info: Hyper index ON on input line 6092.
Package hyperref Info: backreferencing OFF on input line 6099.
Package hyperref Info: Link coloring ON on input line 6102.
Package hyperref Info: Link coloring with OCG OFF on input line 6109.
Package hyperref Info: PDF/A mode OFF on input line 6114.
\\Hy@abspage=\\count312
\\c@Item=\\count313
\\c@Hfootnote=\\count314
)
Package hyperref Info: Driver (autodetected): hpdftex.
 (/usr/local/texlive/2026basic/texmf-dist/tex/latex/hyperref/hpdftex.def
File: hpdftex.def 2026-01-29 v7.01p Hyperref driver for pdfTeX
\\Fld@listcount=\\count315
\\c@bookmark@seq@number=\\count316

(/usr/local/texlive/2026basic/texmf-dist/tex/latex/rerunfilecheck/rerunfilechec
k.sty
Package: rerunfilecheck 2025-06-21 v1.11 Rerun checks for auxiliary files (HO)

(/usr/local/texlive/2026basic/texmf-dist/tex/generic/uniquecounter/uniquecounte
r.sty
Package: uniquecounter 2019/12/15 v1.4 Provide unlimited unique counter (HO)
)
Package uniquecounter Info: New unique counter \`rerunfilecheck' on input line 2
84.
)
\\Hy@SectionHShift=\\skip59
)
(/usr/local/texlive/2026basic/texmf-dist/tex/latex/l3backend/l3backend-pdftex.d
ef
File: l3backend-pdftex.def 2025-10-09 L3 backend support: PDF output (pdfTeX)
\\l__color_backend_stack_int=\\count317
) (./main.aux)
\\openout1 = \`main.aux'.

LaTeX Font Info:    Checking defaults for OML/cmm/m/it on input line 19.
LaTeX Font Info:    ... okay on input line 19.
LaTeX Font Info:    Checking defaults for OMS/cmsy/m/n on input line 19.
LaTeX Font Info:    ... okay on input line 19.
LaTeX Font Info:    Checking defaults for OT1/cmr/m/n on input line 19.
LaTeX Font Info:    ... okay on input line 19.
LaTeX Font Info:    Checking defaults for T1/cmr/m/n on input line 19.
LaTeX Font Info:    ... okay on input line 19.
LaTeX Font Info:    Checking defaults for TS1/cmr/m/n on input line 19.
LaTeX Font Info:    ... okay on input line 19.
LaTeX Font Info:    Checking defaults for OMX/cmex/m/n on input line 19.
LaTeX Font Info:    ... okay on input line 19.
LaTeX Font Info:    Checking defaults for U/cmr/m/n on input line 19.
LaTeX Font Info:    ... okay on input line 19.
LaTeX Font Info:    Checking defaults for PD1/pdf/m/n on input line 19.
LaTeX Font Info:    ... okay on input line 19.
LaTeX Font Info:    Checking defaults for PU/pdf/m/n on input line 19.
LaTeX Font Info:    ... okay on input line 19.

*geometry* driver: auto-detecting
*geometry* detected driver: pdftex
*geometry* verbose mode - [ preamble ] result:
* driver: pdftex
* paper: letterpaper
* layout: <same size as paper>
* layoutoffset:(h,v)=(0.0pt,0.0pt)
* modes: 
* h-part:(L,W,R)=(92.14519pt, 430.00462pt, 92.14519pt)
* v-part:(T,H,B)=(95.39737pt, 556.47656pt, 143.09605pt)
* \\paperwidth=614.295pt
* \\paperheight=794.96999pt
* \\textwidth=430.00462pt
* \\textheight=556.47656pt
* \\oddsidemargin=19.8752pt
* \\evensidemargin=19.8752pt
* \\topmargin=-13.87262pt
* \\headheight=12.0pt
* \\headsep=25.0pt
* \\topskip=10.0pt
* \\footskip=30.0pt
* \\marginparwidth=65.0pt
* \\marginparsep=11.0pt
* \\columnsep=10.0pt
* \\skip\\footins=9.0pt plus 4.0pt minus 2.0pt
* \\hoffset=0.0pt
* \\voffset=0.0pt
* \\mag=1000
* \\@twocolumnfalse
* \\@twosidefalse
* \\@mparswitchfalse
* \\@reversemarginfalse
* (1in=72.27pt=25.4mm, 1cm=28.453pt)

*geometry* verbose mode - [ newgeometry ] result:
* driver: pdftex
* paper: letterpaper
* layout: <same size as paper>
* layoutoffset:(h,v)=(0.0pt,0.0pt)
* modes: 
* h-part:(L,W,R)=(108.405pt, 397.48499pt, 108.40501pt)
* v-part:(T,H,B)=(72.26999pt, 650.43pt, 72.27pt)
* \\paperwidth=614.295pt
* \\paperheight=794.96999pt
* \\textwidth=397.48499pt
* \\textheight=650.43pt
* \\oddsidemargin=36.13501pt
* \\evensidemargin=36.13501pt
* \\topmargin=-37.0pt
* \\headheight=12.0pt
* \\headsep=25.0pt
* \\topskip=10.0pt
* \\footskip=30.0pt
* \\marginparwidth=65.0pt
* \\marginparsep=11.0pt
* \\columnsep=10.0pt
* \\skip\\footins=9.0pt plus 4.0pt minus 2.0pt
* \\hoffset=0.0pt
* \\voffset=0.0pt
* \\mag=1000
* \\@twocolumnfalse
* \\@twosidefalse
* \\@mparswitchfalse
* \\@reversemarginfalse
* (1in=72.27pt=25.4mm, 1cm=28.453pt)

(/usr/local/texlive/2026basic/texmf-dist/tex/context/base/mkii/supp-pdf.mkii
[Loading MPS to PDF converter (version 2006.09.02).]
\\scratchcounter=\\count318
\\scratchdimen=\\dimen186
\\scratchbox=\\box56
\\nofMPsegments=\\count319
\\nofMParguments=\\count320
\\everyMPshowfont=\\toks29
\\MPscratchCnt=\\count321
\\MPscratchDim=\\dimen187
\\MPnumerator=\\count322
\\makeMPintoPDFobject=\\count323
\\everyMPtoPDFconversion=\\toks30
)
(/usr/local/texlive/2026basic/texmf-dist/tex/latex/epstopdf-pkg/epstopdf-base.s
ty
Package: epstopdf-base 2020-01-24 v2.11 Base part for package epstopdf
Package epstopdf-base Info: Redefining graphics rule for \`.eps' on input line 4
85.

(/usr/local/texlive/2026basic/texmf-dist/tex/latex/latexconfig/epstopdf-sys.cfg
File: epstopdf-sys.cfg 2010/07/13 v1.3 Configuration of (r)epstopdf for TeX Liv
e
))
LaTeX Info: Redefining \\microtypecontext on input line 19.
Package microtype Info: Applying patch \`item' on input line 19.
Package microtype Info: Applying patch \`toc' on input line 19.
Package microtype Info: Applying patch \`eqnum' on input line 19.
Package microtype Info: Applying patch \`footnote' on input line 19.
Package microtype Info: Applying patch \`verbatim' on input line 19.
LaTeX Info: Redefining \\microtypesetup on input line 19.
Package microtype Info: Generating PDF output.
Package microtype Info: Character protrusion enabled (level 2).
Package microtype Info: Using default protrusion set \`alltext'.
Package microtype Info: Automatic font expansion enabled (level 2),
(microtype)             stretch: 20, shrink: 20, step: 1, non-selected.
Package microtype Info: Using default expansion set \`alltext-nott'.
Package microtype Info: Patching command \`\\showhyphens'.
Package microtype Info: No adjustment of tracking.
Package microtype Info: No adjustment of interword spacing.
Package microtype Info: No adjustment of character kerning.
 (/usr/local/texlive/2026basic/texmf-dist/tex/latex/microtype/mt-ptm.cfg
File: mt-ptm.cfg 2006/04/20 v1.7 microtype config. file: Times (RS)
)
Package hyperref Info: Link coloring ON on input line 19.

(./main.out) (./main.out)
\\@outlinefile=\\write3
\\openout3 = \`main.out'.


(/usr/local/texlive/2026basic/texmf-dist/tex/latex/microtype/mt-cmr.cfg
File: mt-cmr.cfg 2013/05/19 v2.2 microtype config. file: Computer Modern Roman 
(RS)
)
LaTeX Font Info:    Trying to load font information for U+msa on input line 21.


(/usr/local/texlive/2026basic/texmf-dist/tex/latex/amsfonts/umsa.fd
File: umsa.fd 2013/01/14 v3.01 AMS symbols A
)
(/usr/local/texlive/2026basic/texmf-dist/tex/latex/microtype/mt-msa.cfg
File: mt-msa.cfg 2006/02/04 v1.1 microtype config. file: AMS symbols (a) (RS)
)
LaTeX Font Info:    Trying to load font information for U+msb on input line 21.


(/usr/local/texlive/2026basic/texmf-dist/tex/latex/amsfonts/umsb.fd
File: umsb.fd 2013/01/14 v3.01 AMS symbols B
)
(/usr/local/texlive/2026basic/texmf-dist/tex/latex/microtype/mt-msb.cfg
File: mt-msb.cfg 2005/06/01 v1.0 microtype config. file: AMS symbols (b) (RS)
)
Package microtype Info: Loading generic protrusion settings for font family
(microtype)             \`cmtt' (encoding: T1).
(microtype)             For optimal results, create family-specific settings.
(microtype)             See the microtype manual for details.

[1


{~/Library/texlive/2026basic/texmf-var/fonts/map/pdftex/updmap/pd
ftex.map}{/usr/local/texlive/2026basic/texmf-dist/fonts/enc/dvips/base/8r.enc}{
/usr/local/texlive/2026basic/texmf-dist/fonts/enc/dvips/cm-super/cm-super-t1.en
c}]
<figures/scaled-dot-product-attention.png, id=77, 152.2488pt x 281.1303pt>
File: figures/scaled-dot-product-attention.png Graphic file (type png)
<use figures/scaled-dot-product-attention.png>
Package pdftex.def Info: figures/scaled-dot-product-attention.png  used on inpu
t line 70.
(pdftex.def)             Requested size: 88.06274pt x 162.6075pt.
<figures/multi-head-attention.png, id=78, 234.1548pt x 257.763pt>
File: figures/multi-head-attention.png Graphic file (type png)
<use figures/multi-head-attention.png>
Package pdftex.def Info: figures/multi-head-attention.png  used on input line 7
2.
(pdftex.def)             Requested size: 147.71838pt x 162.6075pt.
 [2 <./figures/scaled-dot-product-attention.png (PNG copy)> <./figures/multi-he
ad-attention.png (PNG copy)>] (./main.bbl [3]) [4] (./main.aux)
 ***********
LaTeX2e <2025-11-01>
L3 programming layer <2026-01-19>
 ***********
Package rerunfilecheck Info: File \`main.out' has not changed.
(rerunfilecheck)             Checksum: 12CD53C7434277075FD3B8D35ADA3A55;1723.
 ) 
Here is how much of TeX's memory you used:
 13624 strings out of 469006
 210444 string characters out of 5454813
 667869 words of memory out of 5000000
 41970 multiletter control sequences out of 15000+600000
 656389 words of font info for 157 fonts, out of 8000000 for 9000
 319 hyphenation exceptions out of 8191
 75i,8n,79p,1001b,574s stack positions out of 10000i,1000n,20000p,200000b,200000s
</usr/local/texlive/2026basic/texmf-dist/fonts/type1/public/amsfonts/cm/cmex1
0.pfb></usr/local/texlive/2026basic/texmf-dist/fonts/type1/public/amsfonts/cm/c
mmi10.pfb></usr/local/texlive/2026basic/texmf-dist/fonts/type1/public/amsfonts/
cm/cmmi7.pfb></usr/local/texlive/2026basic/texmf-dist/fonts/type1/public/amsfon
ts/cm/cmr10.pfb></usr/local/texlive/2026basic/texmf-dist/fonts/type1/public/ams
fonts/cm/cmr7.pfb></usr/local/texlive/2026basic/texmf-dist/fonts/type1/public/a
msfonts/cm/cmsy10.pfb></usr/local/texlive/2026basic/texmf-dist/fonts/type1/publ
ic/amsfonts/cm/cmsy7.pfb></usr/local/texlive/2026basic/texmf-dist/fonts/type1/p
ublic/amsfonts/symbols/msbm10.pfb></usr/local/texlive/2026basic/texmf-dist/font
s/type1/public/cm-super/sftt1000.pfb></usr/local/texlive/2026basic/texmf-dist/f
onts/type1/urw/times/utmb8a.pfb></usr/local/texlive/2026basic/texmf-dist/fonts/
type1/urw/times/utmr8a.pfb></usr/local/texlive/2026basic/texmf-dist/fonts/type1
/urw/times/utmri8a.pfb>
Output written on main.pdf (4 pages, 276049 bytes).
PDF statistics:
 185 PDF objects out of 1000 (max. 8388607)
 149 compressed objects within 2 object streams
 30 named destinations out of 1000 (max. 500000)
 30803 words of extra memory for PDF output out of 35830 (max. 10000000)

`,N={pages:4,durationMs:j,warnings:M,log:we}})))()}var Ee;function De(){return(De=e((()=>{Ee=``+new URL(`main-Dz_ek6sv.pdf`,import.meta.url).href})))()}var P;function Oe(){return(Oe=e((()=>{P=`> The abstract and introduction of Devlin et al. (2019), from the ACL Anthology ([N19-1423](https://aclanthology.org/N19-1423/)), © the authors, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). In Lattice, adding a paper keeps its whole text beside your project.

## Abstract

We introduce a new language representation model called BERT, which stands for Bidirectional Encoder Representations from Transformers. Unlike recent language representation models (Peters et al., 2018a; Radford et al., 2018), BERT is designed to pre-train deep bidirectional representations from unlabeled text by jointly conditioning on both left and right context in all layers. As a result, the pre-trained BERT model can be fine-tuned with just one additional output layer to create state-of-the-art models for a wide range of tasks, such as question answering and language inference, without substantial task-specific architecture modifications.

BERT is conceptually simple and empirically powerful. It obtains new state-of-the-art results on eleven natural language processing tasks, including pushing the GLUE score to 80.5% (7.7% point absolute improvement), MultiNLI accuracy to 86.7% (4.6% absolute improvement), SQuAD v1.1 question answering Test F1 to 93.2 (1.5 point absolute improvement) and SQuAD v2.0 Test F1 to 83.1 (5.1 point absolute improvement).

## 1 Introduction

Language model pre-training has been shown to be effective for improving many natural language processing tasks (Dai and Le, 2015; Peters et al., 2018a; Radford et al., 2018; Howard and Ruder, 2018). These include sentence-level tasks such as natural language inference (Bowman et al., 2015; Williams et al., 2018) and paraphrasing (Dolan and Brockett, 2005), which aim to predict the relationships between sentences by analyzing them holistically, as well as token-level tasks such as named entity recognition and question answering, where models are required to produce fine-grained output at the token level (Tjong Kim Sang and De Meulder, 2003; Rajpurkar et al., 2016).

There are two existing strategies for applying pre-trained language representations to downstream tasks: feature-based and fine-tuning. The feature-based approach, such as ELMo (Peters et al., 2018a), uses task-specific architectures that include the pre-trained representations as additional features. The fine-tuning approach, such as the Generative Pre-trained Transformer (OpenAI GPT) (Radford et al., 2018), introduces minimal task-specific parameters, and is trained on the downstream tasks by simply fine-tuning all pre-trained parameters. The two approaches share the same objective function during pre-training, where they use unidirectional language models to learn general language representations.

We argue that current techniques restrict the power of the pre-trained representations, especially for the fine-tuning approaches. The major limitation is that standard language models are unidirectional, and this limits the choice of architectures that can be used during pre-training. For example, in OpenAI GPT, the authors use a left-to-right architecture, where every token can only attend to previous tokens in the self-attention layers of the Transformer (Vaswani et al., 2017). Such restrictions are sub-optimal for sentence-level tasks, and could be very harmful when applying fine-tuning based approaches to token-level tasks such as question answering, where it is crucial to incorporate context from both directions.

In this paper, we improve the fine-tuning based approaches by proposing BERT: Bidirectional Encoder Representations from Transformers. BERT alleviates the previously mentioned unidirectionality constraint by using a "masked language model" (MLM) pre-training objective, inspired by the Cloze task (Taylor, 1953). The masked language model randomly masks some of the tokens from the input, and the objective is to predict the original vocabulary id of the masked word based only on its context. Unlike left-to-right language model pre-training, the MLM objective enables the representation to fuse the left and the right context, which allows us to pre-train a deep bidirectional Transformer. In addition to the masked language model, we also use a "next sentence prediction" task that jointly pre-trains text-pair representations. The contributions of our paper are as follows:

- We demonstrate the importance of bidirectional pre-training for language representations. Unlike Radford et al. (2018), which uses unidirectional language models for pre-training, BERT uses masked language models to enable pre-trained deep bidirectional representations. This is also in contrast to Peters et al. (2018a), which uses a shallow concatenation of independently trained left-to-right and right-to-left LMs.
- We show that pre-trained representations reduce the need for many heavily-engineered task-specific architectures. BERT is the first fine-tuning based representation model that achieves state-of-the-art performance on a large suite of sentence-level and token-level tasks, outperforming many task-specific architectures.
- BERT advances the state of the art for eleven NLP tasks. The code and pre-trained models are available at https://github.com/google-research/bert.
`})))()}var F;function ke(){return(ke=e((()=>{F=`> The abstract and introduction of Jain and Wallace (2019), from the ACL Anthology ([N19-1357](https://aclanthology.org/N19-1357/)), © the authors, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Figure 1 and the footnotes are left out. In Lattice, adding a paper keeps its whole text beside your project.

## Abstract

Attention mechanisms have seen wide adoption in neural NLP models. In addition to improving predictive performance, these are often touted as affording transparency: models equipped with attention provide a distribution over attended-to input units, and this is often presented (at least implicitly) as communicating the relative importance of inputs. However, it is unclear what relationship exists between attention weights and model outputs. In this work we perform extensive experiments across a variety of NLP tasks that aim to assess the degree to which attention weights provide meaningful "explanations" for predictions. We find that they largely do not. For example, learned attention weights are frequently uncorrelated with gradient-based measures of feature importance, and one can identify very different attention distributions that nonetheless yield equivalent predictions. Our findings show that standard attention modules do not provide meaningful explanations and should not be treated as though they do. Code to reproduce all experiments is available at https://github.com/successar/AttentionExplanation.

## 1 Introduction and Motivation

Attention mechanisms (Bahdanau et al., 2014) induce conditional distributions over input units to compose a weighted context vector for downstream modules. These are now a near-ubiquitous component of neural NLP architectures. Attention weights are often claimed (implicitly or explicitly) to afford insights into the "inner-workings" of models: for a given output one can inspect the inputs to which the model assigned large attention weights. Li et al. (2016) summarized this commonly held view in NLP: "Attention provides an important way to explain the workings of neural models". Indeed, claims that attention provides interpretability are common in the literature, e.g., (Xu et al., 2015; Choi et al., 2016; Lei et al., 2017; Martins and Astudillo, 2016; Xie et al., 2017).

Implicit in this is the assumption that the input units (e.g., words) accorded high attention weights are responsible for model outputs. But as far as we are aware, this assumption has not been formally evaluated, and our findings here suggest that it is problematic. More specifically, we empirically investigate the relationship between attention weights, inputs, and outputs. Assuming attention provides an explanation for model predictions, we might expect the following properties to hold. (i) Attention weights should correlate with feature importance measures (e.g., gradient-based measures); (ii) Alternative (or counterfactual) attention weight configurations ought to yield corresponding changes in prediction (and if they do not then are equally plausible as explanations). We report that neither property is consistently observed by standard attention mechanisms in the context of text classification, question answering (QA), and Natural Language Inference (NLI) tasks when RNN encoders are used.

Consider Figure 1. The left panel shows the original attention distribution α over the words of a particular movie review using a standard attentive BiLSTM architecture for sentiment analysis. It is tempting to conclude from this that the token *waste* is largely responsible for the model coming to its disposition of 'negative' (ŷ = 0.01). But one can construct an alternative attention distribution α̃ (right panel) that attends to entirely different tokens yet yields an essentially identical prediction (holding all other parameters of f, θ, constant).

Such counterfactual distributions imply that explaining the original prediction by highlighting attended-to tokens is misleading insofar as alternative attention distributions would have yielded an equivalent prediction (e.g., one might conclude from the right panel that model output was due primarily to *was* rather than *waste*). Further, the attention weights in this case correlate only weakly with gradient-based measures of feature importance (τg = 0.29). And arbitrarily permuting the entries in α yields a median output difference of 0.006 with the original prediction.

These and similar findings call into question the view that attention provides meaningful insight into model predictions. We thus caution against using attention weights to highlight input tokens "responsible for" model outputs and constructing just-so stories on this basis, particularly with complex encoders.
`})))()}var I;function Ae(){return(Ae=e((()=>{I=`> The abstract and introduction of Clark et al. (2019), from the ACL Anthology ([W19-4828](https://aclanthology.org/W19-4828/)), © the authors, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Figure 1 and the footnotes are left out. In Lattice, adding a paper keeps its whole text beside your project.

## Abstract

Large pre-trained neural networks such as BERT have had great recent success in NLP, motivating a growing body of research investigating what aspects of language they are able to learn from unlabeled data. Most recent analysis has focused on model outputs (e.g., language model surprisal) or internal vector representations (e.g., probing classifiers). Complementary to these works, we propose methods for analyzing the attention mechanisms of pre-trained models and apply them to BERT. BERT's attention heads exhibit patterns such as attending to delimiter tokens, specific positional offsets, or broadly attending over the whole sentence, with heads in the same layer often exhibiting similar behaviors. We further show that certain attention heads correspond well to linguistic notions of syntax and coreference. For example, we find heads that attend to the direct objects of verbs, determiners of nouns, objects of prepositions, and coreferent mentions with remarkably high accuracy. Lastly, we propose an attention-based probing classifier and use it to further demonstrate that substantial syntactic information is captured in BERT's attention.

## 1 Introduction

Large pre-trained language models achieve very high accuracy when fine-tuned on supervised tasks (Dai and Le, 2015; Peters et al., 2018; Radford et al., 2018), but it is not fully understood why. The strong results suggest pre-training teaches the models about the structure of language, but what specific linguistic features do they learn?

Recent work has investigated this question by examining the outputs of language models on carefully chosen input sentences (Linzen et al., 2016) or examining the internal vector representations of the model through methods such as probing classifiers (Adi et al., 2017; Belinkov et al., 2017). Complementary to these approaches, we study the attention maps of a pre-trained model. Attention (Bahdanau et al., 2015) has been a highly successful neural network component. It is naturally interpretable because an attention weight has a clear meaning: how much a particular word will be weighted when computing the next representation for the current word. Our analysis focuses on the 144 attention heads in BERT (Devlin et al., 2019), a large pre-trained Transformer (Vaswani et al., 2017) network that has demonstrated excellent performance on many tasks.

We first explore generally how the attention heads behave. We find that there are common patterns in their behavior, such as attending to fixed positional offsets or attending broadly over the whole sentence. A surprisingly large amount of BERT's attention focuses on the deliminator token [SEP], which we argue is used by the model as a sort of no-op. Generally we find that attention heads in the same layer tend to behave similarly.

We next probe each attention head for linguistic phenomena. In particular, we treat each attention head as a simple no-training-required classifier that, given a word as input, outputs the most-attended-to other word. We then evaluate the ability of the heads to classify various syntactic relations. While no single head performs well at many relations, we find that particular heads correspond remarkably well to particular relations. For example, we find heads that find direct objects of verbs, determiners of nouns, objects of prepositions, and objects of possesive pronouns with >75% accuracy. We perform a similar analysis for coreference resolution, also finding a BERT head that performs quite well. These results are intriguing because the behavior of the attention heads emerges purely from self-supervised training on unlabeled data, without explicit supervision for syntax or coreference.

Our findings show that particular heads specialize to specific aspects of syntax. To get a more overall measure of the attention heads' syntactic ability, we propose an attention-based probing classifier that takes attention maps as input. The classifier achieves 77 UAS at dependency parsing, showing BERT's attention captures a substantial amount about syntax. Several recent works have proposed incorporating syntactic information to improve attention (Eriguchi et al., 2016; Chen et al., 2018; Strubell et al., 2018). Our work suggests that to an extent this kind of syntax-aware attention already exists in BERT, which may be one of the reason for its success.
`})))()}function L(e){return/## Abstract\n\n([^\n]+)/.exec(e)?.[1]??``}function je(e){let t=[[`author`,e.author],[`title`,e.title],[`booktitle`,e.booktitle],[`journal`,e.journal],[`year`,e.year],[`doi`,e.doi],[`url`,e.arxivId?``:e.url],[`eprint`,e.arxivId],[`archiveprefix`,e.arxivId?`arXiv`:``]].filter(([,e])=>e).map(([e,t])=>`  ${e.padEnd(13)} = {${t}},`).join(`
`);return`@${e.entryType}{${e.key},\n${t}\n}`}function Me(e){let t=h(e).flatMap(({bibtex:e})=>{let t=g(e);if(!t)return[];let n=t=>p(e,t).replace(/\s+/g,` `).trim(),r=n(`eprint`);return[{key:t,entryType:/^\s*@(\w+)/.exec(e)?.[1]?.toLowerCase()??`misc`,title:n(`title`),author:n(`author`),year:n(`year`),booktitle:n(`booktitle`),journal:n(`journal`),arxivId:r,doi:n(`doi`),url:r?`https://arxiv.org/abs/${r}`:n(`url`),bibtex:e.trim()}]}),n=He.filter(e=>!t.some(t=>t.key===e.key)).map(e=>{let t={...e,entryType:`inproceedings`,journal:``};return{...t,bibtex:je(t)}});return[...t,...n]}function Ne(e,t){let n=t.trim(),r=Me(e);if(n.startsWith(`@`)){let e=g(n),t=p(n,`eprint`),i=G(p(n,`title`));return r.find(n=>n.key===e||t&&n.arxivId===t||i&&G(n.title)===i)}let i=Ue.exec(n)?.[1]??/^10\.48550\/arxiv\.(\d{4}\.\d{4,5})$/i.exec(W.exec(n)?.[1]??``)?.[1];if(i)return r.find(e=>e.arxivId===i);let a=W.exec(n)?.[1].toLowerCase();if(a)return r.find(e=>e.doi.toLowerCase()===a);if(/^https?:\/\//i.test(n))return r.find(e=>e.url&&n.replace(/\/?$/,`/`)===e.url.replace(/\/?$/,`/`));let o=G(n);if(!(o.length<6))return r.find(e=>G(e.title)===o)??r.find(e=>G(e.title).includes(o))}function Pe(e){return{key:e.key,title:e.title,author:e.author,year:e.year,journal:e.journal,booktitle:e.booktitle,publisher:``,url:e.url,doi:e.doi,entryType:e.entryType,bibtex:e.bibtex,candidates:[],extraFields:e.arxivId?{eprint:e.arxivId,archiveprefix:`arXiv`}:{}}}function Fe(e,t){let n=e.title.replace(/[{}]/g,``),r=V.some(t=>t.citationKey===e.key||e.arxivId&&t.arxivId===e.arxivId);h(t.files).some(({bibtex:t})=>g(t)?.toLowerCase()===e.key.toLowerCase())||t.cite(e.key,e.bibtex);let i=[R,z,B].find(t=>t.arxivId===e.arxivId);return r||V.unshift(i??{arxivId:e.arxivId,citationKey:e.key,year:e.year,title:n,authors:e.author.replace(/[{}]/g,``),hasFullText:!1,hasBlog:!1,...e.doi?{doi:e.doi}:{},...e.url?{url:e.url}:{}}),{arxivId:e.arxivId,title:n,citationKey:e.key,alreadyImported:r,...i?{paperPath:`.research/papers/${e.arxivId}/paper.md`}:e.arxivId&&!r?{fetchError:Ve(t.zh)}:{}}}function Ie(e,t,n){let{zh:r}=n;switch(e){case`list_papers`:return V;case`refresh_citation_health`:return{};case`search_literature`:return{hits:(t?.page??0)===0?Be:[],hasMore:!1};case`read_paper`:{let e=ze.get(String(t?.arxivId??``));if(!e)throw H(r);return e}case`read_paper_blog_local`:return null;case`fetch_paper`:{let e=String(t?.arxivId??``),n=[R,z,B].find(t=>t.arxivId===e);return n?new Promise(t=>setTimeout(()=>{V.includes(n)||V.unshift(n),t({arxivId:e,paperPath:`.research/papers/${e}/paper.md`,blogPath:null})},1200)):Promise.reject(H(r))}case`fetch_web_reference`:return Promise.reject(H(r));case`cancel_paper_fetch`:return!1;case`resolve_citation_query`:{let e=Ne(n.files,String(t?.query??``));return Le(()=>{if(!e)throw U(r);return Pe(e)},500)}case`import_reference`:{let e=Ne(n.files,String(t?.input??``));return Le(()=>{if(!e)throw U(r);return Fe(e,n)},900)}default:return n.notFound}}function Le(e,t){return new Promise((n,r)=>setTimeout(()=>{try{n(e())}catch(e){r(e)}},t))}function Re(e){return V.filter(t=>t.hasFullText&&e(t.title)).map(e=>({kind:`paper`,path:`.research/papers/${e.arxivId}/paper.md`,title:e.title,snippet:e.title,line:null,arxivId:e.arxivId}))}var ze,R,z,B,V,Be,H,U,Ve,He,Ue,W,G;function We(){return(We=e((()=>{v(),Oe(),ke(),Ae(),ze=new Map([[`1810.04805`,P],[`1902.10186`,F],[`1906.04341`,I]]),R={arxivId:`1810.04805`,doi:`10.18653/v1/N19-1423`,url:`https://aclanthology.org/N19-1423/`,citationKey:`devlin2019bert`,year:`2019`,title:`BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding`,authors:`Devlin, Jacob and Chang, Ming-Wei and Lee, Kenton and Toutanova, Kristina`,hasFullText:!0,hasBlog:!1},z={arxivId:`1902.10186`,doi:`10.18653/v1/N19-1357`,url:`https://aclanthology.org/N19-1357/`,citationKey:`jain2019attention`,year:`2019`,title:`Attention is not Explanation`,authors:`Jain, Sarthak and Wallace, Byron C.`,hasFullText:!0,hasBlog:!1},B={arxivId:`1906.04341`,doi:`10.18653/v1/W19-4828`,url:`https://aclanthology.org/W19-4828/`,citationKey:`clark2019what`,year:`2019`,title:`What Does BERT Look at? An Analysis of BERT's Attention`,authors:`Clark, Kevin and Khandelwal, Urvashi and Levy, Omer and Manning, Christopher D.`,hasFullText:!0,hasBlog:!1},V=[R,z,{arxivId:`1706.03762`,citationKey:`vaswani2017attention`,year:`2017`,title:`Attention Is All You Need`,hasFullText:!1,hasBlog:!1,authors:`Vaswani, Ashish and Shazeer, Noam and Parmar, Niki and Uszkoreit, Jakob and Jones, Llion and Gomez, Aidan N. and Kaiser, Lukasz and Polosukhin, Illia`},{arxivId:`1409.0473`,citationKey:`bahdanau2015neural`,year:`2015`,title:`Neural Machine Translation by Jointly Learning to Align and Translate`,authors:`Bahdanau, Dzmitry and Cho, Kyunghyun and Bengio, Yoshua`,hasFullText:!1,hasBlog:!1}],Be=[{source:`openalex`,arxivId:B.arxivId,title:B.title,year:2019,authors:[`Kevin Clark`,`Urvashi Khandelwal`,`Omer Levy`,`Christopher D. Manning`],doi:B.doi,landingUrl:B.url,abstract:L(I)},{source:`openalex`,arxivId:z.arxivId,title:z.title,year:2019,authors:[`Sarthak Jain`,`Byron C. Wallace`],doi:z.doi,landingUrl:z.url,abstract:L(F)},{source:`openalex`,arxivId:R.arxivId,title:R.title,year:2019,authors:[`Jacob Devlin`,`Ming-Wei Chang`,`Kenton Lee`,`Kristina Toutanova`],doi:R.doi,landingUrl:R.url,abstract:L(P)},{source:`alphaxiv`,arxivId:`1706.03762`,title:`Attention Is All You Need`,year:2017,authors:[]},{source:`openalex`,title:`Attention is not not Explanation`,year:2019,authors:[`Sarah Wiegreffe`,`Yuval Pinter`],doi:`10.18653/v1/D19-1002`,landingUrl:`https://aclanthology.org/D19-1002/`},{source:`openalex`,title:`Effective Approaches to Attention-based Neural Machine Translation`,year:2015,authors:[`Minh-Thang Luong`,`Hieu Pham`,`Christopher D. Manning`],doi:`10.18653/v1/d15-1166`,landingUrl:`https://doi.org/10.18653/v1/d15-1166`}],H=e=>Error(e?`下载论文需要 Mac 上的 Lattice。在这个演示里，可以添加来自 ACL Anthology 的论文。`:`Downloading papers needs Lattice on your Mac. In this demo, the papers from the ACL Anthology can be added.`),U=e=>Error(e?`添加新论文需要 Mac 上的 Lattice。这个演示只认得它的参考文献和论文库里的论文。`:`Adding new papers needs Lattice on your Mac. This demo knows only the papers in its bibliography and library.`),Ve=e=>e?`下载全文需要 Mac 上的 Lattice。`:`Downloading the full text needs Lattice on your Mac.`,He=[{key:B.citationKey,title:B.title,author:B.authors,year:`2019`,arxivId:B.arxivId,doi:B.doi,url:B.url,booktitle:`Proceedings of the 2019 ACL Workshop BlackboxNLP: Analyzing and Interpreting Neural Networks for NLP`},{key:z.citationKey,title:z.title,author:z.authors,year:`2019`,arxivId:z.arxivId,doi:z.doi,url:z.url,booktitle:`Proceedings of the 2019 Conference of the North American Chapter of the Association for Computational Linguistics`},{key:`wiegreffe2019attention`,title:`Attention is not not Explanation`,author:`Wiegreffe, Sarah and Pinter, Yuval`,year:`2019`,arxivId:`1908.04626`,doi:`10.18653/v1/D19-1002`,url:`https://aclanthology.org/D19-1002/`,booktitle:`Proceedings of the 2019 Conference on Empirical Methods in Natural Language Processing`}],Ue=/^(?:arxiv:\s*|https?:\/\/(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf|html)\/)?(\d{4}\.\d{4,5})(?:v\d+)?(?:\.pdf)?$/i,W=/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?(10\.\d{4,9}\/\S+)$/i,G=e=>e.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu,``)})))()}var Ge,Ke,K;function qe(){return(qe=e((()=>{Ge=`main.tex`,Ke={1:[1,108,101.19,396,15.36],2:[1,108,101.19,396,15.36],3:[1,108,101.19,396,15.36],4:[1,108,101.19,396,15.36],5:[1,108,101.19,396,15.36],6:[1,108,101.19,396,15.36],7:[1,108,101.19,396,15.36],8:[1,108,101.19,396,15.36],9:[1,108,101.19,396,15.36],10:[1,108,101.19,396,15.36],11:[1,108,101.19,396,15.36],12:[1,108,101.19,396,15.36],13:[1,108,101.19,396,15.36],14:[1,108,101.19,396,15.36],15:[1,108,101.19,396,15.36],16:[1,108,101.19,396,15.36],17:[1,108,101.19,396,15.36],18:[1,108,101.19,396,15.36],19:[1,108,101.19,396,15.36],20:[1,108,101.19,396,15.36],21:[1,108,101.19,396,15.36],22:[1,118.96,266.44,350.83,8.91],23:[1,118.96,266.44,350.83,8.91],24:[1,143.87,288.26,324.27,8.91],25:[1,143.87,320.98,324.27,8.91],26:[1,143.87,342.8,324.27,8.91],27:[1,118.96,266.44,350.83,8.91],28:[1,118.96,266.44,350.83,8.91],29:[1,108,371.77,396,10.66],30:[1,108,371.77,396,10.66],31:[1,108,395.59,396,8.91],32:[1,108,395.59,396,8.91],33:[1,108,406.5,396,8.91],34:[1,108,428.32,396.17,8.91],35:[1,108,439.23,396,8.91],36:[1,107.69,466.53,396.48,8.91],37:[1,107.69,466.53,396.48,8.91],38:[1,108,499.25,396,8.91],39:[1,108,510.16,396,8.91],40:[1,108,531.98,397.25,8.91],41:[1,108,542.89,396,8.35],42:[1,108,569.03,396,10.66],43:[1,108,591.15,397.25,10.62],44:[1,108,591.15,397.25,10.62],45:[1,108,603.76,396,8.91],46:[1,209.45,609.42,24,12],47:[1,209.45,610.51,295.22,13.76],48:[1,209.45,610.51,295.22,13.76],49:[1,108,626.98,396,8.91],50:[1,214.9,640.09,24,12],51:[1,214.9,636.89,182.19,24.66],52:[1,214.9,636.89,182.19,24.66],53:[1,214.9,636.89,289.76,24.66],54:[1,214.9,636.89,289.76,24.66],55:[1,108,663.95,396,10.62],56:[1,108,676.57,396,8.91],57:[1,108,698.22,396,9.08],58:[2,108,289.94,396,8.89],59:[2,108,289.94,396,8.89],60:[2,108,289.94,396,8.89],61:[2,108,310.92,396,8.91],62:[2,108,310.92,396,8.91],63:[2,108,321.11,396.35,9.96],64:[2,108,332.02,396.25,9.96],65:[2,108,343.64,396,8.91],66:[2,108,365.46,396,8.91],67:[1,72,60,24,12],68:[1,72,60,24,12],69:[2,108,-46.08,151.68,280.08],70:[2,108,-46.08,151.68,280.08],71:[2,108,-46.08,482.11,280.08],72:[2,356.83,-22.8,233.28,256.8],73:[2,108,240.97,396.17,13.07],74:[2,108,240.97,396.17,13.07],75:[2,108,394.59,396,8.38],76:[2,108,394.59,396,8.38],77:[2,108,394.59,396,8.38],78:[2,108,420.52,396,8.91],79:[2,108,420.52,396,8.91],80:[2,108,431.43,396,8.91],81:[2,108,431.43,396,8.91],82:[2,261.97,467.09,145.09,11.37],83:[2,261.97,467.09,145.09,11.37],84:[2,261.97,467.09,145.09,11.37],85:[2,108,489.07,396,8.91],86:[2,108,510.89,396,8.91],87:[2,108,527.28,397.25,8.91],88:[2,108,527.28,397.25,8.91],89:[2,108,549.1,396.17,8.91],90:[2,108,560.01,396,8.91],91:[2,108,581.82,396,8.91],92:[2,108,621.86,396,10.66],93:[2,108,621.86,396,10.66],94:[2,108,647.79,396.17,8.91],95:[2,108,647.79,396.17,8.91],96:[2,108,658.7,396,8.91],97:[2,108,669.61,396,8.91],98:[2,108,691.43,397.25,8.91],99:[2,108,702.34,396,8.91],100:[2,108,702.34,396,8.91],101:[3,107.69,67.85,396.31,13.07],102:[3,107.69,67.85,396.31,13.07],103:[3,107.69,67.85,396.31,13.07],104:[3,107.69,67.85,396.31,13.07],105:[3,209.21,103.5,60.92,10.91],106:[3,209.21,103.5,60.92,10.91],107:[3,209.21,103.5,60.92,10.91],108:[3,153.79,103.5,304.43,10.91],109:[3,209.21,119.62,60.92,10.91],110:[3,153.79,130.53,304.43,10.91],111:[3,209.21,141.43,60.92,10.91],112:[3,209.21,152.34,60.92,10.91],113:[3,153.79,152.34,304.43,10.91],114:[3,108,99.79,396,66.05],115:[3,108,99.79,396,66.05],116:[3,108,187.56,396,10.66],117:[3,108,187.56,396,10.66],118:[3,108,212.2,396,8.91],119:[3,108,212.2,396,8.91],120:[3,108,223.11,396.17,8.91],121:[3,108,244.93,396,8.91],122:[3,108,266.74,396,8.91],123:[2,108,743.13,396,6.75],124:[3,107.64,283.13,396.36,8.91],125:[3,108,294.04,397.25,8.91],126:[3,108,315.86,396,8.91],127:[3,108,337.68,396,8.91],128:[3,108,375.57,396,8.38],129:[3,108,375.57,396,8.38],130:[3,108,400.21,396,8.91],131:[3,108,400.21,396,8.91],132:[3,108,411.12,396,8.91],133:[3,108,432.94,397.25,8.91],134:[3,108,454.76,396,8.91],135:[3,108,481.74,396,10.66],136:[3,108,481.74,396,10.66],137:[3,108,506.38,396,8.91],138:[3,108,506.38,396,8.91],139:[3,108,528.04,396,9.13],140:[3,108,539.11,397.74,8.91],141:[3,108,550.02,396,8.91],142:[3,108,517.29,396.83,8.91],143:[3,108,587.91,396,8.38],144:[3,108,612.55,396,8.91],145:[3,108,612.55,396,8.91],146:[3,108,634.37,396,8.91],147:[3,108,645.28,396,8.91],148:[3,108,645.28,396,8.91],149:[3,108,645.28,396,8.91],150:[4,108,743.13,396,6.75],151:[4,108,743.13,396,6.75],152:[4,108,743.13,396,6.75],153:[4,108,743.13,396,6.75]},K={file:Ge,lines:Ke}})))()}function q(e){return Y.find(t=>t.line>=e)?.box??null}function J([,e,t,n,r],i,a){let o=Math.max(e-i,i-(e+n),0),s=Math.max(t-a,a-(t+r),0);return Math.hypot(o,s)}function Je(e,n){switch(e){case`synctex_view`:{if(String(n?.path??``)!==K.file)return null;let e=q(Math.max(1,Number(n?.line??1)));return e&&{page:e[0],x:e[1],y:e[2],width:e[3],height:e[4]}}case`synctex_edit`:{let e=Number(n?.page),[t,r]=[Number(n?.x),Number(n?.y)],i=Y.filter(({box:t})=>t[0]===e);if(!i.length)throw Error(`No LaTeX source was found for this PDF position.`);let a=i.filter(({box:e})=>J(e,t,r)===0),o=a.length?a.reduce((e,t)=>e.box[3]*e.box[4]<=t.box[3]*t.box[4]?e:t):i.reduce((e,n)=>J(e.box,t,r)<=J(n.box,t,r)?e:n);return{path:K.file,line:o.line}}case`synctex_heading_pages`:return(n?.headings??[]).map(({path:e,line:t})=>e===K.file?q(t)?.[0]??null:null);case`synctex_body_pages`:return null;default:return t}}var Y;function Ye(){return(Ye=e((()=>{qe(),i(),Y=Object.entries(K.lines).map(([e,t])=>({line:Number(e),box:t}))})))()}function Xe(e){let i=new s({root:Ze,id:`understanding-attention`,name:`Understanding Attention`,files:e}),a=new Map([...e].filter(([e,t])=>Q.test(e)&&typeof t==`string`));re(i.files);let c=new Set,u=null,d=l({project:i,seed:()=>`open`,zh:X,author:`Ada`}),f=oe({project:i}),p=Se({project:i}),h={notFound:t,zh:!1,files:i.files,cite:(e,t)=>f.cite(`references.bib`,e,t)},g=me(),_=()=>i.snapshot({rootDocuments:[{path:`main.tex`,name:`Main`,isDefault:!0}],primaryBibliography:`references.bib`,trusted:!0,venue:`neurips`,deadline:null,submissionItems:[]}),v=()=>[...i.files].some(([e,t])=>Q.test(e)&&a.get(e)!==t)||[...a.keys()].some(e=>!i.files.has(e)),b=!1,x=()=>({success:!0,hasPdf:!0,log:N.log,durationMs:180,diagnostics:N.warnings,rootDocument:`main.tex`,venue:`NeurIPS`,steps:[],pages:N.pages,synctex:!0}),S=e=>new Promise(t=>{let n=ie(i.text(`main.tex`)),r=n?[{...y[0],durationMs:388}]:y,a=t=>w.emit(`build-progress`,{projectRoot:i.root,progressId:e?.progressId??null,elapsedMs:r[t-1].startedMs,steps:r.slice(0,t).map((e,n)=>n===t-1?{...e,durationMs:null}:e)});r.forEach((e,t)=>window.setTimeout(()=>a(t+1),e.startedMs));let o=r.at(-1);window.setTimeout(()=>t(n?{success:!1,hasPdf:!0,log:ae(N.log,n.log),durationMs:o.startedMs+o.durationMs,diagnostics:n.diagnostics,rootDocument:`main.tex`,venue:`NeurIPS`,steps:r,pages:null,synctex:!0}:{success:!0,hasPdf:!0,log:N.log,durationMs:o.startedMs+o.durationMs,diagnostics:[...N.warnings,...v()?[{level:`info`,message:Z(`This demo shows the PDF compiled before your edits. Lattice on your Mac compiles them with your TeX.`,`演示里显示的是你修改前编译好的 PDF。Mac 上的 Lattice 会用你的 TeX 编译你的修改。`)}]:[]],rootDocument:`main.tex`,venue:`NeurIPS`,steps:r,pages:N.pages,synctex:!0}),o.startedMs+o.durationMs)});function C(e,a){for(let r of[f,(e,t)=>i.answer(e,t),p,n,d,Je,(e,t)=>Ie(e,t,{...h,zh:X(),files:i.files})]){let n=r(e,a);if(n!==t)return n}switch(e){case`initial_project`:case`open_project`:case`open_tutorial_project`:case`refresh_project`:return _();case`list_project_tree_with_hidden`:return i.tree();case`build_project`:return b?S(a):(b=!0,x());case`read_compiled_pdf`:return u??=fetch(Ee).then(e=>e.arrayBuffer()),u.then(e=>e.slice(0));case`pdf_page_signatures`:throw Error(`The demo has no page signatures.`);case`search_project`:{let e=r(String(a?.query??``));return[...i.search(String(a?.query??``),e),...Re(e)]}case`count_project_words`:{let e=i.text(`main.tex`).replace(/%.*$/gm,``).replace(/\\[a-zA-Z]+\*?(\[[^\]]*\])?/g,` `).match(/[\p{L}\p{N}]+/gu)?.length??0;return{text:e,headers:0,captions:0,total:e,source:`texcount`}}case`list_citations`:return{citations:ee(i.files),skipped:[]};case`list_references`:return{references:ne(i.files),skipped:[]};case`list_citation_usages`:return m(i.files);case`bibliography_audit_scan`:return te(i.files);case`agent_text_task`:return g(a);case`synara_ensure_ready`:throw Error(Z(`The Agent runs in Lattice on your Mac.`,`AI 助手在 Mac 上的 Lattice 里运行。`));case`harper_lint`:case`texlab_diagnostics`:return[];case`run_doctor`:return{ok:!0,summary:``,checks:[`latexmk`,`synctex`,`bibtex`,`pdflatex`,`conference-fonts`,`uv`,`uvx`].map(e=>({name:e,detail:``,ok:!0}))};case`overleaf_status`:return{connected:!1,expired:!1,email:null,name:null,host:`https://www.overleaf.com`};case`overleaf_begin_login`:case`overleaf_poll_login`:throw Error(Z(`Overleaf sync runs in Lattice on your Mac: sign in there, and your projects stay in sync as you write.`,`Overleaf 同步在 Mac 上的 Lattice 里运行：在那里登录后，你的项目会在写作时保持同步。`));case`export_changes_pdf`:throw Error(Z(`Exporting a PDF with changes marked needs Lattice and TeX on your Mac.`,`导出标注修改的 PDF 需要 Mac 上的 Lattice 和 TeX。`));case`search_paper_library`:return[];case`list_unused_symbols`:return{labels:[],citations:[]};case`set_window_material`:return`unsupported`;case`plugin:opener|open_url`:return window.open(String(a?.url??``),`_blank`,`noopener`),null;case`set_native_locale`:case`plugin:window|current_monitor`:case`plugin:window|set_min_size`:case`plugin:webview|set_webview_zoom`:case`plugin:log|log`:case`plugin:updater|check`:case`enable_save_before_close`:case`disable_save_before_close`:case`overleaf_rt_disconnect`:case`align_traffic_lights`:case`plugin:window|title`:case`plugin:window|set_title`:case`watch_project`:case`overleaf_link`:case`git_user_name`:case`set_pdf_copy_text`:return null;case`plugin:dialog|open`:case`plugin:dialog|save`:case`choose_import_entries`:return null;default:return e.startsWith(`list_`)?[]:(c.add(e),null)}}let w=o(C);return{tauri:w,unhandled:c}}var Ze,X,Z,Q;function $(){return($=e((()=>{f(),v(),b(),C(),a(),i(),be(),A(),Te(),De(),We(),Ye(),Ze=`/Lattice Tutorials/Understanding Attention`,X=()=>document.documentElement.lang===`zh-CN`,Z=(e,t)=>X()?t:e,Q=/\.(?:tex|bib|sty|cls)$/})))()}$();export{Xe as installDemoBackend};