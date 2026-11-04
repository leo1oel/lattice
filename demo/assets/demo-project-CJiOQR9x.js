import{n as e}from"./rolldown-runtime-C0FnF6B9.js";import{n as t,r as n}from"./project-HTCPIbGl.js";var r;function i(){return(i=e((()=>{r=`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Attention laboratory</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: Inter, ui-sans-serif, system-ui, sans-serif;
      background: #eeece6;
      color: #23221f;
      --accent: #6757d9;
      --accent-soft: color-mix(in srgb, var(--accent) 12%, Canvas);
      --line: color-mix(in srgb, CanvasText 12%, Canvas);
      --muted: color-mix(in srgb, CanvasText 64%, transparent);
      --panel: color-mix(in srgb, Canvas 96%, transparent);
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: radial-gradient(circle at 15% 0%, #d9d3ff 0, transparent 30%), #eeece6; }
    button, input { font: inherit; }
    button { color: inherit; }
    .shell { width: min(1120px, calc(100% - 32px)); margin: 0 auto; padding: 48px 0 64px; }
    header { max-width: 760px; margin-bottom: 28px; }
    .eyebrow { margin: 0 0 10px; color: var(--accent); font-size: 12px; font-weight: 750; letter-spacing: .1em; text-transform: uppercase; }
    h1 { margin: 0; font-size: clamp(32px, 5vw, 56px); line-height: 1.02; letter-spacing: -.045em; }
    h2 { margin: 0; font-size: 18px; letter-spacing: -.015em; }
    h3 { margin: 0 0 8px; font-size: 14px; }
    p { color: var(--muted); line-height: 1.65; }
    .lede { max-width: 680px; font-size: 17px; }
    .grid { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(280px, .75fr); gap: 16px; align-items: start; }
    .panel { border: 1px solid var(--line); border-radius: 18px; background: var(--panel); box-shadow: 0 18px 50px rgb(40 37 25 / .08); }
    .workspace { padding: 24px; }
    .side { display: grid; gap: 16px; }
    .side .panel { padding: 20px; }
    .control-label { display: block; margin: 22px 0 10px; color: var(--muted); font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }
    .tokens, .heads { display: flex; flex-wrap: wrap; gap: 8px; }
    .token, .head { min-height: 40px; border: 1px solid var(--line); border-radius: 10px; padding: 8px 12px; background: Canvas; cursor: pointer; }
    .token:hover, .head:hover, button:focus-visible { border-color: color-mix(in srgb, var(--accent) 50%, var(--line)); background: var(--accent-soft); }
    button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    button[aria-pressed="true"] { border-color: transparent; background: var(--accent); color: white; }
    .equation { margin: 22px 0; padding: 16px; border-radius: 12px; background: color-mix(in srgb, CanvasText 4%, Canvas); overflow-x: auto; text-align: center; font: 17px Georgia, serif; }
    .temperature-row { display: grid; grid-template-columns: auto 1fr 48px; gap: 12px; align-items: center; margin-bottom: 22px; }
    input[type="range"] { width: 100%; accent-color: var(--accent); }
    output { font-variant-numeric: tabular-nums; }
    .matrix-wrap { overflow-x: auto; }
    .matrix { width: 100%; border-collapse: separate; border-spacing: 6px; font-size: 13px; }
    .matrix th { padding: 6px; color: var(--muted); font-weight: 600; }
    .matrix th:first-child { text-align: right; }
    .matrix td { min-width: 60px; height: 54px; border-radius: 8px; text-align: center; font-variant-numeric: tabular-nums; transition: background 160ms ease-out, color 160ms ease-out, transform 160ms ease-out; }
    .matrix tr.active td { transform: translateY(-1px); }
    .matrix tr.active th { color: var(--accent); }
    .bars { display: grid; gap: 10px; margin-top: 20px; }
    .bar { display: grid; grid-template-columns: 78px 1fr 44px; gap: 10px; align-items: center; font-size: 13px; }
    .track { height: 9px; overflow: hidden; border-radius: 99px; background: color-mix(in srgb, CanvasText 9%, Canvas); }
    .fill { height: 100%; border-radius: inherit; background: var(--accent); transition: width 180ms ease-out; }
    .metric { display: grid; grid-template-columns: 1fr auto; gap: 6px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); font-size: 13px; }
    .metric span { color: var(--muted); }
    .steps { margin: 14px 0 0; padding: 0; list-style: none; counter-reset: steps; }
    .steps li { counter-increment: steps; display: grid; grid-template-columns: 26px 1fr; gap: 10px; padding: 10px 0; border-top: 1px solid var(--line); color: var(--muted); font-size: 13px; line-height: 1.5; }
    .steps li::before { content: counter(steps); display: grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; background: var(--accent-soft); color: var(--accent); font-weight: 750; }
    .callout { border-left: 3px solid var(--accent); padding-left: 14px; }
    .callout strong { display: block; margin-bottom: 4px; }
    footer { margin-top: 18px; color: var(--muted); font-size: 12px; }
    @media (max-width: 820px) { .grid { grid-template-columns: 1fr; } .shell { padding-top: 28px; } }
    @media (max-width: 520px) { .shell { width: min(100% - 20px, 1120px); } .workspace { padding: 16px; } .matrix td { min-width: 48px; } }
    @media (prefers-reduced-motion: reduce) { .matrix td, .fill { transition: none; } }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <p class="eyebrow">Lattice interactive research note</p>
      <h1>Attention laboratory</h1>
      <p class="lede">Choose a head, query token, and temperature to follow scaled dot-product attention from raw compatibility scores to a weighted context vector.</p>
    </header>

    <div class="grid">
      <main class="panel workspace">
        <h2>Interactive attention matrix</h2>
        <p>The values are a designed teaching example, not measurements from a trained model. Every row represents one query and every column represents one key.</p>

        <span class="control-label">Illustrative head</span>
        <div class="heads" role="group" aria-label="Attention head">
          <button class="head" type="button" aria-pressed="true" data-head="0">Head 1 · local</button>
          <button class="head" type="button" aria-pressed="false" data-head="1">Head 2 · relation</button>
          <button class="head" type="button" aria-pressed="false" data-head="2">Head 3 · global</button>
        </div>

        <span class="control-label">Query token</span>
        <div class="tokens" role="group" aria-label="Query token"></div>

        <div class="equation" aria-label="Scaled dot-product attention equation">
          Attention(Q, K, V) = softmax(QK<sup>T</sup> / √d<sub>k</sub>)V
        </div>

        <label class="temperature-row">
          <span>Temperature</span>
          <input id="temperature" type="range" min="0.35" max="2" value="1" step="0.05">
          <output id="temperature-value" for="temperature">1.00</output>
        </label>

        <div class="matrix-wrap">
          <table class="matrix" aria-label="Attention weights">
            <thead><tr id="matrix-head"><th scope="col">Q \\ K</th></tr></thead>
            <tbody id="matrix-body"></tbody>
          </table>
        </div>

        <div class="bars" id="bars" aria-live="polite"></div>
      </main>

      <aside class="side">
        <section class="panel">
          <h2>Read the selected row</h2>
          <p id="selection-copy"></p>
          <div class="metric"><span>Largest weight</span><output id="largest"></output></div>
          <div class="metric"><span>Entropy</span><output id="entropy"></output></div>
          <div class="metric"><span>Weight sum</span><output id="weight-sum"></output></div>
        </section>

        <section class="panel">
          <h2>Computation</h2>
          <ol class="steps">
            <li>Project token representations into query, key, and value spaces.</li>
            <li>Compare one query with every visible key using dot products.</li>
            <li>Scale the scores, then normalize them with softmax.</li>
            <li>Use the resulting weights to mix the value vectors.</li>
          </ol>
        </section>

        <section class="panel callout">
          <strong>A visualization is not a causal explanation.</strong>
          <span>The matrix shows routing weights in one operation. Residual streams, value vectors, later layers, and the task objective also shape the final prediction.</span>
        </section>
      </aside>
    </div>

    <footer>Edit this file to change the sentence, scores, colors, or explanatory copy. Lattice previews the result without leaving the research project.</footer>
  </div>

  <script>
    const tokens = ["attention", "connects", "every", "position"];
    const scoreSets = [
      [
        [1.5, 0.7, 0.1, -0.2],
        [0.4, 1.2, 0.1, 0.8],
        [-0.1, 0.3, 1.4, 0.9],
        [-0.2, 0.5, 0.8, 1.3]
      ],
      [
        [0.8, 1.5, 0.0, 0.4],
        [1.4, 0.5, 0.2, 1.0],
        [0.3, 0.9, 0.5, 1.4],
        [0.7, 1.3, 0.4, 0.6]
      ],
      [
        [0.9, 0.8, 0.7, 1.0],
        [0.8, 0.9, 0.8, 1.0],
        [0.7, 0.8, 0.9, 1.0],
        [0.8, 0.8, 0.8, 0.9]
      ]
    ];
    const headNames = ["local", "relation", "global"];
    const tokenRoot = document.querySelector(".tokens");
    const matrixHead = document.querySelector("#matrix-head");
    const matrixBody = document.querySelector("#matrix-body");
    const bars = document.querySelector("#bars");
    const temperature = document.querySelector("#temperature");
    let selectedHead = 0;
    let selectedQuery = 1;

    tokenRoot.innerHTML = tokens.map((token, index) =>
      \`<button class="token" type="button" data-query="\${index}" aria-pressed="\${index === selectedQuery}">\${token}</button>\`
    ).join("");
    matrixHead.insertAdjacentHTML("beforeend", tokens.map(token => \`<th scope="col">\${token}</th>\`).join(""));

    function softmax(scores, value) {
      const scaled = scores.map(score => score / value);
      const max = Math.max(...scaled);
      const exponents = scaled.map(score => Math.exp(score - max));
      const total = exponents.reduce((sum, item) => sum + item, 0);
      return exponents.map(item => item / total);
    }

    function color(weight, active) {
      const alpha = 0.08 + weight * 0.82;
      return active
        ? \`color-mix(in srgb, var(--accent) \${Math.round(alpha * 100)}%, Canvas)\`
        : \`color-mix(in srgb, var(--accent) \${Math.round(alpha * 55)}%, Canvas)\`;
    }

    function render() {
      const temp = Number(temperature.value);
      const weights = scoreSets[selectedHead].map(row => softmax(row, temp));
      document.querySelector("#temperature-value").value = temp.toFixed(2);
      document.querySelectorAll(".head").forEach((button, index) => button.setAttribute("aria-pressed", String(index === selectedHead)));
      document.querySelectorAll(".token").forEach((button, index) => button.setAttribute("aria-pressed", String(index === selectedQuery)));

      matrixBody.innerHTML = weights.map((row, rowIndex) => \`
        <tr class="\${rowIndex === selectedQuery ? "active" : ""}">
          <th scope="row">\${tokens[rowIndex]}</th>
          \${row.map(weight => \`<td style="background:\${color(weight, rowIndex === selectedQuery)}">\${weight.toFixed(2)}</td>\`).join("")}
        </tr>\`).join("");

      const selected = weights[selectedQuery];
      bars.innerHTML = selected.map((weight, index) => \`
        <div class="bar">
          <span>\${tokens[index]}</span>
          <div class="track"><div class="fill" style="width:\${weight * 100}%"></div></div>
          <output>\${weight.toFixed(2)}</output>
        </div>\`).join("");

      const largestIndex = selected.indexOf(Math.max(...selected));
      const entropy = -selected.reduce((sum, weight) => sum + weight * Math.log2(weight), 0);
      document.querySelector("#selection-copy").textContent = \`In the \${headNames[selectedHead]} head, “\${tokens[selectedQuery]}” assigns its largest weight to “\${tokens[largestIndex]}”. Raise temperature to flatten the row; lower it to concentrate the distribution.\`;
      document.querySelector("#largest").value = \`\${tokens[largestIndex]} · \${selected[largestIndex].toFixed(2)}\`;
      document.querySelector("#entropy").value = \`\${entropy.toFixed(2)} bits\`;
      document.querySelector("#weight-sum").value = selected.reduce((sum, weight) => sum + weight, 0).toFixed(4);
    }

    document.querySelectorAll(".head").forEach(button => button.addEventListener("click", () => {
      selectedHead = Number(button.dataset.head);
      render();
    }));
    document.querySelectorAll(".token").forEach(button => button.addEventListener("click", () => {
      selectedQuery = Number(button.dataset.query);
      render();
    }));
    temperature.addEventListener("input", render);
    render();
  <\/script>
</body>
</html>
`})))()}var a;function o(){return(o=e((()=>{a=`{"tldrawFileFormatVersion":1,"schema":{"schemaVersion":2,"sequences":{"com.tldraw.store":5,"com.tldraw.asset":1,"com.tldraw.camera":1,"com.tldraw.document":2,"com.tldraw.instance":26,"com.tldraw.instance_page_state":5,"com.tldraw.page":1,"com.tldraw.instance_presence":6,"com.tldraw.pointer":1,"com.tldraw.shape":4,"com.tldraw.user":1,"com.tldraw.asset.image":6,"com.tldraw.asset.video":5,"com.tldraw.asset.bookmark":2,"com.tldraw.shape.group":0,"com.tldraw.shape.text":4,"com.tldraw.shape.bookmark":2,"com.tldraw.shape.draw":5,"com.tldraw.shape.geo":11,"com.tldraw.shape.note":13,"com.tldraw.shape.line":5,"com.tldraw.shape.frame":1,"com.tldraw.shape.arrow":8,"com.tldraw.shape.highlight":4,"com.tldraw.shape.embed":4,"com.tldraw.shape.image":5,"com.tldraw.shape.video":4,"com.tldraw.binding.arrow":1}},"records":[{"gridSize":10,"name":"","meta":{},"id":"document:document","typeName":"document"},{"meta":{},"id":"page:page","name":"Page 1","index":"a1","typeName":"page"},{"x":1350,"y":400,"rotation":0,"isLocked":false,"opacity":1,"meta":{},"id":"shape:context","type":"geo","props":{"w":230,"h":120,"geo":"rectangle","dash":"draw","growY":0,"url":"","scale":1,"color":"green","labelColor":"black","fill":"semi","size":"m","font":"sans","align":"middle","verticalAlign":"middle","richText":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Context vectors"}]},{"type":"paragraph","content":[{"type":"text","text":"Information for each token"}]}]}},"parentId":"page:page","index":"a9","typeName":"shape"},{"x":390,"y":610,"rotation":0,"isLocked":false,"opacity":1,"meta":{},"id":"shape:hint","type":"text","props":{"color":"black","size":"m","w":8,"font":"sans","textAlign":"start","autoSize":true,"scale":1,"richText":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Try moving a box, editing a label, or drawing another connection."}]}]}},"parentId":"page:page","index":"aG","typeName":"shape"},{"x":290,"y":397,"rotation":0,"isLocked":false,"opacity":1,"meta":{},"id":"shape:k-to-scores","type":"arrow","props":{"kind":"arc","elbowMidPoint":0.5,"dash":"draw","size":"m","fill":"none","color":"violet","labelColor":"black","bend":0,"start":{"x":0,"y":0},"end":{"x":100,"y":-77},"arrowheadStart":"none","arrowheadEnd":"arrow","richText":{"type":"doc","content":[{"type":"paragraph"}]},"labelPosition":0.5,"font":"draw","scale":1},"parentId":"page:page","index":"aB","typeName":"shape"},{"x":80,"y":345,"rotation":0,"isLocked":false,"opacity":1,"meta":{},"id":"shape:key","type":"geo","props":{"w":210,"h":105,"geo":"rectangle","dash":"draw","growY":0,"url":"","scale":1,"color":"violet","labelColor":"black","fill":"semi","size":"m","font":"sans","align":"middle","verticalAlign":"middle","richText":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Key"}]},{"type":"paragraph","content":[{"type":"text","text":"What do I contain?"}]}]}},"parentId":"page:page","index":"a4","typeName":"shape"},{"x":290,"y":237,"rotation":0,"isLocked":false,"opacity":1,"meta":{},"id":"shape:q-to-scores","type":"arrow","props":{"kind":"arc","elbowMidPoint":0.5,"dash":"draw","size":"m","fill":"none","color":"blue","labelColor":"black","bend":0,"start":{"x":0,"y":0},"end":{"x":100,"y":63},"arrowheadStart":"none","arrowheadEnd":"arrow","richText":{"type":"doc","content":[{"type":"paragraph"}]},"labelPosition":0.5,"font":"draw","scale":1},"parentId":"page:page","index":"aA","typeName":"shape"},{"x":80,"y":185,"rotation":0,"isLocked":false,"opacity":1,"meta":{},"id":"shape:query","type":"geo","props":{"w":210,"h":105,"geo":"rectangle","dash":"draw","growY":0,"url":"","scale":1,"color":"blue","labelColor":"black","fill":"semi","size":"m","font":"sans","align":"middle","verticalAlign":"middle","richText":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Query"}]},{"type":"paragraph","content":[{"type":"text","text":"What am I looking for?"}]}]}},"parentId":"page:page","index":"a3","typeName":"shape"},{"x":390,"y":260,"rotation":0,"isLocked":false,"opacity":1,"meta":{},"id":"shape:scores","type":"geo","props":{"w":220,"h":120,"geo":"rectangle","dash":"draw","growY":0,"url":"","scale":1,"color":"violet","labelColor":"black","fill":"semi","size":"m","font":"sans","align":"middle","verticalAlign":"middle","richText":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Similarity scores"}]},{"type":"paragraph","content":[{"type":"text","text":"QKᵀ / √dₖ"}]}]}},"parentId":"page:page","index":"a6","typeName":"shape"},{"x":610,"y":320,"rotation":0,"isLocked":false,"opacity":1,"meta":{},"id":"shape:scores-to-softmax","type":"arrow","props":{"kind":"arc","elbowMidPoint":0.5,"dash":"draw","size":"m","fill":"none","color":"violet","labelColor":"black","bend":0,"start":{"x":0,"y":0},"end":{"x":100,"y":0},"arrowheadStart":"none","arrowheadEnd":"arrow","richText":{"type":"doc","content":[{"type":"paragraph"}]},"labelPosition":0.5,"font":"draw","scale":1},"parentId":"page:page","index":"aC","typeName":"shape"},{"x":710,"y":260,"rotation":0,"isLocked":false,"opacity":1,"meta":{},"id":"shape:softmax","type":"geo","props":{"w":220,"h":120,"geo":"rectangle","dash":"draw","growY":0,"url":"","scale":1,"color":"orange","labelColor":"black","fill":"semi","size":"m","font":"sans","align":"middle","verticalAlign":"middle","richText":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Softmax"}]},{"type":"paragraph","content":[{"type":"text","text":"Normalize into weights"}]}]}},"parentId":"page:page","index":"a7","typeName":"shape"},{"x":930,"y":320,"rotation":0,"isLocked":false,"opacity":1,"meta":{},"id":"shape:softmax-to-weighted","type":"arrow","props":{"kind":"arc","elbowMidPoint":0.5,"dash":"draw","size":"m","fill":"none","color":"orange","labelColor":"black","bend":0,"start":{"x":0,"y":0},"end":{"x":80,"y":120},"arrowheadStart":"none","arrowheadEnd":"arrow","richText":{"type":"doc","content":[{"type":"paragraph"}]},"labelPosition":0.5,"font":"draw","scale":1},"parentId":"page:page","index":"aD","typeName":"shape"},{"x":72,"y":96,"rotation":0,"isLocked":false,"opacity":1,"meta":{},"id":"shape:subtitle","type":"text","props":{"color":"black","size":"m","w":8,"font":"sans","textAlign":"start","autoSize":true,"scale":1,"richText":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Each box and arrow remains editable in the canvas."}]}]}},"parentId":"page:page","index":"a2","typeName":"shape"},{"x":70,"y":48,"rotation":0,"isLocked":false,"opacity":1,"meta":{},"id":"shape:title","type":"text","props":{"color":"black","size":"xl","w":8,"font":"sans","textAlign":"start","autoSize":true,"scale":1,"richText":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"How scaled dot-product attention moves information"}]}]}},"parentId":"page:page","index":"a1","typeName":"shape"},{"x":80,"y":545,"rotation":0,"isLocked":false,"opacity":1,"meta":{},"id":"shape:value","type":"geo","props":{"w":210,"h":105,"geo":"rectangle","dash":"draw","growY":0,"url":"","scale":1,"color":"green","labelColor":"black","fill":"semi","size":"m","font":"sans","align":"middle","verticalAlign":"middle","richText":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Value"}]},{"type":"paragraph","content":[{"type":"text","text":"What information do I carry?"}]}]}},"parentId":"page:page","index":"a5","typeName":"shape"},{"x":290,"y":597,"rotation":0,"isLocked":false,"opacity":1,"meta":{},"id":"shape:value-to-weighted","type":"arrow","props":{"kind":"arc","elbowMidPoint":0.5,"dash":"draw","size":"m","fill":"none","color":"green","labelColor":"black","bend":0,"start":{"x":0,"y":0},"end":{"x":720,"y":-137},"arrowheadStart":"none","arrowheadEnd":"arrow","richText":{"type":"doc","content":[{"type":"paragraph"}]},"labelPosition":0.5,"font":"draw","scale":1},"parentId":"page:page","index":"aE","typeName":"shape"},{"x":1010,"y":400,"rotation":0,"isLocked":false,"opacity":1,"meta":{},"id":"shape:weighted","type":"geo","props":{"w":230,"h":120,"geo":"rectangle","dash":"draw","growY":0,"url":"","scale":1,"color":"yellow","labelColor":"black","fill":"semi","size":"m","font":"sans","align":"middle","verticalAlign":"middle","richText":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Weighted sum"}]},{"type":"paragraph","content":[{"type":"text","text":"Attention weights × V"}]}]}},"parentId":"page:page","index":"a8","typeName":"shape"},{"x":1240,"y":460,"rotation":0,"isLocked":false,"opacity":1,"meta":{},"id":"shape:weighted-to-context","type":"arrow","props":{"kind":"arc","elbowMidPoint":0.5,"dash":"draw","size":"m","fill":"none","color":"green","labelColor":"black","bend":0,"start":{"x":0,"y":0},"end":{"x":110,"y":0},"arrowheadStart":"none","arrowheadEnd":"arrow","richText":{"type":"doc","content":[{"type":"paragraph"}]},"labelPosition":0.5,"font":"draw","scale":1},"parentId":"page:page","index":"aF","typeName":"shape"}]}
`})))()}var s;function c(){return(c=e((()=>{s=`{
  "format": "lattice-spreadsheet",
  "version": 1,
  "workbook": {
    "id": "tutorial_attention_results",
    "name": "Attention experiment results",
    "appVersion": "0.25.1",
    "locale": "enUS",
    "styles": {
      "title": {
        "bl": 1,
        "ff": "Georgia",
        "fs": 16,
        "bg": { "rgb": "#475569" },
        "cl": { "rgb": "#FFFFFF" },
        "ht": 2,
        "vt": 2
      },
      "header": {
        "bl": 1,
        "ff": "Inter Variable",
        "bg": { "rgb": "#DCE3EA" },
        "cl": { "rgb": "#1F2937" },
        "ht": 2,
        "vt": 2
      },
      "percent": {
        "n": { "pattern": "0.0%" }
      },
      "summary": {
        "bl": 1,
        "bg": { "rgb": "#E2E8F0" }
      },
      "summaryPercent": {
        "bl": 1,
        "bg": { "rgb": "#E2E8F0" },
        "n": { "pattern": "0.0%" }
      },
      "section": {
        "bl": 1,
        "ff": "Inter Variable",
        "bg": { "rgb": "#CBD5E1" },
        "cl": { "rgb": "#1F2937" },
        "ht": 2
      },
      "demoBold": {
        "bl": 1,
        "bg": { "rgb": "#FEF3C7" }
      },
      "demoItalic": {
        "it": 1,
        "bg": { "rgb": "#DBEAFE" }
      },
      "demoUnderline": {
        "ul": { "s": 1 },
        "bg": { "rgb": "#DCFCE7" }
      },
      "demoFont": {
        "ff": "Courier New",
        "bg": { "rgb": "#FCE7F3" }
      },
      "demoMerged": {
        "bl": 1,
        "it": 1,
        "bg": { "rgb": "#EDE9FE" },
        "cl": { "rgb": "#5B21B6" },
        "ht": 2
      },
      "note": {
        "it": 1,
        "fs": 9,
        "cl": { "rgb": "#64748B" }
      }
    },
    "sheetOrder": ["results"],
    "sheets": {
      "results": {
        "id": "results",
        "name": "Illustrative results",
        "rowCount": 1000,
        "columnCount": 52,
        "cellData": {
          "0": {
            "0": { "v": "Attention experiment results", "t": 1, "s": "title" }
          },
          "1": {
            "0": { "v": "Configuration", "t": 1, "s": "header" },
            "1": { "v": "Heads", "t": 1, "s": "header" },
            "2": { "v": "Accuracy", "t": 1, "s": "header" },
            "3": { "v": "Latency (ms)", "t": 1, "s": "header" },
            "4": { "v": "Throughput", "t": 1, "s": "header" },
            "5": { "v": "vs. baseline", "t": 1, "s": "header" }
          },
          "2": {
            "0": { "v": "Baseline" },
            "1": { "v": 1 },
            "2": { "v": 0.764, "s": "percent" },
            "3": { "v": 12.8 },
            "4": { "v": 780 },
            "5": { "f": "=C3/$C$3", "s": "percent" }
          },
          "3": {
            "0": { "v": "Two heads" },
            "1": { "v": 2 },
            "2": { "v": 0.772, "s": "percent" },
            "3": { "v": 13.1 },
            "4": { "v": 752 },
            "5": { "f": "=C4/$C$3", "s": "percent" }
          },
          "4": {
            "0": { "v": "Four heads" },
            "1": { "v": 4 },
            "2": { "v": 0.786, "s": "percent" },
            "3": { "v": 13.7 },
            "4": { "v": 721 },
            "5": { "f": "=C5/$C$3", "s": "percent" }
          },
          "5": {
            "0": { "v": "Eight heads" },
            "1": { "v": 8 },
            "2": { "v": 0.791, "s": "percent" },
            "3": { "v": 14.4 },
            "4": { "v": 684 },
            "5": { "f": "=C6/$C$3", "s": "percent" }
          },
          "7": {
            "0": { "v": "Mean", "s": "summary" },
            "1": { "f": "=AVERAGE(B3:B6)", "s": "summary" },
            "2": { "f": "=AVERAGE(C3:C6)", "s": "summaryPercent" },
            "3": { "f": "=AVERAGE(D3:D6)", "s": "summary" },
            "4": { "f": "=AVERAGE(E3:E6)", "s": "summary" },
            "5": { "f": "=AVERAGE(F3:F6)", "s": "summaryPercent" }
          },
          "9": {
            "0": { "v": "Formatting examples", "t": 1, "s": "section" }
          },
          "10": {
            "0": { "v": "Bold", "s": "demoBold" },
            "1": { "v": "Italic", "s": "demoItalic" },
            "2": { "v": "Underline", "s": "demoUnderline" },
            "3": { "v": "Courier New", "s": "demoFont" },
            "4": { "v": "Merged cells", "s": "demoMerged" }
          },
          "12": {
            "0": { "v": "Edit a cell, or ask Agent to update C3:C6.", "s": "note" }
          }
        },
        "rowData": {
          "0": { "h": 34 },
          "9": { "h": 26 }
        },
        "columnData": {
          "0": { "w": 168 },
          "1": { "w": 72 },
          "2": { "w": 96 },
          "3": { "w": 112 },
          "4": { "w": 104 },
          "5": { "w": 112 }
        },
        "mergeData": [
          { "startRow": 0, "startColumn": 0, "endRow": 0, "endColumn": 5 },
          { "startRow": 9, "startColumn": 0, "endRow": 9, "endColumn": 5 },
          { "startRow": 10, "startColumn": 4, "endRow": 10, "endColumn": 5 },
          { "startRow": 12, "startColumn": 0, "endRow": 12, "endColumn": 5 }
        ],
        "tabColor": "",
        "hidden": 0,
        "freeze": {
          "xSplit": 0,
          "ySplit": 2,
          "startRow": 2,
          "startColumn": 0
        },
        "zoomRatio": 1,
        "scrollTop": 0,
        "scrollLeft": 0,
        "defaultColumnWidth": 88,
        "defaultRowHeight": 24,
        "rowHeader": { "width": 46 },
        "columnHeader": { "height": 24 },
        "showGridlines": 1,
        "rightToLeft": 0
      }
    }
  }
}
`})))()}var l;function u(){return(u=e((()=>{l=`# Figure attribution

\`scaled-dot-product-attention.png\` and \`multi-head-attention.png\` reproduce the two panels of Figure 2 from:

Ashish Vaswani, Noam Shazeer, Niki Parmar, Jakob Uszkoreit, Llion Jones, Aidan N. Gomez, Łukasz Kaiser, and Illia Polosukhin.
“Attention Is All You Need.”
Advances in Neural Information Processing Systems 30, 2017.
https://arxiv.org/abs/1706.03762

The paper states:

> Provided proper attribution is provided, Google hereby grants permission to reproduce the tables and figures in this paper solely for use in journalistic or scholarly works.

The files were retrieved from the arXiv HTML rendering of version 7:

- https://arxiv.org/html/1706.03762v7/Figures/ModalNet-19.png
- https://arxiv.org/html/1706.03762v7/Figures/ModalNet-20.png

The PNG canvases were cropped to remove surrounding transparent whitespace, without changing the figure content.
\`attention-figure-2.pdf\` places the cropped panels side by side and converts them to PDF for LaTeX and figure-preview tutorials.
`})))()}var d;function f(){return(f=e((()=>{d=`%PDF-1.3
1 0 obj
<<
/Pages 2 0 R
/Type /Catalog
>>
endobj
2 0 obj
<<
/Type /Pages
/Kids [ 3 0 R ]
/Count 1
>>
endobj
3 0 obj
<<
/Type /Page
/Parent 2 0 R
/Resources <<
/XObject << /Im0 8 0 R >>
/ProcSet 6 0 R >>
/MediaBox [0 0 610.08 516.96]
/CropBox [0 0 610.08 516.96]
/Contents 4 0 R
/Thumb 11 0 R
>>
endobj
4 0 obj
<<
/Length 5 0 R
>>
stream
q
610.08 0 0 516.96 0 0 cm
/Im0 Do
Q

endstream
endobj
5 0 obj
37
endobj
6 0 obj
[ /PDF /Text /ImageC ]
endobj
7 0 obj
<<
>>
endobj
8 0 obj
<<
/Type /XObject
/Subtype /Image
/Name /Im0
/Filter [ /FlateDecode ]
/Width 1271
/Height 1077
/ColorSpace 10 0 R
/BitsPerComponent 8
/Length 9 0 R
>>
stream
x���Y�����p�{Y���8�s��3G'��g���Ax��ӌ̈�\fP��\bh��6j\`\x1B����� !�j�}i���RkC[cJ/ �a^�O?�ã��'��̪'��'�ᐋ�����ճ}�)�,5����~�{\0���Ɂ��{\0\0����ឞ�F��{G\0\0�S�����l6}�\b\0\0@�����>����Rj�������|�\b\0\0@��F�4����|\0�\bՇG�����\0\0�,\r\f\f�\\ �<�w\x07\0�\r3g��'���q߻\0\0��f��c����G\0���}x��\0\0�����@�}x���I�;\0\0������}��@�5�M5�ipp��~\0\0�5>>��
�O@��)�LL?\0\0J �]Ma9	\0(1�l\\����]\0\0H.0���@D�������\0\0 �����hL?\0�Շ��\0\0@х����|\0(7K��\0\0�6::�����d����j5��\b\0\0�Dl���|\0({exx��n\0\0�grr2�&���\0�\\,SN�fΜ�{O\0\0�c�r��r\0P�)��\0\0��V�9��0�\0��c�^���_\0\0\0W�����9|�\0��އ�gz��f��{�\0\0�̜9������\0P.SN��~
\0\0B[�������\0��˲q}}}��\0\0 ^�^o�>�����\\��\vk4�w\0\0���l�O9eb9	\0(�}x�����\0\0\`��S&����Jև���\0\0@����%�|�\0���244�{�\0\0Zk4�w5_���>\0J M�����\0\0\0�600�u����g�g�YJ�~
\0
'�l\\�V\v_�k��&�������\0\0�rJ�a�ۨ�5Ӕ�ؘ=�YN\0�%0��[�ȹ=��?88���zC梺\fW\0\x009����}����=�*CCC: ��\0�n����>�ǆ�O����?�U\0\0@�H��{}�����O��v��|�\0E�����?0��%�*���j�J��\0\0�Q��P]����1�*r�Â�\0P�m%��O��!W?_���W\0\0भ�\v\0(�vC.\0\0@�r�j\b�\0\0��\b�\0P5�\\\0\0Pb�\\\0�B.\0\0(1B.\0T\r!\0\0�!\0���\v\0\0J��\v\0UC�\0\0%F���!�\0�#�@�r\0@�r�j\b�\0\0��\b�\0P5�\\\0\0Pb�\\\0�B.\0\0(1B.\0T\r!\0\0�!\0���\v\0\0J��\v\0UC�\0\0%F���!�\0�#�@�r\0@�r�j\b�\0\0��\b�\0P5�\\\0\0Pb�\\\0�B.\0\0(1B.\0T\r!\0\0�!\0���\v\0\0J��\v\0UC�\0\0%F���!�\0�#�@�r\0@�r�j\b�\0\0��\b�\0P5�\\\0\0Pb�\\\0�B.\0\0(1B.\0T\r!\0\0�!\0���\v\0\0J��\v\0UC�\0\0%F���!�\0�#��2999<<<00 '�Z�փ���듿�$z����w\0\0 cQ7\0�\\\0�!�VR���?j��������!\0\0�F�E��\v�
���h��">�.\0�������A��\v��\x1B�K_���]C<����H��h�z�0F%\x004�͖�m�\x07|� ip4<<��#�����k6��ߤ\0\0���̙3}_�\0|F>���}V\0rm\`\`��'yW��8�@e\r��\b����\vG�\\\0�&n�ܒ���3�;CCC�?�(ɹ�[�J!�9G�L���m}���}5U���e��6��Z\0P$\\�ȹ��l6{{{c?23f\\r���ݴ���ST�����>��^�)@\0�
FGG}߹p%X��\f��z��ay�'�J�񞿨n����ب[��X?\0ʭ�l�NP �)$��?&_��/h��r�s���w\b�b\0���S��k����!��:Z�As�<��gbs���ӀK=��\v�)��\0PV.͸��v��v�Y>IQTJ>n�1�b�r͘qɶ�;�',*eo���B\0(���a����>�����*X�ѳ6������a�r����޳���|�ף�*������\0������*���Oz�է�ʖ=�ʇ������W���W{OUT�j�u�)z,@)Yz|}����o�)��%èO�|x}�?\0?,+\x07ьK��ҘK�\0(�f�i�z��z�ç���|\f-Rߧ���OČ�x�ST�_<�������\0���[��x���(J��\v�,W�k���=OQ9���6F�gfΜ��\r\0Ș�V�ks��{{�����H�4˕둟<�=OQ�,B.\0T��V�����\f��}
< �R�\\\0�!���_�\\�Dȥ\b�\0\0\vB.E�\b����Kr\0�\\��r!�"�\0,\b���"�&B.E�\0Xr)*�E�L�\\��\v\0� �RT���\v�\b�!\0\`Aȥ��!0r)B.\0���KQ�/B.\`"�R�\\\0�!���_�\\�Dȥ\b�\0\0\vB.E�\b���k!w��o�-?�\\&ۼz�5j����=�U�\b�\0PU\v��6�L�e���"���y��斿�տ��z+u��j���7�|���mr!�"�\0,\b���2���%;/��KE\f��9�\\�"\b�!\0\`Aȕ\\֡-w9�ɯS���\x07Z�#@�*��Kr\0�\\��/f��
rKs\b�@Er)B.\0���+��_nL���_��l�Bn9�\0!��B�\\��c?B��W^���*U�\\\0��*��Y�����|��4�5'\\қ��-� �Q�Kr\0�V�+a��w���	�$^騕��[�#@�*��Kr\0U�����\x1Bտg��f�m>�ċz����\x1B
�%;�\\�"\b�!\0\`Q�k�����2]�Bn��\0!�\bB.E�\0XT<�1��&[.֜pI��b��2B.P���&��=�	��\x1Bn�Y<x�H��X�a���׿�-s�r9H<#�zQῈz�e\vz�iy���]��]M<+5!\0����gLJ�\\�9�U���nē-�\x1B1c[�d�\\�G��K��R�k_B�/���l��h �����d�z��n�����#=b�n8�J~� ���r��\b�#/�Џ$X.VGK�
�{�3g$��
��\\~\\��\b8��p���ͯ� �*�O!�\x07�	��K���]�t_~�U�\r
I��yY�\vy��!W6�;�\b�\0�X�\\)��M���&\\r��+u�s!��\\��� �r�4*r�@zÍ7\x07v@�k��S���W\x07�˞ZWe��W�s,���k��p%e��N����\r�!W6n&\\����?�=C���!�lk�X=5���b#��l0�L�z��+�1��\x1Bn��.B.!H�
!W�����簹�=�ѬQm��-o����}��\x07G�����4C����C~<�#��!�@�r�$��o��c���ޔ�S�O?�܇�8��X��]��1G��K�ҨB��	76�|[>��#z�r�w��f,\r?�<2.�J���zA�#�[�c�Kr\0-rU�VQ����	�$�:F<Ig-��%����g?Nr�y\b��\\ �*�\\e���.�ԁTl�'���i����^��_x��#��t��}M�\0D!䆳���4���X�Og�Y���ώ?�2�v�\br	�@J	��3,��e+���֬M�W����Y��w2*����e�ɖF"�\0>%�J^.Ɍ����/A��\r��%~R�ܮB.!H�"!�},�����f�vǷ�\f�?���5#sl�u�΄\\\0@!�e���|I�����%♃X��1���!�\vG��K�ҫB�u�|���ᐫ�7N����Jȕ��=5��ͱ!7�f\\B.\0T
!W�9��>�}�&{ȕ�2\x07�����ѐۅ#@�%��U!䶻�%���	�Gu+��X�n.xd?2m|B.\0 ���2%�\\��e�\fgU�ur�*�LO�Cn׎\0!��\v�Q���n ��\\����\x1B��OӺX-7��!�\0�r�����U/��2	f\x1Br��v:�v�\br	�@�\\��k�dNɱg�<Mwf�3*\x07؏L'�r�R\b�f�,;��
�҄\\	��3����۝#@�%�ir�C���RTC�<.{k��\x1B&��l�%�\0:��\x1B���b-.�\x1Br%�I�ӭ�-�F���N���B.!H���r͗�R8��N��E�qݞ���>�2!\0�!7<-I�l��8�J�������>w!�v�\br	�@��d-���d)�T��V^��e�/!\0�5�\\K\vg%��G^X� ��ʆ@ӭ<_�^���%�v�\br	�@J�\\��k_](Y<v�\\���=�2'!\0�5��pY��u�|ؾ���w=�-����z	��;iB���0!���*#亇\\�?e���܃3!\0�5��pE-\x1B;�Rl�3���4�z��;iB���	��\\T!����������%�A+m�$!\0�5�\\{L3�+�P��Mǈ;qqNBn�@����/r	�����6C�\r7ެ��׿�v�VvC��U���+�2�2\0�k\b��O����j�PQ�l�t����\f��8�]���*�8r	��2Bn[!�lBmwX��[I��c�֦�a��\\\0@Gr[Vx�X�1j�%{�3g-nk��a�]\v��8���[��/7&;�\\B.����V�=x����ۓ���_yU=(�����A��\v\0�4BnT���J��WDE<3$���;�͐ۉ#�K��zB�J��ǁ�K�E�r�
��/�*����E�d��fwe�M5vm��G�\0t!7�̆W�b���tW��j]���!pc�r�}�=]z���	��f\\B.!G�m7�\v	��uZ���f���mlc�^Q���\0��!�ZJ���I�>�=�+���ݎ^Qױ���[��>~��.3���V�٦L�%���vC�ic
)�����i���̿�_-9W~��|���M�-w��\v\0�
!�Rf��{zr\\BH�fI��o�� v�U�p�����\b���m��%;��L�%�ʼ�ܔt��r�gz���o�*��=�d���ۅ���S��d���V핹eyB\`I#B.\0 +�\\K�m��l����gՍ�7=w����Hx�%��@�вCr\`Ԫ)?G�|��f噁C!��<j 0!7��)����,䞾x�X-�*s��XzҪ@��2!\0�B����QKds�x��S�����&\`��6�G����\b�
7Gѭބ�0ߧ�Bn␫�Q�"������m�-�/Z�a����ǎ藯r\0�@ȵ��Ic'\\r�x��(�I\\5�鑈�7�X�c��=�Bn'������Za�Nr�|�B\0�rK\\�Ŋd۶2�D�@��&\`y����"�\0�Z��OI����1P�v-]���*PI���·o?y$����\`�cs��\v�\b�!\0\`Aȥ��!0r)B.\0���KQ�/B.\`"�R�\\\0�!���_�\\�Dȥ\b�\0\0\vB.E�\b����Kr\0�\\��r!�"�\0,\b���"�&B.E�\0Xr)*�E�L�\\��\v\0� �RT���\v�\b�!\0\`Aȥ��!0r)B.\0���KQ�/B.\`"�R�\\\0�!���_�\\�Dȥ\b�\0\0\v˭��~oOQ���C��x@ȥ\b�\0\0��I������~{OQ/�r!�"�\0�,��7����;|��x�ǐ�\v�,!����zSTk�\\\0�9�ӘKQ�,{3.�f��f�����e�=OQ9�g�!�=S��}��\0�\x1B��E��_]��.��U����|\0-O���>\0~�j������q�[]{�\\N�\0P)�a�bƌK~����o�)�R%:���?����}�\0�����\\�r���#����U�F���\0�=q�}���}����ђ��|�,kir����x3<<l�tИK�u�쫣�*�Z��{\0�)���\0�f\\T�eX��|��?�=[Qy(�h\\100���\f\0�z�����+fJ,=�{�f�����6�ϥ�U������}� �|T�ͦ���e!!Er.��U�W^�>��@�m�e�J\0y R:*�}	�����[�:t��=�?{:��\0tC������}�5I�t����I��f��}�+���=yQ]�m�w>�Gc���a�\x07\0TL�ٌ�n@��K\b�/�n��#i����D����~�峾��f����t
\0488H�e '��(I�g �\\V�4��\0@�5�M�.�����8\0�a�D�\x1B���\0�7::Z�׳���2^�,��ɇN>z�?�@1�sሄ\v\0�F�1o����H���@n�o�Z��\0���CH
(�.'\r@n\r\r\r1�a3g�d�5\0@�H�UW��/@{��3}}}�w@$�24�B����I\0@�����{_�6ȝ��kbfN �TԥU�������\0��l�/@��A�\f귮�<��\0�ͦ���2-UE�j��3g�隯"\0]��4j$���L�ʁ�����/~��Lu���ޝ����\0TTx�A�FGGo]�ȡ�L�����G\0\0��9�Q\x1B��_@<�Q\f�uT ��2\0�n2�4�P -���aP9����������\0��C���Q߻ش�~�A�\0�F�_����~\0PN�!��BQXV!� ����2��t\0\0��F�
An-o]�ȉ��S��3g��;\0\0�&jH#I�'7���.���_&\0�MQC1����~��A�\0r �d�\0\0d�2�Qc�r�^�ǾuT�;�/��ͦ��\0�$�C5F\f!o������.j�)�L\0��CI
�-��gzT�+�����>�{
\0@�\fi�X��"7��o]������F��{g\0(<�!�fR\`�rBn�ߺ=��I[_&3�\0\0)�i$) o�V���.��x�֗ɂ/�\0H�}H�ƈ!�A��gzT��vOVCCC�w\0�s�hb�����o]��_&�����k\0\0���!�#����ba\f*\x07�e�SN����}�8\0\0���F�rBn���u{T���2\0�nJ6�Qc�<J��L��tQ��s\b\0\0ЮdC5F\f��f�~C~�\v_p�2�@��2ypp��+\0\0�\`C���{�Q��z����x�C�Bn�·���n�Q\f�g�@�5���o��/�\0H��(����ͦe���>Y�\`��LR���33g�T=�,S�|:ݞbvdP9�.\b�_\`�2��[n	�m��"\0\0(\f}%���ף~bC�244���H
�2��ӷ�f_{�U���i\f*\x07�Q�/�?u�Κ�)u���:\0\0(5����/���1�-���F\f���O�.�\\B�2<<,[� ���_&�?��2YNS��
�O\0�btt��**�!Wi4u}�T��uܲ��{�Uۑ�4��\0:$�/���|�\f\0@�\\ ?�
�\0�QY}�<99ɗ�\0\0�A�Eqr��Y\0\0���/���\v ���\0�e\\|Q\\�\\\0��u\0�.���"��?��\0\0t_!@�q�\0�˸���\b�\0��,\0\0]���E��\\g\0�2.�(.B.���:\v\0@�q�Eqr��Y\0\0���/���\v ���\0�e\\|Q\\�\\\0��u\0�.���"��?��\0\0t_!@�q�\0�˸���\b�\0��,\0\0]���E��\\g\0�2.�(.B.���:\v\0@�q�Eqr��Y\0\0���/���\v ���\0�e\\|Q\\�\\\0��u\0*��l�9xxx�]s�5����?�O����~�{����!��LNN����!@�r���F]�����z\0����w\`\`@n�|�s��\v �\b�\0PV�fS��}��\f$�uB.��#�@)\r�j5��\0(����f�����!@�r�|h�:�����h����D���\\\0(.�Q�Z��9��\v �\b�\0P&$\\�\v$�Vv�eB.��#�@i\f\r\r���\x07������'�B.��#�@9LNN2��MռS"��?B.\0��cG�/�o��UE����T��*8�2!@�r�&''co����k�}s�T����Z}p����1�s\b�\0�\v\0%P�����?��SE��n]���/�7����w\x1B!@�r�z{{I�ՉZ}pݗ�r���%�R�O\0]E���\\\0(:{_���Z�1��
]/.[h��U�~��\v �\b�\0Pt����;�[�{�\bU��LE%���9��\b�\0�\v\0E'��3��.��{:���ϟ�Eԧ�j\v�r�!\0��ro��f�逢JP�˾�]E���\\\0(:KȽ�C��E��\b�!@�r��\b���"�j�\\\0�G���#�RT����r�!\0���KQ�.B�F���\\\0(:B.Eu�\b�!@�r��\b���"�j�\\\0�G���#�RT����r�!\0���KQ�.B�F���\\\0(:B.Eu�\b�!�bttT.�3��j�������600044499�����\b���"�j�\\��������}'T]oo���f����B\b���"�j�\\�;$�J��n����u�.��(G�]���O����¯��\x1B��~���$U�"�j�\\��&''-4��Z�6::��S���r,y�����*iwՁ���Y��Ϭo|���Ǟy"�v�����od��w=|�����_z?n�+B�F�:J�Cn�4��B��ko�'8�&\v����Ƙ�Ŭ�-r%�f�������/�[&�r� ��3<<ܕ�d�����\v�s
r%|�@��������Ly�<�����o�p{.��9��\r��L3���	���4\b�@��pQ8�\\\0�SАk&\\�wl�ܥ��@������y39�^ɾكp��+2��
N�%�A�:����"��"�\\	}z'%�%K�=��-�m�)Cn��jI���r	�ir��5����Θq���\fPT�j֬�m+�\f\f��\f(�\\s�h��e�Aَ�y�t3�=�&\v�f\x1Bw�WgN9�7K�%�A�2����%�ͻiْ��M-���+(�ӵk��3��/��+.oN�[���_��k��ɚb�~˱���C�}���\\��;�����;n���	���4\b�@�,q3ޒm)_���F���^:-�V�B�n^L<���\vw�7�����ғ�\\��N�i^��e��N!���!Ȑ�{G�3.ٰ��cU�:7��^��=�������R)\\��i+M�3���/��4񂹁TK�%�f��\vd�ތ+	w׶���T͛w���Z��|�\0�J�B��~mM9(s�i����\r�FO�d\v暍��r	�� ������[H�T��ޞ;<<��#�<�\x1BrӴ�.X�d7U��3�'\x07�Z��ݘ܅���S��J��Ir[1�r�\f�&��!�J�Ѱ�X{�~�unj��D�i���}�\0�G�B�N[]�\x1B�eR\v�����c���-v\v*2�<�'��:reg�#	���Z�C�V�5\x1B�-ZF]������������Cr�\b�@V��zԧ�˾�=�PT�Z��O� �\\3@u�Apic�\f\\�R���;a�;nw����Sm�\\	�f�ty�-��n��<����ل\\�\\ +�O��\b�Y����Ҙ;>>����$
r%v�;�SX�%�ʌZ*:~�<H��gsr�\x07�j��i�̳.!W©�p�Ȅ{�K���<bfЖm�����n�'�v!Ȋ�AT���\x07o�z�2�2��.䚁KI6�������,9K����f�p mYi��NLw��{�V�ߖ/�%��K\v4���������j��vIĄ\\�\b�@&&''�>J�f���CQ�Z���wo�^���PE\f���sP�9�\\�KB\f4��{�v'�N-�m��7e�ؐk���1s稯)\\���&^2����\\ ���Q�\x07��{��(K;�(��+�\bߟ-\0%QĐ;7�S�]��kfF���f{�}y���\\3x:��O9�ru�v��:�G��[�<�%�r�LXB.�*S�/B.�N+hȝ�n�s��7A��\r��N�l6�ZBe�B����C_e����̱!�}oÇ˲Α�+r·�r�\b�@&\b�T���\v�ӊ\x1Brͤ�8\x07�<3�;����m4��Z2W7C�$c�nZ\r�N{�5G�Xd�KU��s>��r�\b�@&\b�T���\v��Jr�4$�\x1B �������I��%Tv3�I����Uņ\\u��j47ӫ��-�$��l�s(.!7��\vd��K�\b�\0:�L!���\x1B5ar��eU�\f��f�5�}�pԔS.!7Y�������R�u�r;��\x1BF�2Aȥ
]�\\\0�V֐\x1BȀ-G�Jn
����)j	�!����fV��[f��Cn�/�|�\x1B�)�Cq	�a�\\ �\\��E��iU\b�f�\v��������>�4*-F�����\`�![�U��+GUwf��~\\�c�5����\b�!�!�*trtZ�B��@\x1B���̬�x��΃Qw9�N8,�k�r*A�]�����d;���ؚ=�eW�Z���5�\\ �\\��E��i\f��	���Q�8@�0��G
�M�Q�ώ!�2Z�����Nr{r?�!7��\vd��K�\b�\0:��!�LmfV*kK�u�\\�ǣ^ul�]�\v4�ʏȞ[�\vn7䆻+�|� Bn!�D�C��ןz����{����K�$�Ky�C��\v��
r���'�m\fK9&7��k\x1B�L����9�Y^�K�l+��?��������\vd"�!�yv�#����f�5�%\v{O[!@)4�F�G�2C��"S��ή>z�sb��r	��tR����!Wv^��V��-W��mr5B.���ܧ��a�x\x1B��G��=sQ�\\\0%S��k����wQ���['7T�[=�S���=���ޜ2��U��@�q�\x07�r5B.��\\�\\I������h�-y���ȃ�Wx2M��J�-�܇��\v��
r�05	p�4jCs���=]~�W�m�\`�>�Q#�cC����s�]�|Z�T�9�i���r�L�'��h�d�7�F������@.~��Ǽ'�
!@Y+䚝T��Ue�bd����~��4Ŗ�\`_!7�\`�Ö\x07���k����\x1B�s�C��?b���%�j�\\ 9	�G�f&ܛ�w]��R�\f�=��K���b�\\3�,����:|�{�ڃ�%��
��sut�M���k�Q����Q!��\x1B�Vk~�~�6!��\b�@&�r%Ϛ����\x1B1G��y��\\ߟ-\0%Q��;qq�_�Pc����_�#s��Z��nȍ}��!7�I�r�C���UQ��r͡�Q_�l�'�v!�DB���,�2WJ���\v\0Z�B��n�,�	7��֌W.��%虩�>ðc$��\`Y٧ݐkn�l$�m���\\sB0��k�������P\\�_9��s	�!Ȅ������W���l�yv�y�1��\v\0�.��O�tW[��;y��z�\x1B�M���-�M6b>96w;R�Ur�
�f�j�>�Tlȝ�x	!y��X��c%�k�����W.�ms>8���r�Lx�s���㚕�I�5��r��Vŋ�\v���r�9W'A��J���@���<h�U�d1y�l�u\f��;�jJr͆ז3A�5�c��rd�U���\r�����'��\x07\\��ڿ���\\B�F�2�7�͸�t06\x1Bs���+�G��!@Y4�N��O�"i�%�I�\r���9������s��4!7�\x07�ﲇ܉P7r;݀n6��2�ex���\\B�F�2�7䚣q�7��#s����#j)��˟s�ly0e�g��o\`˲��\`[�G����Em3�޶|�=�rTPqC��@�\`,	P�.\f��\x1B&оO���~��ZʐkRǣ\x1Br'��kc�r��%�4���4��|�A��2B.�	�!�ӭ��A�e�\v�����R�O~$��oX��׎{�u�.E�
���.?.\b�\0
��!Wg%�W�eӧ�=+��z@�N��Zv��rI�w��\x1B���\vz�sBnr�Lx\f�f_e	\\�l����ʼ�!�%�\f�/<���fe\\�t��[{��ysͦXs��M�PY�\b���"�j�\\ C��.������p%��A��	Cy$�+-\r�fȕע��]'��|��Ws�#��L�֜��rH%/�	W^c���l��7��	�\0*��KQ�.B�F�2�1�))�\0�%)�̌�1-�]����\\\x1B%\x1B���Z�S�?�����v�V?S~�e�e3\v\x07x�W�1��:̘\\\0eEȥ�N!W#���ru�J�<n����\r�-��ꈧn���@�oV{k��7����ek�*���]�	�\0ʊ�KQ�.B�F�2�1��X�r�g��̀���͜�������NT�J��FM�lo��Ёf_�z�>ӗ�r�!��:]�\\��\vd�c�M�җ�+��#m� w�5C�����6[���Ͷ��f$D�QT�}I&B.��"�RT����r�L�!䶻�NⲤ�ؒ��;-�S�r��5;��s�]�[fy���K�\x1Bt���lM&�� B.Eu�\b�!�D�B�9cp�����Uu�kk�_s�k8�Z~]lI���)eN-%\x1BQJ�'q����\v��\b���"�j�\\ y\b�]뮬�7��FKë�x�vK�M��Y�9�\v��\b���"�j�\\ ��xJ��dA���~�kl�M���T\`�\\B.�
"�RT����r�LTg	!�o����@����z:��\\{O�ݙ�\\�\v��,!��[o��(�E��\b�@&<�\\3I%!�n��N9.�c	�nə�\\�kt⽵��
�[�[��e6�rT�%�~�+�yO\x07U����Q����>�瀮"���r��7����Tl�����}ڥ<���{k9�z��\0y\\��'3�2���\\(ŋ�z\bU����sAW\b�@&<�\\�i5��7M��М[���?N�I4��+�}��&���f�i	���ǫ�\x07�*t=��s������s@Wr�Lx\f�R�=���w�e6��1�ͳK��|�%��'�@__��&|���z�	U�Z���3.�|����@Wr�L�\r��xϬ��Ρ���Q5gW6\x07A�mB.\0\f\r\r�X1�2E%�؄�������m�\\ ~C�م��fl�\v��fr��N�f����m�$!\0�=���]~�ϟ����\x07\x07��I���֛c?VU��)!Ȉߐ�Gc�kO����J��8�|Ζ�D�տN�i�{�V�7�[[cve\0�z=��\\��o��UEE���V��j�f��G��\b�@&��\\�y4傹f���l�]�f1	��%4ܴډ��fo�c�ͭ��)s/!@e�Ͷ�r;�\\\0�\r\r\r���{@�2�=������ĝ��*E5
���<j_�!7�޶��Y�Y?�)��r!@�������\x07������'�B.��<��@>M�s�nϖA�fjs�j��ln�P�M���ל��|	��J�:z��r�.!7�ՠ\b�\0�fpp��-?P!}}}쨬r�L�!��:��Fy��p%m��\\(�%�J<4����m�M��f����lN\r{��h����]Y�gˎ�\\\0�100����*'�O	�@Frr�YR���^x���O�k�Ԓ�'G5Sv.��<.��|�%�J��j}T���I)�Ww��rԻ��\v�sbW�L�\\ #�	�f�IS84Iڒ\x07�i%i�&ܖ�Z��@��G;c�Gݹ�벷�s�p�tG�p���k>G}� �jxh����	-�~\`����\v�|����ۛ�m=�i\\0(��\vd"W!W��'ƶz8�\`h��X���ѐ��޶L����b���f��r��/(,O&�(�'g�e ������I��\\ ���a���t�[syV;����u	�s���@��뾷�; �(6/K\\5_r\`�sOtn��xf!@ٍ���-:ih�\\������&B.��|�\\��en��Ɯ8���Ryб�s7����u�-m\ru\`����ݶ_>x��\\\0��l6Ǒ3�-��Ϟ�\bj4�?�9E�21��KQ�\\\0@bCCC������pE�2Aȥ
]�\\\0���L�v|�\b���\vd��K�\b�\0�(�&g\`\`���\0N\b�@&\b�T���\v\0�"�V_��\b�@�2Aȥ
]�\\\0@K�j��k��\b�@&\b�T���\v\0hIR�y]�����G@<B.�	B.U�"�\0ZRSN�FGG}���\vd��K�\b�\0�0ɳ�KC���br�Lr�B!\0&y��Ձ駐s�\\ �\\��E�\0��2��u�{\x07�r�Lr�B!\0 I6��P��|�\`C�2Aȥ
]�\\\0@�$ٞh��þw�D�2Aȥ
]�\\\0�I2l�\b�!�!�*tq\x000Y2���S�-B.��F��Q������,�a�o�޽�\0d�r�400�{O��\b�@V�>J3f\\�=�P���������\0t��W��[�՚ͦ�Z �Y����4-[�� CQQ5k��F�uGGG}�\0\0]%��>唉駐O�\\ +��=�L�,}�{o\0�;唩�����-r���/
%���
���D~9�����S\0�6ɭ�!W4\r߻\fr��4�M�%�˾rnj��DCQfYF�z���S\0�*�D�Q�~
9D�2d���^���PCQ�vm\x1B�߷�W\0��q�)�O!�\b�@�b����K{.��Z���3.�y\0��֔S���!��\\��\vd+�+�Y�����:7���\x07o��c�\0�F�j�����B.�-�.߂ΛwQ��~�}fx�e�}%���h\\\0� �b�����}�>�9B.�9�/B%n���}��)������[fQ!��*\0�I��n�\\�3�\\���\0�A�Vc1\b\0���e-��	�/H��\\��<��2s@������\0\0�-�\fboo���mwppprr���?����	!�r.
Gni|n\0\0H>U�Z�&�Vm����~P��G�2��\vt�\\#跌B���\f��RA���ߜZ�%�*CCCj�M�!'\b�@��3?�Or!\`� \0�,I�}}}�:�C��ؗ����\0�!�] 	��Y|��jtQ��������k��e�\\�k�bA�e�Doo���3a\0�$\b�@Nr�.�X1<<���Oft____�^g� \0@,B.���\vx$�w���[:��\vtb��-���pC�\0�e����"�(����N,R0555w��N찄�O>��Ӈ\0�lrQ\\�\\\0ŢV�z�����+��rbb"�͞8qb��;v����\0 �\\!@�4\ru��v�s�Ε�;��l7;66&!wѢE];D\0\0d����"�(sz�\f�)����򂩩��6��G-��ĉ^�\0\0�rQ\\�\\\0E�l6�)�3��Ο?_��g�}6��nٲE��U�Vy9h\0\0$C�Eqr���y��j�����+\rs���j�GFF>��#_�\0�vrQ\\�\\\0E���2�������>{��V�\\�~��^p1��\0\b!�E�P\b-/�����<gΜ@Ƚ���oVM9eb�)\0@�rQ\\�\\\0�\`N9eJ9��ʕ+�l%��S�fsA+��} \0pB�Eqr�dƨ3U�^O���e�}��'�lv���-C��ؘ�c	\0�B.���\v ������T�Z-�fSN��:�|��~��'�)��~
\0P8�\\!@�����D\x1BN��'�|��h���
O9eڲe���	\0@<B.���\v �,YE�c	6{����S��n�-�/Y��rGFF|Q\0\0�rQ\\�\\\x009����'��SQSN��9��fϜ9� �O\0򏐋�"��3I��	W\f\f\f����n�-6�&�~*j�)Ӓ%K|W\0�*�K��Ã(��u\rT*�{����0�B��grNv	��Z��l�o�ȑ#�	7��S�|�Il�U��[\0((	�.�q\0tMooo�^/}�%��3��S�����O9eZ�x��f����rׯ_���@\x07\r�j5߷�\0"\r\f\f�8�r����������q��SN��Ν�Ë-r\f�###�|��\f\0�k4rB�}� ^�V\x1B�}��\bB.�ܲ��Z�;+��.^��1�*�w�v٬˔SL?�܆��i��e\`\`�|��\b�\0��qʩ�Y�e�s��m+�:N?�jժ�B�E�|c\0Ȓ$\\�w�\0����+Y�%�ȧz���)�e��ݻw��p���>�裶�r��߇\0���\0\0y�\`��<#�ȧd�b���O9e�ovǎ	B.�O(���Iz)EW��\\\x009���[oo�e��ϟO�p]��r�r*��\0�@�S(\0ȡZ�V���	�\0r(�����x�fGFF��\\111��'N$K�b߾}�6\0�"g]�������ُ>0���.׼�~0�k�\\>���L��7	��r<?�;�i���Q�mw�)�O(�د%/��W�z�Ǜ&)��X��n��\x1B{U��\\B.����8}�_�:S�\\����S��ꫯ?855�l�)�FFF�s�'|r\0H(�kI���Z����=EQ�^|��3.�|f�����J\b�\0rE�9{��{pp��N�k��\b������ϟfk�i����[�r�9s�\x07[N?�e˖@�=|����XT�=s�L\`\0�U�|u\0Hhhh�v������S(ɹ���}z�� ��s�)�:�=����r��yjjJgU���/V�[B��U��x�\x07�;l6��رCM$e	����~��G�<\0$a���1��p)*�e�\\�˄\\\0���˩ɜ?�%�~:�
,�W5������Y��'�4���\\E��_��ʕ+��>|X�TI�fP�\r�B�����u:�}� 	��A�~��;y��Z֡�\x1B-!�2�gQr�G�ѐ�������!W����f>8g�	�G�	<�%�*�w�;wn�q	��-:s�L��.!W�\`�6���@���m���~'OQTTY�[n9�X\b�\0�C�i�9��
���e�oɶ�X�=�*###�!��O>�Z\0�=�*�n�� �,!��=<EQ���X&�@$\b���\r���\r�\0PP�\\�*h=��|B.\0xD��|"�RTA��\v\0~r �\b�U�"��_�\\\0�'B.E�\b�\0�!\0�KQ-B.�࿀
[�|��<�f�Q!��{�M�ٷ�~��\b��%����A���KQ-B.���\x1B�B.��}�U�\\�*hr���L���;�3͖�>���4���\\��@\x07U0�r)��E�EGY�����U%�1�Lu�w��rTȽ�{�lv�ҥ�E�},d)p��
���5:��KQ-B.:�e�\r��O.�1P=˖-�:S�~��i��w���4�}뭷~�������9�|�i��}GGr)��E�E����̶f����T�dƨ3ռy��l�[��4�]�x�|K\0�Wj3���nY�.!��
Z�\\d+ou���V]7?�����
��u������l�����4�}�7~����1u�V�l{u�-}�%�RTA���\fY�ʶ*ժ��~���\v�0ɌQg�[o�5͖��;�H��E�\rG�},dL]�?�ff^�vQ�d9��K����6�w�]���}grU߼�rX����_M�EV�	׌�*۪\`����ΝkN{������k�E���������#̛7/�f_y�_D�},dF_���Z��:����2�M��oL2�+�����~ݖWWd������e/$}���9j�����9�9�gW���3��w����D�E&t��*۪\`���{Ӧ���^p����Ѩ3�����4[��\x07?�A�͎���{��@f��Y��꒭��\\�U�\rD�R����\\I��lYRإ�~��ۉ?����a�a�u˝rp�]��o\0\b�H�e�U���x���J��z���S�N�*��_�:S�x�i�|y�[n�%�f_|�şG�},d��(�˴\\�u��iW���\x1Bn�-A��Oȕ�С-rS���F�+�����ܬ��q,B.R
'\\݀+>oU���*̞�v|�1��^xᅨ3�\r7ܐf�\x1B��oN��\v�4��c	 K��.�*���+�tu?��5\\W��%˹�	�b��/e�\r	�����Ԍ�m�5�X\x07��еWA�E-�ـ��j�U�V�Zu�<z��\v&��z����T�z=͖�&�M7ݔf��=��c|K\0Y��h�^�ثӮ����~X�����{�u7�ܬ����m�~_�.��\f��n����\\�\\$fO��W��ʥP���\`�������A�b$3F������4[�p�7����>�o|K\0\b\\���Z�^����]���O�V��ι%������UR&)s�)�YBn�?S�;�v�2��6�֘K�E2�	W\r��˟j�ݵk׆\r\x1B��Ǘ\\����~8�L����i���FH�ٗ_~��\b��%�,����Z���h��Ү�����n�U]�͜[���<�\\	��lVO9u�-w�H�M���ۅ�D��o���\b�H�\f�z�)3�={V����W�X�p�\0D�뮻��TW\\qE�-�����o�~�\0�D��xiW��c�t�n)snB�����n�ͯ������6�Y�!7emyuE�?J>�!��ʝj�YM�[�\\$h�U	W�hf�ݻw�[o����\f\0!@Q,^�X��\x07$�V]ݤ�s�귬�[V�su�e��/m�I�5�i�s�����t�o��;g^�\b�R����L�E�E:���\\ʒpO�<�|�r��a�0\b�\0�E��]�T��ιr�����~@�+d�-bcnNB��FO�d�?�)�Tr!�,�I��Cn�C!W���O��R�\\�+܌��⪹��b7::���\v	!@�,\\�pbb������{�5��>��e�e�w1��O����z{�{��U	B�l�܎���!�S:**�W���d!w��/�߫*�D^z��v�*�<���R�Zd#��T�[��v��P��=�{RO�F�%�vB�WuT�+�Ν;}_u��!�(�\r\x1B6�9�ĉ�N�:{���~��@��6��'���=��ձE7��r�i�-\\2��\x1B���~�sP��k�Ky�iB�~	�\r�-�\b���va��%h�Cz�-wڷ,�������zN�L}&��{�
,���\v$C�P\\�su��cǎ�����\\Bn��k�v{{��j+�J��مl־�@ӭ=�Yrh�!7�|RʖD}L\\��ʫ0ׁ�eE��+��~H�"y�B��+t��2!m�j�ݿ���,PT�\\\0��r��oYuZ4���r����\\���2���j�Y��+��L����]|%A\x07Zf%1Em͌c����7ʿ�^i[!��ě>^��c\x1B^ù^vXՠJ	��c\b�f���ز95�e�]\v����.̱L�E[T�5'U�裏N�>�8\\ 1B.��۾}{�1��[�˹
��t\\r�k�4�%�����5Y+Q+�5����9*�9�\\y��%��+qR\v�z{l٬���e�\\����3]B���ލ�^\\�����}����K�,q�n��8x��w���GE�zgź�3�c��,͖o�嶖��?��US������[��p�Ŀ�����Ӎ�jd��f��=�sr?6Z�ښ-�e��\r�zn%ǰc�o�c��n\\���s[�!��\x1Bh��*��}��u�=׫
4��l&���o�.�桰7@w.�\x1B���\\B.ܙ�*��;v�_�$ޒm)*�\b�E��
�uW�Ze6�9s�w��ݹs�
�c9o!�\f�-[K-�"�M76��\f�>���G�q�.}�c��cCn 0f�̘��Gt�#m�@n9��\f�m���-w'���ӝ^���\vw�����!/{G�7�|s��	�h��sr)��;rJ��+�\vUc�ѣG��z�eBn��k{�
��@ʋ\r�	��n5��5_Q�i�eB��\\���d�����ݤe\x07�Cm6����0Cn�k�[����ܮ�=Eȅ���\\���r5<q|��u��r^�\\��
QrM���U�V����2�X\f��}G�*�!�\f���I7��S�=䚽���@-I6��Y���lJ���\f�
jYQ��f�v��يN��v����Z:�w4�꿎�5��kG��Vx��_�r�;v��+2E�\b�E��9w��
�%�fr͡�������!W~D�{H4�e���eE�\\s0�<'�RA�2���Ǹ�\x1B	�A�x��\f3�&زn��B�h����v��	�&Bn�r��eI��w��~-��B!���վ����pl62瞒����=�Ðk�{[XԔS.!7Y���X�S&�e�5w�C\r�fZ���ċ��\f�N��3�Q��!��M�M����@_�\x1B7�aŊw��|HQ�K�X�6�L��?K�娐������WMQT��͜��;+�B��ؘ�{�\\-���m�5����U�,��EY���j��t�3ݒ�2-�cȕ�����K�ԉEj��i�~�8����g3�G\r��h�5 !71Bn�b�U����o�r��=8u�#��\\*.�&߲5���EeZ�K�\x07�
������j�eBn�!�e�\\3˴̒iB��;ݙY�u9>���Úl��ُ͐\x1BX�W�Dc�K�5�4'��Y����Yǹ�]�sԾr󏐛����J�j^e�\`�������P�R+��D�ܟ��������������WMQTVʶ-bo�9�227��P����g���a�\\˔S	B��;-��&�1\x1Bs-9*�����r%#�K�3���Kk��\v\f�Y���ekr\v���.�ju�5�j�=��\\�DX�j��S���(�Z�|Uԙ�'?y<͖o��֖���Ox�Ee^�����U�ݸaST�ݾ};!��!׾\`���\x1B5��cȕ�cFH�<��sû���!�a�_-�������C!?e�s��\x07�d4�.��\f����!�ET���i�L�\v���\x07�B�����KՇ~x����Fh4��z�IQ�c������4[��\\ﯚ������sg�B��H��E�ݻ�r=�܏�\v�?�bCn������lK	�������8Gu�\r�\\y�+5����\f�Xv	���:��	��r�,���Ɋʶ�ϟ���\x07|p�ܹ��������u��ޣ(ʱ�-[u��?��4[��M�oY�>�Sﯚ��l���;y�})3��J��D]B���kY0�e���%��ɐ|��.91}~QK�u˜k�ܖK����\r_�\r���MP�����!7J�xkf��OS��L;7M��{�'��ݻw?abb���3E9֒%cQg���'i�|�7�����qﯚ����ؑ�:z��g5%�b��y��.!�.�!7j���)�\\B��-M���\\]��t��p���a��@NO6-�����ɦ��>������!����VuH6[l�$���l�n����ٳgO�>}���'Nlݺ�6��8t�EQ���\x1BK��T?��#i�<�~S˚�ȿy�EeT�>8]�NN>u���#�O��2�J��G]B���\x1B�w��O-��cȍ����!7�»��k��BV+
����:��ZB�����?��BƄ\\߻�M ��V����H��j��T+W�S�N�\`+�=:99y���M�6=a���{�LR�X���8�L��C?L��믛۲~����_5EQ�kߞ#���;*up�q)	��*�N�ViW�gD�49������r�\\�O��Y-!�̆m�f��]9q��3S����T3�I��䯣���u�<	F[~�����>����ѐ�w �>�\\B�N��W\r�=��j��x���n���
��:x�������۷{��իW?a�����S�X##�E����4[��_�oY=�#ﯚ���j�R�vܽ���]���>,�w�ޣ\x07�;x���襁]uU��������\\BnBnx�\\s�%��G���x��{p�ۚ��ҵ�}�%s稹��*�Jk���Kn7*��pC�r�͉f3��Pt4�vt��j�\\�W�.�\x1Bpu���d��Ǐ�\`{��I�{��\`�s��;vl۶��h,_�|������l����(�r�^Xu������l����/-�����)�JY[6^�ͻ��6�lۺw��}�|?˼�}�ڻ������{z:�~ށ���v�%��!�~Z0W'��VKK�uY
־ρ�caj/ݠ�&��_QH�=c�_j�7.��9�X�V��>��-ǡ�9���\b��\b�Z �.ʪ�ܹsr\r���ȑ#�m��߿gϞ]�vI����֭[�lٲy�扉��\x1B7�[���7�|8o.]�n+EQ����^�:S�y��i�<矮iY��}��WMQTV�a�Զ��mڸ}b���;U�����݇��9rp�qժ{�h�M�s	�9	�f���S��ı�����
,M\x1B>>����2����t�]QHGE�7	��}d�y�[�@�u�mn�>V�\\ǆo�;{�O���\x1B@�U�^�*�ʵF�.�l6���N�:�����\x07Uod�b+�VR��M�T�]�v��իW�Z��;���+�]p��^}����l�(ʱ�y湨3ռ��L��ٳ�nYw�q��WMQT�Z�r��ի6�Z�zb͚���nY�n�$�M\x1B$����gǶ?E����:������N�9��~˄ܜ�\\3	ڧ#vO�fëK$�+�FuW�"�N�f�c����2G�&�\f*AR3�Br�Oٲ�]A�!�����S�F�_�>�W���P�!W�\r:�~!�
��\\t����gϞ<yR.F��x�k�.�65\r�b�~�z3خX�b���ccc˖-���]\f^l��W���P�XO���Qg�[o��f�W]5�e�>o����(*y-_�j��5R��kW���zg�z�U��+iw�mw:�n߿{ס?5�:��.�̹�\\�!�\f���}	���К��r������1�L|����̤-�v�!7A䴔��S�����\\5�'��|���\\�~��\b�zlu�(f��r{zrcr?�������\\}�t��у\x07�ٳgǎo%�>��s�����\x07n�\`��z��뮻��k�����\b7�|����(Ǫ�o�:S���M�-��׶�\x1B����US��6�G�|�i��^z��%���V����J�Uiw��*�nټk��}�vܻg2}�%��'�\r�Q�ݐk����3Fɯ�G�fL�'�y*�L��V $����r�h��\x1B��iV�a-60�_��p�$��ܞ�h�\rOy󘉵ǭq60�:�m�r����\\Bn�����#G8�{��+W>�裒^�a��iW\\q�_��_�_��﮼�ƛ)�r�o{ �L5s���}�(�*PI�}�W�/Y�|�����֬_��[6nئ�tw�8�g�a�s�s;-r�r?����q�k� Ysk,�Y�&�����g�X�{��\x1BxQiV��q�H�����/<�s���i\x07B��m�r�oc:= ��[nfGe=���{��Y�p׬Ys�}�}�\r!��2/B.EQ�֭��{�_.~š�kVO|֤;���{೜{��g9���;���cc.!7W!��n���e&�@7ז$\r�-�^3#�����B�%
%\v����Ӭn�u�k�^�a�b'n����-�߱��S�~�Oٓ.��wi�1ф�O	��q�P�?��ܹsSSS'O�<z��\\��ϟ�o	�ա"�RՉ����_���e+%�J�]��3�����G�V�-_�i9�1��ۅ����d�pb�5�n��0\x1B���iW����
�������V��p��\x07�6�J�r��Q����B�\`���֝�!�Xˡ�r�9u�\\}V�\\9gΜ�.!��:Q�\\��:W<���7��^�j|l�;+֫���B�ݷ��!ɹ��C�s?"�~Jȥ�Kϲ�8qV��	�oI��u�7r�*Ќ�:*���Ǐ�kP��KQ*B.EQ�[o�72�Hr��5+�ٰv��\r�%�~6��]���;zQ�e�1��Kȥ,��f�9���b�\\��k�M�-��h\\Ռ;55%��_~9Y�%�RT'��KQT�K����kW��(9wӆ�ͻwl����)�17vd.!�{j���;\v��~�,h�����R2'U4�.\\�0q�%�RT'��KQTJr�Eco��,�[�eb㎭�=�w~֘;٢1��KȥbJ͹Ե.�3�����<�.Bn)�qϟ?��q7n�800@ȥ�\\!������w߷�ͱ�c����\r�mټ����\v#sϜ<�c���=8Py(�\v�e�L��!WO���~݄�R2C��T��lʵ�\x1BnpI�?�����\x1B�Wnݲ�ྜྷg�ڻ��g������+v���u��o>IQ�c���u�z��G��EQy��+�����_��{�y�%�>����򺵟5�nۺ��GϾ{�w.=�	�ރ��R��qy�~]�B��f܏	�%�,W�����x���OH�\r[B.Eu�\b�EeR�^w��/�0:��g��k�l޸a[c��;LO����I�˄\\�ف�I鑹�i�-\\�U͸�^��n6�~L�-#s^e�WY.7W]u�%�^w�uo-^i���\\��Pr)�ʰ~����!��\x07~{٪��V��8��Ю����}X�X&�j�\\ʥ�٘[����q������	ϫ|�ܹg�yƞp7���p	�Չ"�R�m-zuܞs_zqt�ؚ@�����9�c��r��\x07*?����
�]��m!�|Zȵ7�:&\\B.Eu�\b�Ee^#/�e	�?��|	�j��M\x1B��9�:y��Y	��O��0,����Ԫ]�EQQU����ܒ1C����\x1BoX���vL��\\��Dr)��D��g�����__�b|��\\5,w׎�����{�����_/�~\x1BOQTT]��F}x���|�ZҪl�5\x07�;w�G�J���{�ޝg�kώӟ��S;�H��Ѳ6�;���NQ*B.EQ�����YB��.���zզ\r�깧|�\\-�2�rEBnooo��y�M?�~\x1BOQT�Z���7T���O-iU$����Լʪ��\\V�������#,~�?�V�ڽ���훏E�܍kl�8AQ�c-|9:�>�o�w���l��9���~r��!rׯ۪V�U,�!�2�TEBn��Vy�k+���S���0��ɕp��ԒV�Cn �*o�
���R�*�߿?*�^{�u���l�vm�Sm�|d�����á�\x1B�S�X\v_Zu�z���x�=��2�M'��B�]�b{TȽ㎻�/_�&X6B�	�U�*r���-�ʗ}���̥��ռ�~\`������>�d��!7l�����&���ir)�����]�z��|�;��h�ӵ�xc�䊱F�Z�r��G)�r��^x+�L��C�w����jß���*3�v(�ΛwgT�_��\f�{�Lr��f�լ�͢=��rRS�v�nO)�~Z���2��\`��?�Ae[���5E�,r}�<�G�o9�Vm�|Dզ�\x07ƖmiY�W�ڴ�0EQ�����T��?���Q�aM�������<��)�^H��ܟ\f�,*���۟/�Kȍ000�G��$޾�ĳ�ɦ�Z�V��ʟ�(��ζ:�~4Me�s���5��ٳ�O��K�O<�\bK��ٲ�p[5����\r\x07׭ڽ��\r-띱m�V�(ʱ~��EQg�{����ݣ(*�ڰ����kJmZwH'_xu��*�>��עB��\b��&''cC�ٰ;�fS��r���\`� �!�e�5��\x07| ��f�)ב��{O��\\SN�<y��q��:t�������+ׯ��V�[�G������e���y��E9֯�Jԙꮻ��{EeQ��VM���ݫW�Y�b�ڕ{U���y?O�F]{�]��Bn,�1v���O����h����!ל-Y������*۞;w����W�����lO�8!���G�J�=p���}�v��9���/«���j���j��6�U�ۖ/�����xѺ��l�(ʱ���KQg�;�x���Q�U���P5�lۊe�W���������\v�W5�f\x1Bu	������}� ���:�����;����{�����.�[_����J����z�V[�rm��[�ʭK�^7P*\`Ņ��=d��$!�����$@B6\bI �!D@m-�/y���̜3g�̙������|�d�̙���|��<�9�޲q[r۾�>������.������6r���Ɔ��]�v-]�t�\fII����JQ~�Xj󲫒�&=�,7s'� *�iC��'Ղ��\x1B�{\b�x!Y5����g�����.���̗������n펎�U�����\v��
�h�?��&\0����(�?E��u%�\x1B�x>����S�N?~�MHfn{�������۷����Ķ��~���uuu���;v�(++[�x�=2�ƤfgThJyzJI��\f�I��OM*EDe֮�=Eży5|��JҒ�X2R*2S+��vd�W���g��ԑ��5U��0�e���t5���s!�ޢ���\v��͡��J.��gS�����ہ�#N�<988������ܶ����JHlw��USSCb[YYY^^^RRRTTTPP���3���d�\bKHI*t+�[\vX��儇&:͖��<ATf�Mr�To̚o��!\b�a���$R���\v��\v�%�$����o� �\`�ٵ���v�T��������{n�\r�\v��"乘�\f����.Ê�+1\\6E�\r����9r��mKK�޽{�mw��Ib[VV�}�vۼ�<۬�������Ԥ��7�x��2l\\�%.:ӭ�Fg\\Ȗ�͑)\x1B�F;M�ƭQ�\b��������z��y��� �gKD������ёё����b�d��������f�Td�W�e�|5�[ܴ�t�0���s!��exx8((��\0��I�&544���\v��\\q�23���Q�8:v���Ç;::Z[[Io��ꪪ���ˋ��وmff&�mJJ
}�lݺ5>>>&&f˖-3gμC�O�C#�Kh⅄%m��*�i֭��>A�yo�J�O�W^�e��!\b�9��'��n�:�İ���M���"�R�|c�2���&��$����fV�g���)-j�,i�z���!�z@��)S�n�\0Ι0a�-\x07p9֒\\9��o�������777�޽���������(77��655U"���FDD���mܸ�^�]��ׇ��u+\x1B��P6��Y�:j��\rN�ak�� \b�2}�c�O�_x���CDs�~rI�}�nu��5���k�ȂI{�y#�R�vc7g%���&�f�V�\r��(i��s!��A�Ypp�B�	\0�%�&M


��*�rXNr�Z��8\\n�]]]��퍍�uuu�����Ť�+W��3gΣ�>:u��)S���|��z�\x07|��\x07����'O�������z2���_ђ����s/?���N��3/>��\b���zR���?�o��!\b��xy���._�q�����"\v&�� ���v#6m���[�c�S��\r��,̽0u�{�n�ס����R\`Y^{�u��hǮӒ尐�:�S�����ᶵ��ݻ������<55u֬Y��~��?�\0\0\0\0@\v������|n�_��2��������Ju�R�#3/\f�&�%��fV_��֯=w�B�\\\0�EPP��W_m�^\0��H�8Q��-���?~�ر��nn�			��.��r���\0\0\0�����o-Y�"쓱���kbC�ǇoJ���%'9��{nI��ʒ֝�w����<W�\`.$\0���C��(N\`',$�l��K_
����ڿcccQQQ\`\`��_�\0\0\0\0�>���,\\J��zU�O�7��\v\vI�
Oe����¼墼�eE�[��ѱkg��\f��C�m�;����}@�\\vΠ�>���K�\vG����hnn�����~\`�70\0\0\0\0t��V-\v�d���\x1B�Ē�n�Ȉ��MN(�H��˪)ί//nrw�2$\0eD_���6zw\0p�%$W2�{����Ǐ�Cq[[[-Zt�W��\v\0\0\0\0�y����y.\x1B�������X���� �n{A��I�_��\f�@3d��{000��=�5�\\�0��Ç����{�=��o\0\0\0�;~��ۘ��d��u����De&���;6i��������\\WG�BrP@r<����7z�\0p��%�}γE��a����>���oZ\0\0\0\0������-���i}BdXjܖ�䄢�����Ks�k\\�X�� \x07�,[rJ�O�c	��qO�:ņq��Ү��J��f\0\0\0\`\0O���U���z�a!Iё����I�l0�������eH.\0r�%�D&M�d�~�\vI.}��E��;�w��k��V͗��w�;{��ukb��A1m"�R��<��i*=��Y\v��"|�'[B��G���m�ٖX��ZY�SWR��-��f�2$\x009�g�����5\0����s����z{{՜-�駞��˪�nAA,����ٳ���?�_�~�~��ȋ��_�˖Y�P=c�\v�S�d��}X~
��K����3g�\\媪*�_|+�o2�;AA�IM*w9���g_�d�WG�F���e�s3����];;�ː\\\0�EyP	�O3c	��U������q'�@_��5#\b� \b�aJ
Z_~�u���_���\v�,_������0wwY�Wk,�<,�\v�#�u+��l�> �U$��[[[\v�EA���x�sy�$wÚ��Mɱ����\v�>,����r!�\0��VYr'L�\`�> �%$��/��O~v�ŋ+��0KAAl���։o�����~��pXnR|A�������\r��� �\0��6����F�&\0�1���U��+\`pp��o��᧟z��/bAA��ukb:���X�::tC��t��;[.I�X�� ��ե�\`�)\`b�%�\x07Px��G��-� \b� ����{��/�^�	I����鉱$7wl��%Wq�e�K����_��۶m��s��<&���n�w\0'XBr���iiir{K�}��"\b� \b�SV.�$�<2��lٴ>aKD�VAr+L,�l������LH.0�*\r�X�h���\v��,���\x07\r����r{�\`�\x07��"\b� \b�Sr���z��o��ܨ�T��Ԥ��̝�O�k��2^y啣G�Br�I oU/�X~
��H.;�ܹs��62,���_AA���S\\rb��m����_}mm-$�5KN������\0H1��'ɝ3g����\\A�w�~�9�J.#,,\f�\v�E��@9�L�b�^ �B�{��IH.� \b��m$wM���V�\\"""�\v\f���]�\r��S�|@rA�D�Ar���HH.0�����S�l@rA�D�Dr���H.�=n-9%2~�x���K��"\b� \bb����2P�ct#�*<m�KDEE��\0|\r$AAK�$�\b\f\f4��Y�f�%�)�~\0|\r$AAK�6��dɒ뮻Υ5\`1�K� 00P�8�x�	�3\r�b�y��"\b� \bb��Fr���zzz�x�\re��b>�gH��"A�KJKK����+�p

2�q\0��\\AA,�I�ѣGW�^� ��&M2���)��	&�۲\v]J.1<<�\x07|Ix��~(\0\\\0�� \b� �%b?�����<��^\f�d��ǐLP#����)��0	�\\ēd��.�x��y�:�"3g�A
\vI2|'A{Ė���Р �|L\r\0� 3\r\f\ft�U/�|;X~
�H.�-�[r�}��\0u�����^	Ԥ����d���W�^2_q�/������.���^;���J��RrO�8��}O�qAr���+�\0�\x07H.�!Ԅkh�W\x07o6|�=$W\x1B�t���x�t1��R�\f,V)Q�bW����-�� ��@ ���@r�R������%}�ҏ�KZq�]���t����@rm\`m����pT�:݅W�.�����$�>�+Į���	\0�������p��.��:X��Z�\r�\rP7(��*;�7\\|,�n�a �}��e�g�� �.Q���Al)�eee
�������Eԇ:7���멿!����!�^A�>���\`f�\\�����v=D���[J�����1�~\r$XH.�2�u�x�M�٦^�ݛ��K۱�:T�\\�?S�?�+�\\qH��fl�H�b?�=p���q��Ԕ)S��ŀ_�����LXH��M�82e�&�뉵I�T5��\\�Hnե\x07\b�r0����I�\v/� Opp�ѽ�k ���@r��J7�x��-��,��?"m��zhm�%�x%�\\q
�-�	����Inaaa�"8 \v$XH.�2\\�<�SqX��G���\0��z꼵)m�������\`qr]K��@r}�I��7߬\`����F7b�߁���E����ZrJ�C�ν��zn��^yRN���%��Ko=����;I��ٳ)))1��$XH.�n���H.5���2�kO� H,
\x1BҢ\v�i2�w�b��������XF���\\��\x1Bo�\v5����i���\v%�\`Nɭ�t0W����c�iv��%���gw�?9��b�)Ԫ�U�K��x�Q��Al#��P{F]�э�w ���@r������Fv���-��V����NQnP�K.�-�������3/�S�N��N��\\��\\�F����r��q�U�FI�㹇�j��g�\x07%�Y\x1B�*{�5��+���bŊ+��R�f���!��p ���@r�\rQ�q
j&%C�ʸ�c�����U�y�*%W�8��s��i������&V��\\����[	r�ii�U��,�\\�s�"�Uo=�>(Q�%�ÏH��c�ݼy����}�y����9�э�w ���@r����E�������G�D2H�0���X�p��u�,M7����9�ɕ\f\f�ɟ�����.ǅ%�?��)>
6CU|�t/���*a2�5�UV�DR�>�֕\\�_Dɥ�Z|��!;�_/>�>(Q]%��H��c�U^l��0a' ��\f@r�u��"�#i�T�?�I�N]���hq��n%7oY�meݐ\f�8m�]J�d��zl���x�Ӣ��sŦ���a6���J��R�,tL��)�D����Ƚ�{Vu*Q�$W����X]rx��\0WS��f\0�\v�\v$QI[țCר#
��FQT\0��)��j6(�+9mԕ%��d��*4�bDϕ��x5���xx��$W�v|��V�dTN�HR\vI�ry�g�?��v�߳�S��'�^���M]!��ܙ3g��wޡ�\x07�\vL$XH.�V�n�����H���dǱ>\\�~Qh�(K�(n*W����6ŧE���A�f�\\�qI�M[%��o�|��H�8��im����|��{V�+Q�$W����b]�]�bE�+~���?��\v�$XH.�n��S�L���@�/�,6Ꮍ���S�K��We���^n�EWl�����[�ZK��[Hr����Ky�?2(<^�K��"�N�J�K�<�{V�+Q�$W����bQ�ݰa��_���y�-����Cr������E4�qu9�.�5ݝW,F�|��=�OJ+ʗ�_$W��֙[����>-�]+�g��R%B�8��Aa��̒����Ϲ��YյD��\\=>j|VW�%W�r��ƍ���>w�$�X�������\x07�q뭷���M7�$���3\v��������F�/�����"�::��S�P�\`����p^�,�\x07�\v�v��n�)��V�U�\\��O�ty[qg4����:Z��3�O�CVSH>�\\Qx׈���\\����Z�zH�5>�+Ċ�{�m��|����P��5���a��	&x�s\x1B�-$��]�\0�E�\x1B��+��)�u5�w#Nu����򇠡������h8�X��6V�\\+A͂�V�\\*6�)�]��~Ϫ�%�����Q��A,'�j�S^�n���\b$��ގ?��Ol\x008�W\r\r\rFW���E�\vY�ӣw�tW�5�?���$��J�N��I���G�y	<�+1>�\\+A��.��K���՜�Y�gU��Cr������ ֒�M��\\�ߟx�'N@r\r�4��@?pز�@r��Xɚ̒A�>]L}�N�df�"����
�!x�h7��f>O��S\b�O��è%��%�ү�gU�,�N�\r�?]�{��$��=�����%W׏H�b!�ݽ����w�100\0�5���(o}k G\`\`�ѕ�@r�E2H*��b����;B��r�,jS��t܈��C��tXS�(y������?,8}5W���M�\\]�U]K�뒫�G\r$�\x07�������w����q��7���Ar\r�\v|�����@r_F�O�#v��O��|�r�	��|<�]Y���^\\h�O$��� ��J��*�ןU]KTW���G\r$�\x07�������~���q�W���=z��{��}\r�0�k\b�\\��Ł���7�B}�d�v�ZP��&��\`��g�M�I�x������Fr��t�|�ɕ{�\`$�f����j�˦7""���\x07��{���q.�=iiiF׾��E\\Ɠ�\`:FTH��t���x,��.Ss�m���C��1��9�Ňf�cr��t���ʽ�嶉cr��K�G-\vp�̙3��� ����'\b\0����㇇��.�������Y����Jb+��B#�����&�Ui9�]WW_�����\`�Օ\r�\\]�U��,~�\`ue��䒛���׽뮻���!�������
��6�k�~�����*AR�I��pᜉopYWXl��@r���Y�-r�������q�~�[=�f��-��?���<�b\r��)���Γk�������{�\\����bf�U����7ߜ<$��_ �[2�/?/C�rj����Q�.\f��H.�&���vnE���.݅�I�b�m�6[�̳���RϬ���KrI��T��OK���\x07�Ir�a\\�M�Ͽ�����~(��=����������5��+Ĵ�����r9e���͛!�B���-\\8�pWB,�����QQQF�	�\bH.�&\\�<8��El�Ņ_D)p�Etz���A��&���W��dn0߬dtɓ�%\v>�Dr�Q6q]e�T9\v�AFa��%W�gU��6�*������_�bN�=|�����;@��/�|Ŋ������4���?��ኄ� ʞ;e���\x07~$Q�b�2b��8(�[D�FX�K�Y��DQ\rpSr�yݎ�pU>���S��5�$9�$W"5r��j���KBQ�5�%W�gU��?���C"y\v;-{�~����sJ����b޼y��\\߳h�"���3�p?B�瞗�?~�x��\x07~$Q�2��6"�\b;��bw�~��7ؒ	��te����^+9���u�OO�<��Cp������E�W����sk]IY�U���+�����^���-���YկDŚQY��'�ܭ��Q�˺BL(�kָ��p�g�g�/�$�{�\r_���t�R��>�Q�x��^1܌ۤ(?R��\0���\fH.�2��TC'��\0�x����]�J��8��f���QW�t�K�n�l��x����1&nX�X��1Pr饔�����TV������\x1Bwk��gO���%��>�:����j^,�nrY�^���e]!f��ĭ)�\`�)Cr\rG����7��\b�S>JKK�~+�\v�\\D}��\\Ɔ3T�KW�8��\r%c���rrJ����t8F�K��T�\\j������?�,�U��\r��cq�\\�� �\\j���nP�\x07�Q��+��xe���(�(�J�)��=����h��g)�/+m�?3re�ݏ��b*ɭ�Y�r������΀���I�&ɽLXQ�n�Q�b���\fH.�V$���9��Aj����	�.{~��۾ة�$"Im��U2�J��\x1B�ge��J��;@W;v��[u�\\�ݓt��!��B� 9]�$��t�>mA|�ts�caw���j��=��p5TB՘.���l���6E��N1������T���c��,t�f�\\b���ݏ��b������p'L���S��$�Y˅��\fH.�n$�;nA��բ�R2�r��xܟ||Yb�B��Fr�d~\rPxZ�\r���:��<��H.=]v��J\bp��$��B{�J��ϪN%*1M��\r5��ݏ��b�m��u�]w)\f)p~~q�\f�\\ߣ��BrH����"��x�������{j:[5ۤ.����#���J�}�R)�Uc~-��ut3���	�"��R%��@�sJe%�5F�7+y��Cru}Vu*Q5���ϳJ���G��
1��Λ��˚��-ڷ�\0$�<@rH�_�E<	�(�8����\x07K�,�\x1B�ɖI0���Iv�;ͦ>*����9��h@m�d�>%*�~FP3"l�8��	�S�c�U�J�4�q��ӷ;V­���G\r�k� �˗�
pETd���O!����@r�
H.� \b� ���\x1B��p���\f�k6 �\b$ׯ��"\b� \bb�+����W]u�����w�g�\v�5\x1B�\\��W@rA�D\f��;v�4ܟ���=� ����@r�
H.� \b� ��Q�[VZ}���P6��|�;�w5qõ��&%%�%�\x078m�4���1��C�@rH�_�EA�1Jr_yyF�+rs�Dõ���z�ʏ��_4�C�$����\\AA,C$w�w\\-1\\+J���$\x1Bҵ��>��l�{N�Q5g�k����0�w��ZH.� \b� ���%wѢ�]���\r�Z]rEÝ6mڦM��k&%%х⣦�5�Ot�KnUE�/ɖ�����B���[�������H.� \b� ���%���^7n��n�u��귺���[�����tIQQ����O�cW��	1��Ι��J�ILXk��Ar!���� \b� �%�K�}��Y�����lt���ⲲjJy�NIRS3�����m۶�����̜�����������⒋��cxxX[��%�\x1Bngg��M����÷�\`�9%wx�p��K�����B�57$K�F:�0]b��Ar!���� \b� �%�K�����,�涙K.c���jn�W�"56�UtsJ�h��o��:���L���@\f!�@ �\b� \b�X">��I�&�\\U���U�f�x��ˑ_�\`B�\r\v]�����s�o���V���[��=��"\b� \bb��Fr��>�{�GxEr��xd���5���x�Ml\x07���7=��c�u� �@ �\b� \b�X">��i��d��j�sɽ��[�ߊt��5$Ws���h\x1B��-��.3�� ��\\S�EA��[r��o|��F�����m_Wo���}#����>uwu喖��G����?~|xxxtt��ٳ��P�������F�K����\fH��Y��=v�7�x��->������\f7;H.$�T@rA�Dt�\\5�)_u�U�M\x07wxEr���N�:�$��?��]�t�[7��z��<�Sq�*���\v�5�\\AA,]%��r�d�EE��*%��v��䶶����\rRoc�Ir�Cr\r������ݭ%�$����კ��$�k �\b� \b�X"�I���7m�lo�V/����r�+�U>}���3g����/�0.$��Vr=ɭ��\r\v]Ƣ~��Ą���Ό9s_�\v5�2�w�g�]���67$Ӗ%���ƛ�¼�0�\r�k �\b� \b�X":I�[o���p�{���%�\`�a9����<v������'FFF���|�k��r�����Nm��vU��8���K�U/�����r��drH.��"\b� \bb��!���x��{v��%���r�[^^���?44ćq\r��|�k�䊆胵��[%C��({"�&�V��l��+�G�zz!�~$AAK�뒛�[s���+w���߷��V�%���;��iii�\f�2W�<$�"�H.Y�z��0����\f�j�=�%�AR����ˢ�;;N���J�yV��JƠ�&�_���*���@rA�D�+�u�\x07��*\x1B�q�
\v�jv�U/��G���MKK\x1B���ø>��|�k��r��i�T4�9s_S�-��ҭ��[w[�\f���c9�w)���R8�t^�G�N\f�5�\\AA,�J�S]����7��qcxEy�z�U6\\����\f�/�̎�5d�<$�hɕ�'�Pm\v@�Qi5�G�ʯ�h��\0����'�xe�%%��r�-�蹆,:\r�5�\\AA,/J\v\\��C��f��ܞC}ʆ�������\fW��̎���0�yH�ђ����[I�<^�XI�Uފ��o%��S��/
��&ʒ+NT��K�=�^lȤeH���"\b� \bb�xKr׬�pi���v��7橔�c�'��mNvŮ]���:��\f��sJ.325�k^q\fT����~%õ|��gsK�}� �|��-]��g�WCrM$A연�$�ݑ�^k�.�C�}�E��ϛ���;� ��W$7-�إPP_M��Rr{{�:�444%%%�4ܬ����A��yH�9$W�A�\v �5Ռi�;�X\f�Q-��՟�V�Mw%W<W�����\\H���"��2s�\x1B�c���\r�%\b$A��._�!xU؆��ᡉ1�3��3RK�
sk�՗mo�(m�Q֜���5�*\x1B�W\\q����9FPPВ%K�-[�jժ�k׆�����o޼9666>>~�֭���Ic��ܞ����Cq!�>���+�.��p]	�ʦ�\x07�5�����vC\\Z�6�.tkLY�o���~��Wn\vɵ�\\�Y��k%�{�_ۦ�ni��׷D�?(H.��%�����Q������[（�$�����p��=�5��%�
�%��X�[��\b_w%�?\r��|���'Cr�H.��,�b�o���$\r����� �\b�w<�����d�+&M�t��W$w߾}�O�fk)��p�Cr� �b�:=z�$����=�Ag��RN�&����#,Y���r!�f\0�� 6\v������o�3g��ɦ ��\\1C<���^�m!8?����%����\rವ��q��\x1B�yH��$W�]ɚ̎\v����\`�B��'3��%�%��C��H\b�k �\bb��%�HoK�[�}��a���$׭\x07�:x3]��m�A��,����l����;�Dr���:;;��:�n��!����~�l�T2\\+�:���;����bY$��~�%��P���F�!���� v
_r�\r&�$��������A!�E�Mr##]��W]u՝��,�Ǐgz�p�f��!����~y�N����qL�Ä�r>�ˮ�yue�!x\b$���"�m".9�%�]�����%������A!�E�Arc���\\N��[��/���n߾��������n���-%W4ĀKGlu�%_�\f����*X�f�Gr}<��k �\bb��%�Hl����7;���@r���ĢqWr�R�O������\\��N�KnzzzMM�ѣG%n+�\v�5�H�x���KB�
)��G�cr�\x07\v�c�W�zO͂N�%���Cr�$Al�:V������ $׮
A,�]�"t�'Q�\x1B6G�$��m۞�Y��i�\x1B��������ɰp��5k֐�FDD��Đզ��fff���VWW766��~q��_Dt[��Sr�=ܚ8�)Qf/�4����z��,��C�����H.��#|ɩ\0�5��m��l5*�����$��M��j���/��%��J3g�A�|*t]x�]_�{�>�"]��^�aIx���lQ��\r�b"Bc�3��dgT�׽���\0Wl�Llo�ߖ��'������kkk���������E>;44t��)vJ jQ���C��m���b�,�w��lƅ=9O.7S�P_���[����c�\r���\x1B�\\�G��S�g\v"���eS�:�m�w\f�-?���.'Z;�(mYb͎8�����:����K�����My�#�ɣ^rW�p�{o��d�ʒ\x1B\x1B\x1B[YYYWW��ظ��C�����8q�����p%V���[3\`�mQ�Z�����J�;���t/�(�ߖ��H�ig5��L!=����U�4<|H�\r��"�\r�t�)1܃��u�c�G�]����\\"z����"7���R)��b�4P�#�^|�\bb�(Hn��؈����̔�\x1B�����3���\f����<!I�;v�����t���Ç���SC2::��
D]�S��ۚ\rSI.w7"/;̓M�\v,K�����|���[skS�a��J�8
��a�|���Cr�\b$Al>,(���8n�08�Kɕ\fe�9��H�%�W�GQ�Dw�9�\r�>�f��7��'O�ɥ'_r��a���3���ً�AL5�\x1B�!������ѩ������677��\\��&���$�Ė�;9���\f*
s�tk4�����>�ߔh��K�8��������?#@r-
$Al�Ǎ�C��C�nmV��E�pN=��X%3o������$gq
w�����KɥWA4\\L��TzN�++ܻ~�A���\x1B��?�sW�"�]��5;Z��*Kn\\\\\\UU��ݻ[ZZ:::�92000<<Lm	���A[K\`*ɕ�oj>�Tv:V+:��M>�+N�+�\\���L���J�v�~�)�<�\r�ki �\bb��¨�ZW0��O�$�t����3jVX=������ܬd���'���G�yJ%þrC��=v1[\\J��=����2�p]Jnuu�Dr٪S�\\ka6�\x07F4y�h�
��im�LZ�R\x07U�]��3�z2]��KW�
P7iY�Crm$A��%�Ĉ�jJf��E'�U9wZ���N��խ�rw����'AYr��_�W�ᷢ�+��;��-ʒ�ԓ��%gsd��p�%7>>�$wϞ=���\x07$����*Cr-��$��KWd
\x1B6U9���&�c��\\�p*������8;����Hf�๤��N���SEU��//=�8������ΐ\\��EKG���|��r�$�N������$:�D���~��nˍ~zKrE�tk�'q'�W��cG�EAr�w���xs�����$7!!a�Ν���$�������CCC###gΜ%��	�Ƅ���_}��.�HV�b�H�K&\0���/�fKnE�}�� I2nG��\f�^8�(t]ȯ@ۤKDg�"�;]A2l�Rr%~�vO2*��xG�\x1B�Ar�\rH.�X:\\UԌǉK*��=$W��jw�/���͊G�����\x07d�=�����!\`�;��ukb&N�!5�ܭ[)H�K�~�/m��$���f�޽mmm�$�$�gϞ�NAr-�9%�\r�:z�J��T�9L(�U����U�{||Y����[V#�r?\b(<3F.$�$@r��rye�k�\\_ɥ�e��p(��mU�#I��^r�IP�\\��Ά��?p����=v�)K�f�G�\x1B�����%w�#���u�InxX��䦥���䶷�www�'�%�e�ǅ�Z�J.�d\0�%�C�*���]n������#Ѥ��d$�)�x������	H.�X7FE���_ً��g��;�)>^�3%)����*��Qk[�Iy�U�ǎ zd����opr^���&��\\sma~���cr��re��䲥�%�"�=w�V��&�\\.�l��S�cӃ)���#����K��5�o:Ν&��L�v|��?K������kW �\bb��%�Tc[u鑘���V�#����8�W2����H.�\rj_56cYa\v�=v�nJ
Z�,u�#��|�k�ܔm-{{�$�~�A9�}�gjjj��l�)�?ȺXBr{�k �\bbш�MU��,���QE�K�x�"�6��_L!|,�q�9$�D�p�d��׳g�W�6� ��B���{$7+�XNr�x�\rq�2? W��$�@rH�_�E�F�Ռ�$g�K�8�!/3�䊏Z��}�o\\�ǎ �JNz�ĉ7�|w�\v/y?X�N�L���W�q�b�����.e�]��C9�\r���gg�����s�q@���"�\\��� ����P�"�K�xl��XHr�G��d=�\\��Q3��u֬��jW�\\�u�������Fq]e~�\\�U��\\��W@rĊ�������:���s��Yr1�� U>��U+7T�5)Kn��}
���\v/444����a\\��2�*[H.��+ �\bb��%��-U.�Tg����\\�%��"\b\vy��/����^}��K�~R\\�KYr�p_{�5�ݴiSss�����Ѹ�a\\�U��\\��W@r�r�I�j�*���uue��ey뮕�\x07�+#�o�O��\x077���\r1�ʒ��b���>��3uuu��흝�lQe~4.\x1B��\\e��E �~$A,q��c<N�ã����8�Hz�K�oΓ\v�E��Ԥ������cOD�'�$*Hn��#		�O�"<<����\f�OTqƅ�Z\bH.��+ �\bb�p�Qz\\Ǭ���>rr������}��3��\x1Bo��Z��%��w$���B�o�E,�%�\x07�_r�%\v,�\bK��Δ�ܝU-	�)��\f����\x07�p����D�s��}���8ע@rH�_�EkE\\rʓ��J��ʾ���r��[q�t5��C����J9\b��"�MNz��Y�"�3g����9o���¿�����>����˗�Z��O��N�6�Oc�4�g�y������2�u��\fɵ�\\��W@r�Z�#�����\\LYs��\\��R�F�EOt\\���+n��N���t�*H.b����\\���	̷�~�w���_������{&O���CM�2e�ԩ�=��z�ݺu��p�����li �\b$ׯ��"��".��1��6*{���Ry}Q��F��Z�.(��u�$(K�8����\\��Cr+iCr�$5��l��^�ޫ��JW�MLL���>r�H?\f�f@rH�_�E\vE��|�U1��/�rUy}Q�U�K/�O��?	ʒ+nJ�~�K�'*��pH.b���җ;KNz]��S��'����===G�8q�ĩS��,e��Br��B�[�i�!vJ�<�\\��E\v�댆U��F�fGy�S�U
����\x1B�j<Wܬ�i�'z��K�%�����0o9,$I���82$��$����yyy��l\0��\r��2\f�N(t�\v�1\\�ۤ�1EAr����~+�\v�\\�J�%���n�1����,ΰ��tkn]_�e�.yP)�et�(zdsr�L�O��?(��[�08�vXr�t�8櫼A];��-zH�\vZZZ�޲�ӧO���a�v"((H�x&N���P��r��#\v�ڊ����"�U")z���f�@KlKYrݽ�xf�(n�΢��A��ܪ1��{���\b���O�+����JFF���\0\x1B��z�p�ق\`��!**J����1\\�\x1BDy�������EKD\\�H��Ej";�3R'�or~���t�r
)�r�'�EO̓R)�|�.5mP͑א\\��-�]�paVV։'����\r��pm�������\rW$�����R>�wpp���?�� ��!�"As�$����ls�����҅^YX\fAl͒���O��nڴ)77�رc#c���3g�(�-\f�P=({����yˈ��V�+\x1Bn\0��-����aH.� \b��m$wÆ\rQQQ�����٥��uuu---������|�dR���Qn�;�MN�z�\\�B���?��R]�.�&��)�����	\f\f4��_�_r黆�z��Ν;�� \b� ��\r\r\r���޶m[^^^ee�={���>���G��WK�����m1�ko�^\0tø>�*�{��H.� \b��s$7,,,666555??ǎ\r\r\r\x07��������-'���E�zkW�0�v��,Z�����;�,���<�K�S� �\b� \b�Q����𸸸�����������Ǝ����ޡ�����"��_
���\x1B�;���F\x1B�/&M�dt��#��\\�V:{�,}IArA�o� �������555��͝��ǎ;y�����s��x\v��[]A	�W?~����%�XKr�͛'���\\A�w$7222!!�$w���\\r����J���\r0x.�&Lhhh0����K.}�}=�>}��7ߔ�[H.� \b��;
��y����Ĭ�,��rkkkwww����~����p��[�B��1\\������'���"\b� ��FAr�lْ�����SVV�k׮}��:th\`\`�ԩSgΜa�\v�&M�d�\f�1~����\`���߱��S���[r{\v�EA{GArcbb���***���\x07\x07GFFΞ=\v�
DEEAu�W �]�hp̀%$�/����o��-$AA��eK+��\x079rdhh����$��\\H.P���;88xʔ)^�$��SAAA�dt��1�䞿t�)�]�&��/_AA�\\p�e��U����w�����t����G�?~��:�r������\v�1z/\0P�%$��="���g�7��AA���T.����?NNN����Nuuu���?����>����\v�f�zԘ�\v��U$��[]]-��'�\`��/� \b� :e���z�����|�r}}=; W��$\0͐۲��SV�*���7nf,#\b� �_���u��\x1B��3fdgg����3���8 \0��O�4a���\0U�_r�\v��;w��\x07T̥/Aÿ�A�n�q���Ђ�����={����:t���s�����VZZj��\0��H.���pXn\0��EA�%>:O��'?�Inn.5޵��l���whhhdds��zs����@��\b\0�XHr��
3����7�u� \b� �W��T�0Q��5kVqqquuuCCC{{�8���U�\\e\0<�-9%���m�N�KH��K\x07s,X�Ȃ��l�t����@�6����ƥ�~���-**ڱc��ݻ٢��h\\>����\0x����nѢEF�\0.�������~��\\�駞�I�3����t)���C�6���e����\0W̝;���b׮]l��#G����Ѹ|�\v�6�g�wX~
��H�ya0���?OLLt��0v�n|t��_�vJ;�w:�?wM�Ń�Fl���I�[�|��w���[�?��?�p����p8p��a6Qytt��ٳ8\0���IKK3z�\0P�r��s?�쳇zH�������S�-X������'��7!��|}��;� �mAa����S������+�HNNfc��p���N�8q��i�DeH.\0� ��{N�2��@	\vI�y�I˷�r�ʯB\0\0\0\0؉�K��޽[4\\~(.���a\\\0<�LV�=�姀���䊞[[[���\\\0\0\0\0،����\r\r\r���\x07\rW\\Q�\v�'8]rJ$((��}@kI�y�s����\\\0\0\0��X�xqsss{{{WWב#G���O�8��p!�\0h�V��8~�x��\0Y,'��/�\\�[\0\0\0��+���>hkk;x��C��=:00p��Iv.\f\0/B��-e�n�+J�y\x07����fΜi�w/\0\0\0\0�⦛nJKKcz��������������Q��pa�\0x٫�w%y��{
�s,*���ϥo����_���F	\0\0\0��|�[�Z�paWW��Ç�=Jz;44t��I6E��-\b�\v�Q	X~
��J��K=��{�ܹ���\x07|��/d\0\0\0\0x�u�]��ﶶ������\r\f\f?~��-\x1B�eg\v���-\\.9%h���KK�y\x07�eC���ǎ\v		����ӟ���h\0\0\0\0�eܸqw�q�ܹs����j\x07\x07\x07����۞:u����Lo�^����-�[տaǏ?<<l�. ���pT]6�{��Y�*mii����#�"�v!c�������m۶%&&���mٲ�/�ˇ~�~��5k�|2��ի׭[�q����p�Bll�֭[����iii����л����+RRRhkIII��9s��%��o�MW^�jUpp�ڵk�|�͇z�.�{�������iS�.�c�?6o���\f˖-������������G�v�o���O<���^�t)}�U���iӦQe���[T�����r��裏���r��'�x�.�9s���f��v��wɒ%r����g
��_v��������\\�}�+l�0WS�rU�h�"�\v������!�!���r����Fo��\0xzߩYrJ�Ob�=�sU��1���S�A_��\0P'p�ĉ����G�vww���_{��/��Buu5�\r�c���UUU���566���uuu����M��M��\\jK�����t	mppp��@_�e������my׮]{��ߴi�Nǎc\x1B���^��+�_����c�\f���������Az8===lk���c�����W^y�k�q��[ZZ�}�]�\\R�TWr�={�lIm�۷����.wZۧ/B��K����ʛ�������O>���ȭ¦k�{^�YYY\v,PS�rUM�Ga3�%�{\\ⶢ��p�*���4i��{\r��H.C���v��2�e|f#΍Am\0�\rԓPsBMšC�����E������JꔊǠƆ���������K�\\QGD7��7q�Y\x1BF�	50�+C|||EEŎ;h����������ݠ-�#��_�l����@�LmRgg'=�#G��N��.>W��<���D����&å�^�f��Mב��9s�U���4]���'W޴��ߢP�W^y%vdd��\v[��322�^��[�}��n\v�@'�X5e@�QF�8\0�\`3�e�S�}��R�n#��l���8~�8�@�\b=��#�u\\�dIaaa��2UUU�ٳ�\x1B�Fz{{�Ţ\x1B��㳋����X'F�Ill�2lݺ�5K�w�njj�>��5�f���P�2�.��*N���r�\x1B\v\`ki�C��d����b��\x07���^�n������ڦ*����s�U�l�|�i��ʛ,\0�����G}d��ꬬ,������E�\0�\x07���\r��S�|�Rr9�t�K��ϠD-���\b5?ԫ�������;����e�!������Q{������q��jlX����5*Yk�[�r||�\\����L\rXmm-�\`���\x07 u���ކ��56�/��w�8�{�\f��M�á�I�/�����\0�ᴶ�����~��;**��ڦ-����y�ܪ�/�	$�}���&\v@y�-r�����U�W\\A���-l���]գ��Ǎ�,\0�3n-9%�OSao�u��B엨ᡏ���j0^}�U�\f\r\rM#==�����b�pH���ڨ!���>dtt�56bW�Z��gϒ�>%5c���uuu\r\r\r---ԃ����mRo�N_���k�H�<j������Jz |8��@zt��l��q9M\`3�j���D���ӧ{X�T�r���o�U������)H.��"W�T�ba����-l�գ���\0�#4,9%l�#\0�k�Mrm5\0��V�	jQ���������Z�|��\x07�*��2��啕�Q�C�Mgg�c�N�8!�K��\`-5't[�~i۶m555l�6��\r4�G%\x1Bh\`�oWx�G�S#�U�;vP�ď�bs�h�|8�K,�ik�j{ƌbm�;�񰶩�\\���>iy��ȕ7��"W�S�L�Ja�Uunn.
\x1B\0KC��^i��oH.�0a�я\0����Z>(�~�g�ި�ذa�䥼���cǈ����)33���������a���ԓ��ogΜ�}\bkE<�\\>��\v�E��;::��<"�g����5��\\m���E�
{Ϟ=���p�Bs6$\0�B�*��%K��iBPP���9�����\x07�W@r�\vo9������C��}�ݎ����?��]H-Sjj*u#eee��P�������'���"W�|e������!��g�Uؿ�կ�Yؐ\\\0l	�)��?~��E�$J�WWc��S�<@r�\v����bKtR��ռ��\x1B���"""���333�����+�\f\r\r������$GxAr��qZ���<�.]���!��g��M7�䴰W�^m��\`K��S���nv�K�eDEE�y��0	�\\���\r�Μ9C���%�D>��������ȸ����Լ�����ݻw�۷��d"9 \v�\v\fA���o�.Wۿ���5�6$���f�4wʴi�LXؐ\\\0�\x07}��gΤI�$�UJ.�BPP���\0$עHV/9q�5]]]�\x07vq~�_lذ!,,l˖-���YYYd\r��477S�C�I\r	[Z��<�\v\fA�����j���.�\\ې\\�\x1B�
��6�UW]e��\`?��Ң��/W/����nR]�\r\0��Z��K�?��b�ҥ�\b,_�<$$$""">>�>�


�%�����۩9����d��b�_���!Wۻw�V���R�Vې\\�
;@�^x�l�\r��pWr0�\\+"Y���ɓ�����ݷ�v�r���?�y���aaa������������NK���%�����>F��?��C�������!��\x07���o��\\ط�r��
\x1B�\v��\0���kE�ZrJ��k�]�fMHHHTTTBBBFFFQQQuu5�:\x07W2a}�c@r��pwe�ŋk�mH.�r�-9��%
\x1B�\v��\0���k9��^B}�3�<�Y"�͛�~�������ؔ���L�i) �����vzz��ھ���5�6$�\\a��Ĩ)�ɓ'���!�\0��\\\`] ���u|���'O���uuu}�[�R�/�v�mk׮\r\r\r�+������L:;;�J&� /v�$���VX�G�������ݭmH.�\x1B\v������mH.\0�s ���@r��d�jl���z{{�-[��YbЕCBB"##��Ӌ��������O����tGԟ@r����v}}��S"O>����\r��"W�j01gaCr� ���@r��d�~���������S�nذ!""��{1??�O~������?y�$[��\v|�\\m/X�@}m_w�u��6$�\\a+��ܑ����)lH.\0�$XH����p�E�Dg___NN��f)���^��ԙ���I��d+���	�\v|��ڦ^��<"$�n�6$芷
{ɒ%&)lH.\0�$XH��\`��d�N�%{�1��%b��ټ_"G�GxQ����;44�ν�V��&$$@r�~��v||�����_�ҭ�����+쐐w\v�����I
\x1B�\v��\0���k!$�v���Pc��֦r�)�;�#222..N엚��:::X�Ö�d��\\�7Nk����Gu��/��u�֩�mH.��¾�{4�[ڐ\\\0��@r�u��Z\b�y(X�������f��r�JR���Լ�������ZI�D=�\v$�\0���o�>m���?�Y}mCr�~8-�;wj+�����3CaCr� ���@r-���	�����][�4u�Ԥ��������
jx��7H.�=Nk{����j�ꫯV_ې\\�N\v�\\U[a_��f(lH.\0�$XH��p엨���,1HMM��d�������������������K�_H.��ڦW\\�8��￯��!�@?���q�4��U�\f/lH.\0�$XH����|;}�����57K�\v���***��Ꚛ������!jNxg��\\�\x1Bk;&&Ɠھ��U�6$�ca�[���\r�����ɵb�D=Loo��%���+o��V��{����;�������6"@�	u&'O�a\vuBr���6��<���\\o��F�ھ馛.��2Ʌ���jj\x1B�\v�ñ���_I
�g?��BaK.��+\f/lH.\0�$XH���\vu�S..[�L|����?�gь3�^з�z���߾���\vSRR�������������%� �S.Br��Hj�
I��뮻.&&&**J���L��r�����7��?���چ��P.�����PS�����-^�p�Bc\v\x1B�\v��\0���k!x�Ď�����+����$--���������^�{A�ϟ���^~�����ӧ7778p��y\x1B��l\fH.�\x1BImS\x1B��sܸqs��e��0���Ga��x��'�\v���5�\r��!)l**^�K�,q������\v��[ؐ\\\0�\x07H.�.�\\k��\fRK�)���PA�u�2ɽ�\v,����V$55599����\v�����N��&59'O�<}�4��F=	u;�_�O �@oxU|���\x07�'�|�zf^������ԩSymS�M=<6]�n�:��\r����*g���T�3f��V�3g�d�M�k\`aCr� ���@r�����ꫯ����U4��8q�5�gϖ{A�y�ꦒ��������������~��/[���Ś%6@�������@r���ڎ����o[[[+�m*]��~��G%�]RRB�y�=���m**H.����)S�r\v\x1B�\v��\0���k-x�Am	\x1B�b3Ө�\`�s��Q�܄�������̢�"����������JvT���\b�Fh�l��P2�%��A4K��em������c�=���� �(o\x1B�K���[����h\`a��\\6\0V\x07�\v�\v$�r�f���[�������s�*K.9iVV�������8p�z�F�b+�}H.�ʵ������j\x1B�\v��f�\r�����ɵ"����vR[r�̙���y��)H.�!)))���۷o߹sgSSSGGGoo���;��C�1�g�z)�\\�\x1Bj;==]�4�6$�\0;6$\0��\v�\v$�r�͒��+
����7������iSuuu\r\r\r---�A>�0::J�e����J�<��HrY�D"�����q���gϲC���ɢ]M&�?'r����k[y}�j[R�EEEr�}��!{����d���6�-W�999�.l��ɿ��$�JKK[\f%00P��\f���w���KǠOZ�߲f�kr��s��7�s��8}�4u/.%W8x� u#Ԋ�m�✬�1��9rĖ�Z)�O�cmgdd�t\r�m�������3���Q�
�뇅mt��
�����)S�\0\0�dҤIAAA��n���D@rM�ӾH�$W��V]]���H����_��E�Z��<�O�@�K�������ggo�&��\x1B��'�&�mX{�����z!�~�����\b����ع �:�����=�}��Va�\vh�m��\\mϛ7ϭږ����\\(o{��Um��V3�k�¶wU���E��sl\0<�̮������)��\x07�N���w�Ұ�4O�:�0]y����|�Ϊ���{�vtt�Gc�U:Ԗ�-�����K��������={�455�߿����رc��#�o���l����������hk����.6( ���-�?�렌�M
۱���agZ�V��W�ڞ;w�[�-)���î������mP�rUM&n�����6
z\v@o�.AAA��\f�5N�%�>+�·�Z�3gΜ>}��ɓ
�+/X������������������zjozzz�o��|�\fjKؖccc�,�֭[iS���l���������^jo�6�\\5�K>�\x07�\v]x�СX���y�$�|c��\`�ߦ����Vʱ�2�N}Z؎����*W�S�N�\\��W�ڞ3g�[�-)���|��]�N����aU۠��:++˖��Um Ԋ\x1Bm\0ؓI�&�\x07��oq#���c�$6K��m�\bkiFGG]�'w���ԇ$&&���Q�]QQ�{�njo�4�)�����aP[¶�2$$$Ц�����7�V'ko�6Y{�:��t!��bd(++��Ҿ�5L��\0�\`t[���,YņJ�AY�w�k[�t���k��*W�o�񆻵-�wnn�\\y�Sػ�mY�^�j\x1B�\\U��ۻ�mY�Ƣ��\0�sƏ��G�Br\rı_�͒��?�.X��z\f�F�y������^�^з�~;:::>>�z*j�KKK���ZZZ:;;{{{��hk�a[޲e�t���hS�2�ܹ��������S�#�B���6(�3]H��JJJh�ęo����!�A���Z�3�o�x�d���+��X����r���#�h�m��\\mϞ=����;;;[��;ǰqyۯ��U�6(l��NOO�waۯ���\v� ���yː\\�P���0�#��1r)�9P�R\v188���7k�,���7�ܼysll,�T�Z�l��-�ɝ�v�"'O�d[���zB����TYY\x1B\`�ߨϡ�o���6(�3]H�U�\f�M�HWW���~�n��s�����7~����OVi��U؎����(W�S�L�\\��W�ڦw���-�wff�\\y<x���m���bU۠��:55���m��6*�{\0�r=����\0�5ǖI�X��6��k0'.r��q���8v��(�����\v:w�܈�����[��#�v��Q__��\x1B����P�ö�'�\x07�MQ�T^^^]]������6i;l�|��n�۷/\\���⎎j�x����K[���w�a/%{ey��;(�}�띌.d\v۱�����j���\\��W�ڦw���-�wZZ�\\yw�a��Ya{��mP�rU�m�6\x1B�ͪ�X�9�JS\0����\`���\0��=�e��X��6����\f\\�������G�RsB-ʫ��*��Ι3'444***...555//�:�]�v��\r���"Ԝ�-�\r��z0�TAAAIIIeeemmmCC�+�:|���a}�g��tס2�8��/����,���5~�H\x07k�x�d��ɻ��X�111r���Ci�m��\\mӻ����;%%E���a��Ya{��mP�rU���h�¶YU\x1B�ʉ�'���S�!\b����Wͻ�?'-Cr}�Ӗ��v�%�,�6I싈c�9P�@=��Ç�9��b�̙r/�Y�BBB��é�'���\r;���"ԟ�-oܸ�1���M�������q������v�M��V��3�m��2������KlSlk|'�Z�d�)o�X�:(�>���x�I�5N^/l��޼y�\\m?����k��*W�3f�p����NJJ�+oڂ���~��GU۠��:!!�~�m��6*	�\r9��a�U%�\b��LNzݒ��]��-Zd����@r}�c��G��!�/��l�S�2�\f�G���C�Q/A5����\v�a�rR���7v��={�477�m�o�/B_Fl��ׯT��hS�2��R��Z[[�6�>��6Q__�^���<�/��|�N��,ʑ���Q�}b�\x1B&�tl�Sq.�y'=
۱�###�j��\x07�\\��W�ڦw�����M{"W��cص��Q�:U�\r
[�����m\\���j3@��r+�r�&íA,�Ԥ�LSxgM�0��w�����\f�-�8"��%6��%�&�}�[�����N�%�����_�{A_{��u�֑�ROE�HZZZAAAEEE]]�޽{鶴�l\b��t�ڵk��z0�TfffnnnaaaYY�Ν;�\x07kjj��[��Į]��ʐ����/���{�mq�\v*�8zq����[X���\b�\\8�\f�T؎�.W�����ڦ����K/����yy���ɕw�ElY�6(l����-Wձ��6.l\x1BT�I�N[�_�&�pY@����u��\x1B�_���F\0�H�oPn�؈\0\x1B\`�j�Yg�Gb�A�P�@]��Q�۷�����_�{A_}��5k֐�ROE�\b;'oo趴ޙ0��3�|���Sd��6E-SVVV~~~IIɎ;�\x07khh��d��x�à����Y-m�����K\f~��dS�B�"����\`\x07k�x��V�ql��D8Ӻ�'��Xۡ��r�=y�d͵M��mz7i�m��111r��6����6��kU۠��:::�~�m��6	݊s�_~�u�5A,���<�����X���\0�-;���Bߛ�������c$�"i��[����S��#�Ƚ��?���ٳ�͛7�|��>�hժU�ׯ\v\vcg��-�v�ٖ醿�aΜ9���K��X�"88��;DDDlٲ�o���6�t��}��s��I��˧���ed�o�N�55�\x07���>�މ͈�ƉZkS5Nn6u�ԙQU�cW�Ij���ߖ��_��k��*Wۤ�k�?˛Uuaaaee%��	V)l���������¬�U>K(l�!�޽{-W�桴�T��I�3���y�����b�v.!H��&�t��2\rR�D�S\\\\��%W�/�]��
F�;����QVVF\r����y��������Ɖ�%.�i���6=���r�V+��.����M������v��%
[��u[[\x1B�aQ��\\�MMMV�j�p@��G�n\x07\bb��\\�I�]6i�$�?|
$Wo$��e:s��2��dffj�����&;�0����D�e3�x��\x07\b��&�h/��,�\x07z�T���Q�c���ITל���㺽������g�m\x1B��E�5gU�
ɝ=k��v� 6��e�?|
$Wox�$�|c�sR�����]�����$�TTTp#�x��8\r�<g����i'w�����\`���wiii[[��\v[����������m3��٪��jS� �K�6����r ���8.���b�sR������׫m$H��Φ
\x1B���޾����A�O�:%΂���Ba���deey���\v\0FFFFcc�\x07LX��״��\\3P���>�������l@rD�@r9�\\]q\`3߆��[ZZ���
ɵ1���b�D�x�����~~��Q�r�M��-H�\v���]�v��k�����5�mKL�qm* �\b�w �H��ȍ\vx�e���\x1B�8���YpƎy9vGG�w;\\�����0�5Oa��㚁¶+���6�\\�;�\\$W?��Z[[���
ɵ=�8���q������\v��ѣ^�e�l\fUucc#;>�\f�-�qM���ǎ¶1��^�&�� z\x07�ˁ��\x07��W�/8��s��+*v�ڭ���]������;vT��r/�3W�^�~���а-�1�Ť�����o/+����h;l�,�?5��;wք��Ϝ��ӄGDnۖ�����������_PTT\\ZVVYYYUU���&ki;l�ʏů�V㔗�G:�����R�F\x07�C�|9α�i7����?���\\5O���CBdWş<y��ڦ*�����ujۭ�+��\f222�:Tf(l�״'n}\\����>��ð���\fUmB �\b�w �H�~����*����j:��斣ǎ���359�ٹOϞ9����S\v�D�]�n}N^^~aQIYY�Ν��\x1BZ���k��ر��Ct[�m��&n�̹�ta��ݛcb��nw=;���С�G����<~����\b� mA�&�sjd�p������\0;ԋ��y��_N�s,���r5��a/=^*	�O�X��KJ�j{��74�6�I��S�3P�z��VS|Ҳ�����Z����5
��q������P�&�� z\x07�ˁ�ꄸP'��������q_[�[��9H��C�X��s�����C�غ����Xش3j���^�3�n�Wc������n�:���_�lv�7{�M�%���:�ly7\x1B��nN�8^�M�ږK�Q�b[�e[�d��"�,Q)J$��{ｂ\`/ H�$�iJ�����\0W�\rp\x07\`���<��
$.\x073_�|?s˴�����kl��k8�hl,��sg.����P\b�XX�.�\\*�\\�7Ë\f�����\vI�˼����2tw\v����d\bIM~\x1B�hl����&��	���\v���=222Ȉe���j���Ɔ�5[�584,l켼<�O�(�\\,,_B.B���8�K�\x1B"d\f��B���%\f2�<���h�� �\x1B"��\bY@������tl�,�v<]�����t��VM�4�N���t�B����u!�R!��H�O���&2!䪩��s���y�v��y��ؕ���#\\dՔ08�F�Oc;���O�\`[�%ܟ[RR"��:\0������BȥB���ܚ����/U^B�UA	����� �v�y^���@.����%W������)���t5ZY��;]OOO\vl���\x1B��EKx~n__����\0B.��\v!�
!�G�\r~kllLd����˰d�4��\vK���sB�{�lvn^~AaIYyum]SKk��{px�4>>	��9h�!�	KK˟645�����?�yix�h��y�:;\f���Ȅ�Id�HM]]]$5�!��^��o+vr;� �%�5�0�=\bp�]\\R�����;<�6|���m�j~aA�C\r\r\rr�ol����X���Ɂ����[�t���"��:\0������BȥBȕDv� 5�RӈqT¼$\v��z\b�%�J�3����,f�MMd�NHM���gg�\x1B���ꎎN�wB �\0z[����b��������;]WTT���7HӍ��VS	\x1B��W+E*��S�Wx�"%�\\����=�m��#����Nx��W�/ݵk��;!�3!�z#
 ��.ԙ���K�7nx\\�F �,-/�-,��͞\b	e�S��fA\`*((.-���mji������L�c�p�����ڼ]x\`\v�\x1B#�F;����^�:���ȨZ�LNXg����E�h:�Hy�I�*����z���]�S���r5����\r��S�V��<��E�%,౷��,o�����۲�zzv��j�R�~6���:33���_�f���}�j�I��\vP&I˥�]����B�:vB�
����?7/X^^�K[<C��\r�|�E�<���8;7\x07)����=y�tfvNN~>d���ꆦ�ή����d��%h�!	�|��dKbu�\r��F9-h�������/0b4���Y&&&�V\b���s�I^KK�M/?�<�\b{>\rQC�|��\\���X$ƾ~v�r<[��y��\v���,�m����������Zo��j(���>�\\wO�\`������؁^f쌌\f�\\�T�\0e>j�ϐ\v����Ç>��N@�U�rݒ@�IJ$,ݼ	W�\x1B\0p-[ZZ�e���ӖI�������Ź�y�'�R��8!\0�Y�9y�����U��M��Ξ�����q��$h\x07Z�6i�-.������GD^uZ�MMݽ���!/\r��Ҹ�>�m�m�\x1B�@[����[����Q��O�Ԕ����ً\`9��EwS�HW
������:Iv8��EE,o��m������\r,�zo������*�kc�N�V����v�&�H�j�K��\v��(!a)rձrU �\\��F�$"ai.��~���8???;;����Pg�ޖ(�������YH&x̓G�gАГi�Y9����������:���\x07���	�k�L3��9;� DA򩪩	�|�i�74zz{�C�B*�/{d�LLMNMO�S�,m������]�$�\`�/��!�v��0>�!5��jJ��,WW��H��y���/\`y{��m{\x1B\\��vbr�*�-�� w\`\`@c�?]77������\b�\\ir7o��e���\r��*\vrU�rU �\\�r���a���IX"yizz�k��
Cm�v�̴755m���"
�Ç����ДԴtHLy�E%���5��-]������r�5h��|������ʋ�N���^o����g��u�>6f6[&!��j���̚��>\b���<y+���@�">I��|��<p5�p�di��V+�j��+**%��<og��2Y\`�V��\r.ey;.1I��8WK�~�Fck��\b�\\�r�y�y�ui~�7�rW[��*rմrU �\\a9�Kd�\x1B�\v����\0���&&&�f��ؘN�\vg����\f?�EA���M��F�	b����Y\x07����	I��2���\v��**j\x1BZu�]��}䁉��m��m��G0��K��.\\rZU5��:�}wwwo4e�LF���il���4��'��,��h����ɩ)�$J�5;o�O���f'�R�g�\0W�ocï�c�ruII�\${����,���ش�co�KYގ�OP�����Cn�����46B.W*�\\�A���4KW[����\b�U�N@�U�rċLܼD:�jE:�h��@*�'%��h�����PSSSCu�\r�R�)�%p��304��� �c�=t�\bd\x1B�L��ٹy���u���2?\vځ֠MҲ�q�Fc~Q��s�VyU����ա�w�{\x07�(�[���>r�Me����L����q8��4E:P A��4g�N\vf'�&�]M�~/56��������SR�Y�~��7<�6���vTL������rq�Fck��\b�\\�r��͛v���y�y�ۼ�Hی���,�U�N@�U�rY����\b�9\\d�M��HX�]\x004�B\`�����k0����0TYU�?8�M��/��A��\`\bڷ�u@�������OLNI���+((-/���={����{;���Q*'/���O�4Ҫӵ�ڡ���N[j꾕�z�����Z��!\0��\f��	T�H���f�����&=N�HM޸�/��(ٞ�\v����9��v���Y�޸�U��\r.ey�JT���h��r�r�Fck��\b�\\�\x1Br�h��by@�8�U�N@�U�r���#@�+�=4/�\v�d�I	�?�$�����:;;������JKKCBBN8SIi���ۛ���i0tt�u���[��e^A����+W��#SRJjfvNAQQYeeM]}cs\v�Z��a��7�-�*x�U��SN������Zhnmmikk����no��So��v�/?��������\`w_T�=��.�[�i�2qkh܌}P�<������I��䥫��vuttc�\\���.�!�y�Zl<�ۿ����\r.ey;�r�ڼ���rt�Fck��\b�\\�\x1Brk8�l={V,w�%B���\\���\\\b!�Q��DƼ����y�HѼ422a�.�p���I����
ɡ��RDcc]]]nn��

�t��T[{\x07D��6]SKkCS���aнA�.EDDD^����������g\x1B�V^U�	�\v-@;���q���V]{rjڱ!N+�������������೷�ٚ"��F���r�_{������k�����f�N����[}^'iS������b8��x]��I�)��y��!과�n��{\x1B\\����K��v��3�U����Ac#�r�zȥ�%y��X�V�p��|\x07-p\x1B�Ң[�d��\\�wB.B.B.O�ao$2�ň,W277g�Z-\v�K���6�\0I	b���jkk������***��Ӄo�����΁��MAJ���RSWWY]��{�Y\x07��\\X؅K� 2E�\\KHJN�ȴ/�YRVQ	�H�'�/��KH<|�ӂ�UUSK�����'񩑾�6����q��e�[���l�'����ه\vv��ٲӭE\`����z�9!c�<\vN�&I\\]__����!�.//g�:66N���vxD$�ۿ���<�6����_P����@��N�hl\r\x1B!�+�CnJB9}Ńg�R�����w��ĂV@91o\x07�N�㼢\x1Bs5\x07!W�B����4;;;55e6��j588\byI��wtt����.\0�\x004)�������en�mݩ��\f\b�Tum]Um-����j�=�v��:�������΅]�q%**6.!9�6�-������\v-@;��I\x1B'\x1B���N+3+�����@ʞ������o�s���h\v~����f{\x07J\x1B���i0�iv���\x1B��LNM��p\x07'�R�T����W����������,WGEEKr x޾p)�����coC��m[WM=�tW�\v�J<]��5hl�\\�T�P�y7�>+��ڒx����'FЦO!��;!!�%�\\�x�s޼y�F&�<�E�h4B���K%\\3sss#""BBBv�ܹ㶶�ֶm۶nݺe˖?���0Lʺ�.�>u�������7���O�y��M�6m����;v���.����	ڷ������i�������{��ۻ7\bj��>ܳjϞ���7ުCGn�\`���g�_9���a#.Gfde����G�55����t�줷u��z؟_i�����d� �d ���+�����w����jЛo�I��r����:\\oo��&����?���P,o�۷_%�v��g�~B\\\r�\b��\fr=0���k4�֌��˕ ���[ϊ��sQ�%�f�7p	�X��{�y����&-��s' �"䲄�K����.�FFF���\rCaa�\x07^y���֮g�}��'��O�^|�w��v����o���?eП��O=���Ϯ}��~��߽��W_}\r�ӛoB�����_��ۢJ��u<$4)%�6��6̯�������ե�����6�L��D��gj�����ӧO�t5��,W��7�H�é��{�y������tul\\Biy���v\vr�2�ѣG�t������r�ւ�\0��tt�%���Mq��r�p���ô��Ev���;!!�%�\\"��7�8'��555E#SNNή]�\\R��!�ej�=����틍�����񫩫���knnikk�utw����4uk�׼��ާ&�����	�jC.z{���G\\�����"�]RR�gϞ\0<]��5el�\\��\0�5�^Q�\v%qW[�w@gN�P�s��\v/}�%��s' �"䲄�KD��ܮ�����y��j6��FcGG�޽{Ń��!�ԁ���\f2'���������MgN��\`t̶��Դ�7�˟�+�ꐐ�\\�z��"HJN�݅\\i��z���\x1B�Oc#�r��岧p��#��&�
��g�y^�6�|���뷝�����B.�ӹ]p=�X,py*,,\\�n��,����QQUe�#���V{p���2M�c��I�������Ң��I W�Օ��o�����F��H�>s���̟�v\vr���ꫯ���-c�\v���k�C����咗D�� o9b�����
?��{�\r䝀��!�~�ЍKF���]&�	.R�\0B��
��\x1B��@8COO���\běۣ�����x���N]]\\\\��}\x1B�\\MՁ�\`.����"!W��Ўg�F��N���\b�\\i\x07r�,�r�%ڻ�\b�|ǝ�*�I=�m�5��a' �"�
\b!��ې���Z�pUJNN�\fr�V�\b���7445��t�z}�}��n�$�+��r5Uv(���݂\\E���ز�?���˕v �;�Ux=(�5��!~�w�pq��r��rr������HMM��r5R�?�rSK���6
����8n��;pk���u;�IMT�����_�~=B.�;8P�\x07W��\\c���)�t�����%e?]#�r������N�ӑU�<'׭������g' �"䲄����]^^&�����D&�\\m֥������Z�0�������v�\0��57/v\b�����j�\b/	!W�u"4����������\rB�v�~[R��5B�Z!��]��V�X�(-���\x07���N@�E�e	!�\v�d�ι������_]L4�y����wp\`��E^�--@�.�O�L�\f�;��	���75�87=?;57=1c��=~�u@��<�������]PP\\^VYW�������?<0<6
��h\r��r��Tã��榨k��	�2���(8N�}�ׄe�J���=���8� ��~x���b\\r���\f"�����f�z�8,ɞ�y;;/��mH��m��l�W'$�<$��W��}�jw!WZc��t������-�t���"��!W��+�Y�)	�-x�@�t03��ʓ �;!!�%�\\Ǳ�p������1�S
@�Uedf��N\x07��+�m��M��;��d�Ή��/�3���S����⺺��Х�υ]\`�-B�Z���ڥ�w��AIY�O]-r�ｱr�W�%�\`l�\\�4�5"�+�ڒ��\v��G�D�
�v��r��rrY�8�r�U���z{{���֭[�Z[�A\0!W�5<j<rR88���W���76�OȺ�CC���85��j���PTZ���\b��,�u���HaW�:}֧�v	�N�\r?���/{ol�\\U���a�ƾ!��!Wݐ+��Xn/'��ǐ\vpG��	^���������N@�E�e	!��P���|HH�0�:�������$̹{��UV���746��?8h4��S�V��\\���ꬬ,a����j�\\WԵXa(-/���EB.��			
:]���ػ�����F��Jk�[#��X��S�=���^�-�<��Sj�\vr}�rrYB��Mȅ+�@���Ȥ\0ȭǼ�y��ܤ�[C�t�.���,�i1���%	��y�;wp���m��@x�e߹�-ȥ�~�7�-fȍ� ��i	������u�F�U=�
<+V����|���\r��Y�rA��v�ǐ�}�0B�Z��K!�������~<'B�jx�(0����t�N�<�ɩ)�d
�@.qu{{���S��Ż!W�e�N
,E�7h��\\��1vvn^�����2[�t��\\�k�\\�C.�Y�.W[r�w���nr}�<�\\�F�U�r�r��烃�Y��\\��D�Y��unr�����L�q[����3��4=56��6��v����MFx/�\0�@kЦ�[%_�38ef�
\f�#O\`lnk���"O�pk1o ���p��+W'�q���,W�\fKs4��vV���*�?]]��$��UPT�#W��\\��ϟ?�2vp�A�����5[>c�WW�bl�\\�4\b�5��J�\0�c�H�s�jq�@��v�ǐ{),!W�����Nq�Fם�����ׯe����!�5c����,�Y����}Nk�<f�	�E�
K�V�u�d1aC��S	��)�Y�yEe������n������{�h�Vd�n��,?F)�ށ��,�d
��	y�ℽk@��iii��������\vu�\x07|�ruVN�[�������!I%����,oo۱S���/ \bt�^���!ץ�w���2vaII\0����k��T���r5\b�N�KU��X|��3Jّ+�\f���	�Me�[�r? �U�\\��GQ�5L�B�}}}�ȴe�V�?n��<3k��4��:-�	�!gbzj|�2j;|�\v�ʹ�²Ҋښ���v}W�@�%x�m����LJ,��\f�XQJ��$0��jTtm}����;gf�%HMc��&&������(\`�?�_WC�Z�n��C�#\x1B��꾡A��)�ۮY@�ޖ���%,W�9���\\M!W��ײ5>9��k4���NHNe;��e���r��	��ϊ�v#�V[�;��nm3w�?!�;�]zk󦝞�\x07�\\�Jݐ�[2ڍt\x07\0�r#y�buu��\fE��N�N{P�3�1����� �L�X���)�u���2>l2>�r�3�!S���UW�77�uu��z�G����c�����V�R���i���'?\f����$]�;{z�\x07\x07!5�'&�HM�+v�RSbb��А�h4�L�ejjjvv��yAv"M^�~�&�a�����������>i��N��fy�M;\v���r�����r��#�|�jP�[�niia���sz�Fc�jl�u�76B.Wڄ��g�R�@�,�����\\��r}�Hے���r? �Uj�\\�lK���͛�mA��H�\0\\���Ҟf(5#�b�t��le��1��뻜V��\0Dojl����ȸi�8|��Q6䞼��r�J��j�[:ڻzlT��h\r��r�d+���	��l��?N��<>	�@M]���Rܑ��=KM��588H��4h�X�\v,\r\0�%����\`��jT�ۮ���j}o�$G�����,���nߡfo���PK�H�jj쾾>������k4v�[��5B�Sir���w�DH1Õ�5�����t�@��1�2�Rt�����v�"�X�\\�R��\`��]�mI^����@נ�����ml5��U�q����f��i�{��F�*�qptd�8\f�bO�#�z�DH\\rr"�|vvnQQqEye]mCkK[ggWo7�Z�v�5h�ۭ�{�&R��1{��?�8	�V|�";�JM�45�g/Bj�s35%r���000044422b����ħ�����\v�kx����������Tw]�56��:}�4��No'��3Y\`�vUz[FW\v<!K*W����+���t�Fc�ml?��r�Yȭጪ��)�ڒ0�q���r�}�����tk��#�N�q�}�[[sg�2B���&�u��\\�]\\\\�����\\h ,��E\x07�*�\r�={v\rC�5�#�n��-����77;��n}���7�7d���>C_oW���Ǉ\\A�m�W�}�Ί���Ɔf][��\v�\v-@;�A/�J��"�}�8<����9�V����e'�S��_���n�Ro�����'s�F���$(�mY,��]����\\�����w��f���]'��y;1%�\v����Z๢޻ک�{zzd5�?N�hlٍ���5B�Kir����I�#���P��@%����9����zZ��	<vv� �\\�%�Y�\\�J5��]-��-��5??OzH�-�%�Op݁a	b���������*.�\`�F�*}_��z{t]���5N�<�����1�\x1B�:}gKG���\b@nlbRBJjrFFFNN~q��_�����6�\v-@;К��$O��Jo�^Co�@_�P?�Q���h6A|"�4;qG�Zjr�����k׮��z��@�\0<<444l�0�����:--����8w]�56��¥:�\\o_KHdy\x1BX@�ޖ��>�\\����hl�����j=]#䊑�!����1����\`����5������
K�A��N\x07$�f�rP;�~Rn��c�]���+�,\`�\\�K��{oI�-�-� y	D���n\bK���mmmMMM�^�PnAaK�έjno����������iU��BV��Z\x1BZl\r\0���:�����O�G��r�yyyEE����5Օu��^h�i�z{�_���Z�u��ho��l��l�w��\x07�����q+>����Zl����8o�\bSS]CS�g�����\vocbb�����vuvv.����\v���鈫���X��|媻�������J��,�ۑQ�,oo޺M}ޖ�Ղ�빫o�Pc��%���v�Fc��t��+RZ�ܚ;�GY���q��r)�a�.n�Sn%���a�w)�>b�h�7B��ȥ��}������<��e6�	�\f\f���B^��i����������������þ}�b(5#������������/�����sZE�e�U�������Ҫ��|�:�\x07���������Dƿe�����WT�{�Ҕ��$C�۪�����������	⟭��]��ٮ�\r���l��8��\x07Mz�'yy\v���\v( ::��ի�/_n�\vr>���.�"X�XSC\\\r?�ruإKkl��s���:�\\o_�����-o�����G�Ko�8���d1��N�hlU��rEJ��eR��-��;\x004�2J�\\�>�\x07�6�[�����^C�/vm������[���z)r�Ձ\fQ&���\x07\\Dfgg���\b�\r\r������\0[\bK���\0�UUU�JK���


rrrv��� Cq���eenU!��R�$��iN\vKai��UPR�WT�[T����X\x07��Ç#cb�^�����!3%9)==-++3/7+?�\v-@;�l�?����TqyYqE9d��J[�+��?�Q�lEumm���}4;\r�G��&��\b<N>JM\r��@qqq����\\�q��Ep/D�*�*�?C�/+++)))�$lw�'�|�r�鳟��j��Y�N�ʒ��Ro�9����-[T�m�]�;�%��Ʈ�K.c��t��V��!W�T��S�w\0�<�#�v�����
0v�^����#P�O���*(�\\*EC.�p�eҁ;11a2�\b�vuu�t:\`ۺ�:HM� )����AR���JOOOMMMLLܹs��������s�rs�2ssS3��b�VbjjFN�����\r�'%3s�[o3� \x07�_�q�*��(���񱉉	))Iii���^hڑd{�\\� ���\r�� ��(�ؖ� G�VU�T}m]sSc[kkg�=;u�\f���}fo��/R���7�\x1B\0�HNҁ\x1Bپ������ܜ�ەgW�]�p4�҈��?�r��P�]�16�ձII\\���gY�~c��y[^W�\br�\x1BGcÙYNc��t��V��!W�r��|]\b�Tʅ\\�(eB�KKKsssV��l6\x1B����~�^x���XSSSQQ�t@R�M����D�̑�r�7o�)C�#X��]V\\bҥ+W�����+.9*61i�����@pXD���H��W�.�G�w�$$^KL���F$��TBj*�Ĵ4��������\f� P��������Ҫ*�D6��-�gp�@��\x1B6�X8^p�15-߸^W_ \0μr�
��ŋϟ?�̙���\\\b���22��iv����"cA	DW\x07\x07\x07�\\}���]\r�rudt��G�z�ȉP��_y�\r�x;@\\�#ȥ�n�\r<\x1B\b��������5B�x!�ba��r�
�,���K	\\Sz{{;;;���kkk��ˋ�� >ۦ����6222""�ҥK�^y�\x07:s�|L|�[\x1Bg���Ȩ�s/9-[p�������B�ٴe+�8p><�V�l���UHM�11dD� ���R�q��b���� DA�J�Ά��\x07>(+�e����榖v]�Ao��%c�l�ɡ�@���������:d��s�N�>}�ĉ#G�@�'��=db#�I�!<<��zϞ=,Wt �]Ws��r5�K�#K�}�0��\x1B_}]�ޖ�վ�\\ޭ\x1B��ɍG�����5[5�k�\\�������BȥR.�ҵ��<\\J�CCC===��퍍�UUU��ŀ����߿nݺ����yꩧ֬Y��O<���=�أ�>��#���7�Y�z�����w\f�[���6{V���i�^qZ����\x1B��HX/�����&��Cs�u�!2�z�7�\`�^{�p\v���!Wm���4x%���k� J��T|J
��F�SqEyy��1�q��^[p�w�9N�(8iS���7\b��R��ON�:u���C�8p��󌌌|�w6l�\0N�~&������X�^��)�]\r�r��[>8��߰���g�{^��޲����r�������N�\rl�5�s�='���y�Fc+�t���r��|]\b�TJ�\\G���Z��p���u:]}}}EEEtt�ƍ\x1B���iJcz���l۱���O"!Q���}�[vJ���)((,-)���i�ojk�'�����	S%\\�nUU�	 p���cǎ<xp����v���������(\v\\\r@�WK\v��[7d���ϝ;\x07\`{�}�ɽ�Q�\x1B�Wq�k�\\������BȥR�r\x07*���%czz�l6å�n\\\\ܯ�k�/�(���\v/��>sk�{vJH�=�#+?�������D&|�&�l��)�ާ&@\0�@e����byE�IA\`���?�����/ɽSQ2��W��A��ZZ����Mu5!\\Gc˽SQ���FȕW\b�XX�.�\\*%B.�ƥSq�111122������^TT���O�}�F�ֿ�ᓋ!;]�����������\v���������]��c������; �¿\0K˟.,-��ϕ����Ǐ\x07x��\x07oQ\\=����\x1B8�p����5vEEexx85��={��r�HT\`�^\f��5B�7B����u!�R)r�3�n޼I���d2���wvv�?��_��ܗhT ���9t�إ�}��32 8������57�v�w�v�\f��c�n�H�܁�@�֙����3gΜ8q�w�AW��j������}�p�T��3viYYXX1�֭[��(��r�B.��\v!�JY����]\\\\���&Sq�z����"z��wmϸ��R23�\v
���*�j\x1B�(8��eL|��.��_\\����������n۶\r;pQ�Z���]�=���'c��~��'\`�u�֡�Q�zs��@;]#�z)�\\,,_B.�!�׍k4{zz���/��\fQ΍���OII���-**��$��z������ryݸS�9���=���{\v�\f=��\vҺZ*������ԩShl�HInl�\\y%\0�;���TP\b�T
�\\r! �*s�q\x07\x07\x07������$\x1B��\x07��$&&���Qp��ͺ۽��z�X�ӛ���.�\x1Bw�b	��,�~B)IϽ𢄮�r������\v~���˽�PJҫ�� �k�\\�%\0�O=���t����:~��lժUr��*eA.�\x1Bw~~�t�FEE�}F)O��\v�z��kd\\nQaIeEMC��w�L�\x1B���)b\b���\v��ޮ��ҍ�e0<��r�$����;�I�jI �v�Rc_���r�'������@8]#�z���2����(; \`a)�~��֟@���\0�J��\vW\x07����l��t��/�*��3k?��PzvvaY�*\v.�~��b�p����\r�\`��OHLK#��5��^}�@���0�'�E�����3�N��Z��I�?����OI�.(�-*�+.�/))(-���p\`IU'N��ӗW�\\�BN����B.�ثW?"惠��P�\x1B!W^��8Я���쀀����$�9��R�r�*[�ֱ����׻�>��a#\\O'f�X)8�p�]c��\x1Bh�@ꭩ^Uu�Mm����ށ��[��Zm���;�%��C:'������;���'�<u56�{��dhh�8b6�N��MY\`�-3S�Y[�~ �$�vC׻����?�ZW{��A�\`설��n^|�w�hl�TmS�7��4��O���k�\\It�]w	賧�e�,,�Vi������*++���W)r��*å��U����,±N�Ζ�"�%K��_�c\x07�ށk��I��u;+ʫ����qj��O wi��!�#F㻻?�܏>>���\x1B�,��*,+s����y�jo ��4�U&��ܣ�'���,�R�46��d<]#�J%��8~�찀���JM�x��g����.����-eA.w]剉���~Z�pk�e�vc�X\`\0����\v/F\\�������SXZRYW�����c���.��;�%ݸt���� \\�\r:�qkW\x07��fk�d�y��z�j�!��4����}���9hl-������ëe<]#�J%��D�{i��K��S�"*'���G�.���6V�sB.����Ѐ��%&8	s�'/�!piYY���_,�9�78:"f��$�K�-����\0��&gd \vh��s��������
r��M�c��N�:�ܡCck��\r]§�#'B�:]#�J(1�H������_��a1M+W������O��R�~��gpi ڷo����Q�X���ųm��+1�b�Ȣ�t�����<��?�K�-V���u��o�����5a�{#��^|�KWK���E%��nv���F�Ś��0��7l��t��+� lC���Q(�$
\r\r���^)\br�Sp�����������7l��J�P%����&O\`���SPPRYQ����ٮ���/f�3ȅ���gg�/_aA.�7&>!��Gb��o��o�t����]N\r����\v,ȅW��r�H	,�v���u�FȕViii�F~JC�ړ��
�}}}G�R��p����h�Ǥ������r��;��&�</� �:3C�*;�\0�|\x07��� \vh��\r]�>ꍫ%�\\06��r��[:uhl,��>}�,�k/!�l6#��$r�2
��Fw�u�\x07*)\vr����\0�~f���h�\0,�9���G�œ�/��qV�4�M�;}	�K˶y�s\v\vc�qJ��8@�q� ׊,��x���������C.]3|\`x���}����B����X	��ٻ��,�k�!���>�8�~���B�X+W�lkk��]6)ry�����裏X���Ǉd�@c\`	��|g��$5e����V��6�ںz8�I���&\0[.����5��� ��~KY�\v�=C���ad�Vt\\��ol�⍫=�\\ރ�x��A�����)䢱5^\v)xil!wjjjvv!��m۶��(�:�j�*8���'.�\x07���Ao��6k�q�),��\`yRST\\\\Bjjf�=5���4 �KV�զ����;e��$��vJ\`��ի���Bnv^>\vr���Ecc��\`��o��ӵ7�;22b���A.������sq*JZm۶M�����܇���[���	�X�&
�99$55����4<6�S�%E 79-���	�r����X\`|�h3M��, ���O�\\M!�3W{	�ܧ?s�̓���8B.\x1Bk�d����\\��B wqqZ�0Å\\�C���\\���By/ ���2���BJ�\\�L �b�["!���$\0!��r;{\r������.���,�����v46���-\v䎍��Z�V@9�\\�����\\�f�ܔ�ׯ~�k�7�W��g?�{�֪U��mۦ���<!�bi���:C'��a��odX\`X\`bX\`�:�,��b�Z��������F� wbbbzz nii����f � �
����,\`��o���͛��
��
����,�7�\r��d�B���H������@.�Y�����1+�Z+a�����\\�Cr��/����}H���<�\\�� �\\E����.�7�'����ro\b�[!�bi�\x07�,����bq|���K5�{ǪShl͗j ��:��U����2��\r�Í�5T �\\,��� ���S.\v��y���y��Sʂܯ}��,c���hl,��G������Zu
!7�E�\x07�~�z�7\x07�s�#��5�.�\\,��� ��߭g�@~I1��72H�t��<�-A��6�6�;#'��UFcc��ؾ����Y����ӰE��*�S
y@8�Q��뮻�j�����R�>���fAnyu��X�sH'��KA���3kY��W\\t�Ã�ؚ/A����������A���\b��y@��roʇJKK�p𶆢�����R���*� �Q�J�����y��,A.o�2��u�]��hl,_\x1B[r����� ���������r!G��y����𶆢�����R��qy����r\\~Y@S��u������\r���\x07cK��}�r����ݸ��*#���&d _��\v�q�_�m\ru\b!W��iˑ��$is㫯�?\f�/{��N)r_ްQ�����E'�]�t���T����7m���2vfnnW_\x1B�Ɩrf�rss�l\\�n\\��r�<�5k�Ƚi(�h۶mN�8��P�r15i���\r�j���Z{�1iY@k��\x1B��|���8�Hb��:�@/\x1B�Ɩr��������NUf��E�\rd��\x07�+�֡��ʕ+�ʄ���I#��{5:�)��txQ�=�Vo�Ze��\v�o۶���\`촬��^\x1B�?Ɩ
r�ggk��\b7--�.wQe��U�Xȳ�i�Q���+���
B.�&�T�Cn�����\v�\0@nKg{��Э��X�<��BW��r�G�����]Q[c#\\46�_�-	�GM�M�%�fff�c�n��q�#a���{QK��V�m\r�
!S�F*0!wna~\`p����ʕ+�,�W\\L@\`�;@W��r���ں��ac�>w^�ߋ��򛱽���hccS�+����%Sq�p'a䱝a"#��F�dbͿ���
B��S�s�|Trz��AB;%\0������+W�bcSS3rs��˪����[o���\x1B1��F�c&��؄�W/����ڵ띴�윂¢�Ҳʪ������6]{g�������>66�ڵk����,z擮�\b��s���j��噇z�\x1BW=~�elW�\r��ꬬ���80�KȍMJ�7����fl�N�\`�������D�\\B��h�.o�2Bn �%� <˽�(ɴ~�z�Gok(Q\b��OMX��\0�n��+�.^�\x07���Դ̼�����ښ���f��]���m0��v������\f��?z�G���8p�ȑ'N�9s&,,,<<b?�@\0\0��\x1B��tk���EϞ���VS�<�������A����-�j�3�:>>^$�f�䢱��il�N�\`lp�H����d.!\\:�q�"1ȳ�i�Esss������I#�h����v�������j5��!���gc�r�����K�p�p�"��ڶm��\x1B��@�����B.�&���!7���81.	\b��UV��\\46����Sȭ��Y\\\\��r��u$\\�J<�\0\v˽�(o�j�*�Gok(N\b���4R���ܢ"�HN��<^�\0�Ze�h�Ecc��ؾ����N�'t�2Yi
	Wq�<+p������&�p�m\r�	!���ɳ�L\`K�-��c�.xq\`tăͨn����}�n������X!���Ŵ@2��}�M���Tϖ9U4������\b����j߱� ������}���٣�����a��\\$\\�-�˽�(�$r��W���(!��?5	?�b��Ghؠ�m�V���6����.u��	1'\x07���15A �d�͇��h��/)�
��jr��X�?���Fc��ؒC�N�[XX���o�p*w�\x07\\,�V�<��ܜ��\x1Bok(K\b�������Ӄd%�� 9=C��3�!��n��g��������c#j�ܧ�z����%\\
���jr��X@*�o���hl4v�[*�MKK�_\bi�]x���y�< �b�7�BCC=8�x[CAB�\r���M8;v��m\0|�w��+��y��\`Kx��M�*��M���L�\x07�A������	�F&x���_�ݷo_pp�0�feeUVV���o߾�����R�\0�ZM��\v\b@���)䦧�WTT\f�Ʉ�Fc\x07��=;]S���ϯ��\x1B!\`K��o�p�(ϐ\x07�i*Ww�u�\x07Gok(H\b��� l�����q�p���(^��?�D\`&o�k�w��΁\b�m�����D��/����v�}��M�Q�q�I��Y������uMM:�J���Ã#��1��25i�NNN['g�y�C\x1B7nLNN��̄\\TZZZ[[\v)������g\`\`\`xxxllliiiqq,=99�c���X@

@W���,��_>䍫CO�b[����F�]\`l�~hl4v@۳�516Y0��iK��\b�V��\fyV�<Me���	���5$�܀MM42��\f��?30:B[��$&�ps���s����J���aut��.\f��ė\0侾is��S +7~������M��302d7A^�������Y��]��[Z��Z��n�Z\\\\\\YY������aihhh||�j�����~z[�_xq�Ν�jt�����C=썫ϝc[��du��v��\v\v\vhl4v@۳�5y*$�r��V��y@@�ro>�my0��*44T��G�Bn��&��z1m҄���pG��l�\x1B�7���_-�|\v�3d���|n��!��7�,--���jll������5��efffqq��\0|,0==�@WK��	9 W����d�"��Ec���؞��	�~��g�N[�[��\x1B�#��	Pnȳ��Tx[C)B�\r��$~�n(rz۟N�rk�:*��[�ˊ��HV�����={���!7&>ޖ�����jZ:t��ށ��Q��jKM3\v�"�����z��m۶Aj���ijj������\x1B���\0/--\0�� J�����3�޸�\\���\\Mט���46;�����\fT��m�H(o5<<��4�x��,]���,��\`�{�w�ʕ��"��\x1BȩI��&�v:N���sw�ty�6(�)��\f�25�c"Kȅ� ����fHM�����&''���\b�/��jt�g��� W�Մ>��3�x�Fc\x07��=;]��I7.!\\�3Jb�g͚5���DV����a��T���\0�5��:�\0Jppy}�x[CB�\r��$~\\�ĝS�S]0ӃeN�\v�	R\r)�1���25I�/��ݾ}{yyymmmkk�^�\x1B\x1B���"3��&��v ]-��'�\\W�!�p����x�Fc\x07��=;]�ٸ��[��"|A{�!�s��W���<M�(--�5\`Uzw�u������q�	ok�r65��xA��D��yp��v+��y���O��3n%F�%\v�VTT�����D�1YXXX^^�B.�]�q�<�;�p5r�t��@c{v��B�܁\b%�\b�\\��G�.!�hxxx͚5+p��rD��o�1�pS�%Ð�"x[#���\x1B���݄#���岪\x1B��۽�]�{��\x07{�˒r+++���u:]ww7Y�szzR]�Dk�����X���
���[� 䢱�bl�N�\`l��V�p��DB.���#��A����0)�O}bn�~~�ժUr�\v!�>5q��y)�C�����8�D'O�{�3���;v� ku�\x07R���q�N�\\tu\`��\0�
�!�����t���b��v��[�+�*p4g��o��#���|!�>5q��{)V��[�}P���sq{\x07���d�������掎���>��H���D�����Et�RX 8� ���&c�\x07r�؁il�N�d�)���)y\0�(E�u�Y��
|!�>5q?��	6�>�'x�v��\\�� �C�g����{�������������d2��:�2&\b��j�����r�؁l�����F�՚r�&��F�U�rU���]�>�B��)^_\0|.�f�yd��ܢ�2Vj:~�xCC�N�3\f�eLhjB�EW{_�\`�[7��&c�r�؁i��V�{���F�՚r�&��F�U�rU���W�Y\r��py��	1���r�.�����o���###�^�\\�]-y��R��Y�		p5a����h�kq	\x1B\x1B'�jM\b�Z�p#�*W\b��OM�oI��듈Ob�\\��9�
\v\v��(�෥�%������$g���֭[Y����p5Y�\x07!��8c'%%	\x1B\x1B�q�&�\\��u�r�+�\\-�&��c'$�\btb�[\x1B�>Ƚy��6n�H��B��c�r�Ւ��,���'p릺�Z��\b�hl�[�t���A!�jM�Í��\\!�j!5�ع�|k�s/����佐�� 7�Ũ�Օ�w�>���F�FGG'''�B��Q�\b��j/KZ����
���B�Ec\x07��N�|��Kc#�jM\b�Z�p#�*W\b�ZHM�{����[\v��q���w^��S���+�������N2��l6c��:�Y\`r�rR��W�^v59W���h�x$(>>ޥ��p�&�\\��u�r�+�\\-�����]��}���\f�"|A_�5�Mn��&	!�%������݃��tz�\x1B!]-I�<�.\v�$�W^yť�r�؁fl�Ic#�jM\b�Z�p#�*W\b�ZHMw�="��ЧN�V����D6զ��=����I*�-*-&\\PVVD&2�mbbbfffaaayy�ۍ�,����X�q�:�z�����v�j�hl4v����U*c˝�P�B���:�\b��B�FR��+č�c-nGl�����F�Wnhix\`՞={\fC��h�X,V�u~~|{��\r��.�\\t�$��Hh�ꌈ����@
b\\����c�9]�ڵK����A(\v!Wkbn�\\�
!W#�i��&���C?Y�l�7P�w���)\0�r��n�\\��n��gΝ�������[PX\\VQYS[�ؘ�_��G�k׮u�֭[���F"��E�Cq��up/w�\x1BB.�Z�by��?������E�TZZ*��\b�hlٍ���Z����A(\v!Wkbn�\\�
!W|j�R4#ɕ�xig�}�N�o�\`�pǪ����;x��:���]��m�W�}d��-��!������<�ӟ��g?�ك>��C�^����[�f�SO=���O?��k�r����������r҉�FW������Z*WGFF�t5����
2v\\\\�xc��&�\\��u�r�+�\\M���;\f�RN#)�z&.EWA�Ŷw�S:��������ao$29����FW+�>,��hl4�R�}��I���Қr�&��F�U�r���H�K�\b�w�������w*�E�\r��-�#���-5�rGFFL&��ĄpdB�EW+��p�r5\x1B��Vc��&�\\��u�r�+�\\͖�5��
-��xC�V���E��&�aR�O!799ytt�l6ONN������Ӊ]����BW��%)߱��ӧ�u5\x1B��ƾt�\x07�FiM\b�Z�p#�*W\b�X)A�k��V__?>>y��\b,,,�K����|W�\`�������y�j46�Z��Қr�&�\\�	!K#�\vȍ��$y	l	y��y�q��ao�j,IJr8~��ǮFcc���(�	!WkB�U�r�4RB��/�|�ĉ��n\bK333�;\0�� XD��CI�����jo\\���
Lc{y�FiP\b�ZB��������rׯ_�����l��&�aiii����.d,?��,��\x07$%%���y�j46V�\x1BN�\`lIN�(\r
!WkB�U�r�4R�{������+�7oޱc�{ｷo߾C�����={6,,,<<���J�Ӂ����IR"$,��n���,���by�\x1B����]���R��QZB�ք��>)r���05a�[��z�����_�r%!!!''\x07�_���]]]���ccctN:&%�h^�#��ƒ�X������W����jl�ք��5!�O
�\\�������~\x1BS�[%\0����o.^�������_UU������c4-\vD&�'��?�E��Ӱ$���X^�\0\v���hl,�\x1B�5!�jM\b��� wyyS�\x07%\0��<�ȥK��]����VPPPSS������FGG����oKKK$/�gLPy���X��3�����W����jl�ք��5!�O�����������yLMX�0�FDD���fdd���wtt\f\f\f���OOO/,,\\�~�;��1)y����Xޗ\0\v��j46�Z��Ҕr�&�\\�IY�\vW.�~�U\fS��%\0��>�hddd|||VVViiicc�^��X,����~��͛7�.Q�eRBWcy_, ����Xj56JSB�՚r�'�B�]�05a�U���c��eL��������d0���'&&���hj�Ȅ��
�by�����hl,�\x1B�)!�jM\b�꓂ �Y��nܸ�����;�\`j�r� ������JNN��˫��lii���!3���7\b�w����/���hl,�\x1B�)!�jM\b�ꓲ �O�����%LMX�\0�>��111������mmm}}}&��j�BD�5䢫��)�g�����j46�Z��Ҕr�&�\\�Iq�K�����bj�r� w͚5d���������v��	Y�R��%����d߁X�Y, ���t��}\r��hl�����5!�Oʂ\\�b�{ｇ�	˭J��fy��'�LHH ˘444tuu9.c�;ȥ��v�k\vO�<-��
��mjdy�_��_dq�[���˲�C�\0,�{�?����26JSB�՚r�'�@��w.fr��a�,�꣏�<�ꫯ������UTT477www���LNN���AD���S�����am�7�˾����X�yꩧ�r�xc������C�\0���ˁil�v���5!�Oʂ\\:�+77���O?�V�\v4V\0�C��o�g���C�����t::Ë,c��w3���\x1B\x1B[�֠�(�>�
�Hdfݺur��gl�^��Ȼ�G�}������,ϼ���2\x1B�!�jM\b��!��͛���8�#��x%0�\r����������F2��l6����a�o��7��M�F�\\,^	�[;vL.W;�+_�
\x1BKd�\x1B��}��9��Ҏr�&�\\�IY�K�����~��~�֖��a��i��*��-���w322
\v\v�B�===F��\f~��\f/��_|�E�v>����}7bT�8y�喿�˿��Վ�~��G��X"K\`|������kl�v���5!�O
����|��#GV����-��+@J\`�"����}nnnyyycccgg��� Y��<��\f~�C�qu\\\\����|s,ZKN�|�Ay]�3vXX�����SX��G�<�裲\x1B\x1B�!�jM\b��!�O�\\�\f������(��K�\x1B��Q\\\\\\[[���z{{y�~��u������x��^�&��s���\x07�u5��f�Y��x��"�>]�:uJvc�4"�\\�	!W}R�~�Y��ƍ\x1B�=�r.�@�$�_�򗅅�UUU���z��L���\v�g�\x1B�������qʹ�\v@��g�
��k_�Z ��g�M�6���\x1Bc���c�� �\\�	!W}R"��ށ�������=_�-8�\v������$#�L&������<���B�n�y����²2�>\\�[o�\b���a�\r\x1BK��.O�ǎ\vc��  ٠�:}�LG���roJzq1��GFFʽi(�Dȥ�p]��o�����\b4U��V��zꩧ***:::����F��������Ғ��w�\\-<ߜ\b> v�j��\r]\v�P���?\fW;[x�[��Dc�P(*�8���v�\0Y��b��� z���'N����	J�E�,b�oT_���sssId���/���,...//sG����K���\\=������C����jUVmS#ٰ���\r���_�rDDD��Kc��Z�E�-�t\r�NLL\f(c�P(*��P�厂���s�D���|�rcc#�Ldn���w�?�x�3�������(W;�����rWhl
�B��\b��sz\x07�(�\v.�}F)I|�Asssggg__�LV�����q�\\���j�{�rK�<�H\0�O�(/�v���46
�B�P�/8	?���ڻw�N����F��b�LOO;�L��\0�%R�>�h�����Xnl
�B�|!� @�����wvv���\r\r�L������2�\r"S ���:>>�w�����\x07�������(a���k�ol
�B�$�����	�T�W���388h4�f���������"�\b����꺺:�����&puppp໚e�o~�r�BT 
�}��)E\x1B�B�P(_�18Y,1�BiJO>�dss���������I2�miiiyy��t�����ׯ_����������L)�f��7m�$��D�~��_)��(
�B�B��D�q�F~~���>*��%�z���쑑��d6�I^���#=������\`0�\r�\x07���U����(a)��(
�B�B��D�\bHvڴi����}�/�(���nPPP]]�����b��d�Zgff�y	LBfufdb����Ç���?��?lذ!??_���\\�t��֦��}�F�P(�wbe���e�t�����{�����?���T����W\b_�җ�~����O~�\x07x��?��7���렿���{���~�C�o���|��������������.��|�y׮]��]���������� )MOO���BXZXXXZZ��%�#ȑɥ�:�W����/�����8�.����ַX��oO��.0�=���2����/��W�^M\\��ԤW�1��Nנ����6�<c��?�#��w�}7\x1B�B�P(��Ϸ��Np}$�!>�E.����p\r��k�fե^x��$����>c�	���d2\r\r\r����uг����URR?\x1B\x1B{�ĉS�N�9s�ܹsaaa/^�t�R�]���\0����t��-��j�~jz4���!�M�z0\0Dh���#������ �~�Gx�rjlW��Āc������>�2vbb"���\x07�;�z֙�\r�c���\v;%%��B�P(��䘝��	.���Z��S5j||��{�Ǹ�"�Bd\f\b3o �<����UVVVUUUYYy��I�KgϞ��o����|��� YAd"K����A�d:�^��ȑ%G�&%^X�yI)�	]\r�������o9;??���^z����ܺ?�������҂�Fc�A��ַ]��3c�������?��\x1BN�����Bc�P(
�Dq��O���菷uSu:v�w�Soo/y��]$+B��H355D�s��:}�4nmmmRR�s��]�p!<<<22��իW�쪨����]-�\f9���I���a�\x07��f���eWC���?��rj�'N�\\�gϞ��20mJJ
��rj삂t5�JLL$�޲e\v�u��f\x1B���F������G?���rx�|W��D�P(~|�	��O��]w��='C���#��4�g �X�֮���:�E� 5���\0�Bj:k�K�;\0�RtttLLL\\\\��� D&��\r���%�h���g�\\^RRM^Ҡ�!�s]�r�J�-��ްa��\`\`�tUUՙ3gN�<�2v__���\x07���?wt���8]'%%���s��(�\x07b�-Kx��j�k�a�G��W_������~��\\K@�pR���YEEE����W���Dp���Т�g\x07��UZZ�;�ҸH�����������42��l�R]]]WWw��5HM�ϟ�x�"�K$,�����4>>>11A#ӧ�~J�M2��	��Zn������\r\b�H��hl0-���ׯ///\x07HKK\v		a������DW��}���A���_gƆӻKc���\v���
��B�t������.�'@	��ˣ-�����w�$�eA�����z�!�?�����f�Ǔ0\x07H�\0\x1B�{��}�N��1�tㆆ���]d�\x1B�\0�Ȕ������၆Nc�O%�������\r���ş9\\�Ɔl�r��ݻIoW�]N����000��(��A_i۶m���3�اN�b;((H�������(��� �X��+h���Ӡ�Kr��u���F���=�_��W��:���� �8=���D�hd2�����\v/������Ĝ>}�ܹs�S��ի�p���ZZZ 2MMM���@�42�	��DI����;56ީ��n��r5�����!!!,c��Ԙ�ft5�Z�r���?�\r�<coܸ�e�+W���Q(���GD�!;ͷ�"kT3�m_\f�Dy/i!<�;�x��)�r�O	奂��X����H�\0D�\x1B7n,--�����v�L$5�y���:???44��|�t�Rdd$D&�^�L@����d�\x1BY�dqqqyy'��02�$��\rh۶m��0/5vGG\x07������eee\0,c'&&�F�ł�F�Z\`<GW�_��s;������26�\fA\v��B��#��!\v??���N\0JB��6�w6��Fs�u�b,4�\x1B9�[��\0�\b3� �,,,@�9t��_\0��\v1�,\`BG�ѹ]\0�]]]؍��nݬ\\�rvv�gl�'�ջw�����q�����ۅ�~�_�\\M �kl8\x1B\v\x1B�����nnnFc�PD��M��y��\f�űW�'�$��nk\0�*eU"����+�L���PJKK[�'��7��*�ᕚ����K�Cq��ň�\b��	���n\\�$p�f�}�9������\`悂�#G��������](����M���y��uil�x\x1B��(�(�7\rr��\b���܀�$��;���se���j�/�O����Qw��S\\A�!\vu���%%%�~�u��UUU]�p�L��|�����E��\v�p���%(�K��\rhժUdqb쁁�������L�+8z�(�ؤ�krr]��X3͉�	�Rcwvv
\x1B\b��B���U�����S�������[�\f,��+��}�]�ᐤM\0[��%��-R���?�T�fqqqzz��ɓ�~������dǑoQQQdzd���q�L�~��7ob�\0JZ��u���3j씔��7oޜ��'.������(_\b\f��W---d�216w>����^FF��������(oN��>+U˼�>\\�5p�\r�������q="�����mob�xϡ\`����>!��P'�_\0��%�L���f���I��/��Pbn֭݀[\x07��\x1B�e,W��ϟ?�����Et5��r����d�21�� |��l���с�F�>�\vw���#�qnO.�8�r�tx��}�#�y��w�l��5�G9�$�)@��Unmme�\v@�JJJ�|�>����x||��\v@��i�\0.\`��P"o݀����C�%����:�2vvv��d�v�V+��k�Z�ʥ�K\x07�;;&&��B��\x1BW�ex�����\0�g�\v�˽k�B�~���=���ָ��pF@�e�\0�W��\b<\0�aaa�~�]�v���rG���]t�r��b�n\\��%��\r9#-..���\\�q��3g���tr���](����L�����A��؛6mBc�P"�ͱ>��N�ĵkD@nss�����$o1���D���ݞ�1%�ϡ\`�ܹs��t�N�~����\v�|���&ݸ�9KKKð_\0%��ߺ}�[��Uvt��ݻ<���w�1vWu��y�+^\b/�W��j�0B!$$���D�1��x7A��E�@\b\vi�r/.\b�D@��\v�uh�B��R�(S(W�<�9�t�g��3�k��=�?k>�Oxj������������}�=��ݮj8A��6GN�R]\x1B�o\r�9��&����\`CT[���~����oaTF[rßZ��ڔo����X������7J�{����㭳�Ւ�裏���\vF�|����֯_��ܶm�}zdT�n����w�k�Ts�1g�yf���+Vl޼9.���֭[�SZj�~�ٳg�	�ڵk\x1B�tۭ�X��θ��UA�nT%���B�m�\vTL�~U��=�a�.sS u�9猴/>����#�<�ꫯ�{(�\v�;�}t|�k_\x1B)Շ~���?R����mܸ�n�c޼y��~��\x07F
v ؐ�k+=���r�ܴ4E^�l��Qr��a՚r��&���C1��w�}�}�#�<��?�q\\2͟?��+�H'��m���>��=t]\x07�n���>z�ݮ��^x�H�^�fM���	RMO}�U�k�$ө�N8A�!G�/��w����2Kn�\\��L�O�՝�h��<\x1B�h�Q��X���\x07|��ٳ�ɷ+��2�|{ꩧ�6n�/P�|�jb�:{t��ޭ�>�CN<����\r��?�iӦ�_=^!*��T�S����k�mܙ3g�r�)#�O��\`C��\x07��P�-l���rJn�ᆐ��I\b�R\x1B/�3���U��\x1B%���u ��\r���.��K.�7o^:��L�-ڰaCu7�}z��G7;�s�n�\x07p���\x1B�o�y��կ��ju��T�S���7;H��۸\x07x\`�\`���K�\r�q�3���\x1B�}�Ò���}�\\ٙ@ҷ�G��f����3Z˗/�\vTu .��m��~����]W\\qł\v�ɷ'�x",��׻�}�]��HǏn�Pi�TϜ9������\v�\r���Ǎ\x1B7����n�*��T\x07o�W���u�}�1�\b6dJO���Ĵ4�z��ڗ�tZu�B���}\v�������:�L�v������ϙ3��|��k���o��\r\x1B6l޼�6.�6�G7�n��V����O~�X��������f��qp�9�t����M\bv�l�1�K�t�=\x1BǴ7R�\rC�6\\}g��x�����q�c�{(��wߑ�I{�G�©�8蠃f̘���7o�e�]������<�Lu٢}z���ͧ?��R������ࡇZ�v��p��\x1B�K�nܸ1N�{i�q0�#�R���7ө��8���G}T��&h��r�@6ʰ%74���G+�Hg�G�o1��Qj�P|��_~�����w�}a!��.���@��{�q�ծ�������~�W���8�9�9$��Y=g�qƊ+��g��\x07w�}���R��tV����[׮]�iӦx��.z��;�����)e��\x1B�]\x1B�O��~�z���q.��$n�֒�nݺ4���
?���Eg�\0��9 �Q�M��a��Mɽ��{CK=����b�#�HZ\x07:蠰j:��S�̙3w������ɷ�zײe���]m����"}t�:�P�iC�\r?痿�����w�y�����ݮ���q�����/գ���
����ȩ6#
���gk?�Ҏ��\`WC��\r9��ɬVr\x07j\r�NN��v�\v?q�.��i���tЋ\x07q��я~4���۔����wK�,�Gtv�a���[��rHX2M�6-N��׻�ɷ{�'.��׻>��C��B|t��lSr��_�]���]e����p��{���;��3[�}�-��[�����~��w��ީ9�����X��6Ѿ��\x1B�n�!�4ط�~�\`ð�+Of�?��\r��6����"=�-g�x��#���.�s�ڔܻ�k޼y�=\x07x�.���%ӱ�;��\v/�P������\v�\va�Jn���?>R�O?��;�#M�����~6�OXH�̙3��|�GB鈻]�E���~��W�\r����*�a�U\r����W��i\b��'�l���&���m���=���yi�څ��O����z��Q�/_>쏷)�w�y������e��r�>��VMa�5gΜ�dJ'��ﾰd��t�%S|\x1B7�\v8���KwoSm���Y�.��Z�;찘�N8!�t��^�h�ڵk㣛7�|3����jz$�i�?��}�i��\`y䑟�����\`WC��\r�\\!4��TrC-����U�&������E��\x1BVA�.p��G�+_��o��o�_���?_]�_�/��k�N9�Z��9昸��
\\\v��?^�v\rzi�^��\x1BF;�p�'ւ�կ~u�]v���>6��\`C\x1B黖㰵���Fi-����H\rw�_~�C��/�"=��w�DѦ�|�ɵUS�\`%8�#j�oaɴdɒ���W�-n۶-,��\v0��t���mܘ�3f��t�~��kٰ֬aC��O�1�jzd���6�>��[�nB���k�a������6��o��	K���٩�}��XsvfB5��.��D���w�hSr���oնq8��X\x07~�ӟ�&�n��ƕ+W�%S�l1,�l��/m��׾���6�i�b��;�֑��<��VM�������������v\b?�h��6j�=�>��\x1Bhҵ�Ғ;���j�P�<o��-�4�ǝ@ڔ���>�6np�y��&�~��j�_�/@���{�g�nWt�)��F:��U�V�G7� ��
Q�f��	�{�1R�[��\x1Br����t@1�t5I�ޓ���:]��\r�s{W��\xA0�Ҿ�VK�#�<���=��Ck�o�_�ʕ+��A�m�x��{(��]\`�ݮiӦ����\`?���/��ҦM��~��j�%3���͌3j����k\x1Br�gO�t�4�E�����;����vlr����gPKf�=����}���\x07q�4��+���k�����L[�l��qk�oVM���.��v��{������;W�Z���/�	�����J5���t�&�����\x1Br�[<;�|���f��5�XJ�C�&��l�֣��A\v��N,mJ�A\x07Tm�={v5�v�W�t�Maɴ~���dںu��k_�>j�Zw��O<1t�*�am���O�Y�f�ƍ[�l�R��n���� ا�rJ-�˗/l�Q������!S�NmS��WG��d����9�jBI4��պw��)��6�̙3/��K.�d޼yq�3���S:��q�\v�/m����޺��{�i��瞕+W����x�8��s�k���C��\r�m�u��[u�a��.\\�~��7\x1Bb�%w�!TJ�d�i���zR1���L���^�R\r�U�w]q����o�i����)��q飥K�����]�~xz���W_�lٲիWoذa˖-գ\x1B�]���]��9�c�\`_{���\r�R�̝2eʨn�u�HN�V�?����$\rѕ���	$�yO�ON'���M,9%7��t�t��ϙ3��U~�G�W^��tV�-�ƥ�v�j۸?��O�+1�w�}���?_����[o���;v��;�����\`?����\r�U+���<��gV�D���\v��k���J�r\b��Q�����jϸ<��X�z���i�t��\x07ֶqg̘���7o�e�]v��7�%�ڵkk�t����w��nW5���O=�ԋ/�O�݄T�. �����l�2���q?.��k�zS�*�N&!\x1B�[%w�!TG��)~��GϹwb�K��%�����*_~���ӟ�:r*,���]�6n��J&����]���5s��t�������g�Hg��v�h��D&�{ƌi�kC��\rkݏ����(>M�Œ;��	"�C�F�(ǞO,;,����_m_��?���9s�Ν;��[o���瞋GNU7\x07�%�m\\��}���PK�����8��}�UW=���/��Bz2��.��}�?���ׂ]\r�\`_���\rcQ;!*.�G;z��!�֦�n�r\b�D088X��LC��w����~�K_J�LӦM��o���G}4,�֯_�y��N�����dԾ\vL�2���<��*���s���˫�y�|��փ����1I���>���f�C�z�!��1�]�[���M�ŋ�F�#��6P�Kn퐱��b�H�E����q'���	k�ٳg��j����.��=��j����n{�g�Sq����oǷq\`B�����'F�U���z�+V�]�6�v�K���T�_�\r}��'��:uj�v\x1B���z�Z��1	�4]/�C��\b�Z�!�jB!�/�qV9,��ϟ�׿�5=r�Z2�ƥ�b��,Y���;�8�����._��z�<^�b��&m��!|���Z�n]m��+̯6J/J�C�&���Qޡ�p��{�Yge����;/N��q�q����/����.[�9F�f͚G:�������g�]�f�ƍ\x1B�G7|�A<HM����¿馛\x1B�n���7g�\b�0����G��4D�J��޻�@5P��r'��P�U��̒{�G�ɷK/����{��V�^�LN�9⣛�.0cƌj��\x07�'���K�i�G7��☼F�tVy�ҥ�\r=��F��;eʔڂy���lt�	zWr�Z�r7M��N��wb��qC-�,�?��O�)��-
K��+W�[�n����.���苘��Ñ^��u�jV��\x1Bo|��G��̫G7v��;��&\v�V���a\vo,��HK���g=�3i�=��3sJn�U�o��%Ӱ�-Z2�G��?����H�%K�|������^z��W�������[����~h8��\x1Bm���ܹs\x1B&�j��9�\0��L���?�8��ܙ3g�ɷ��{\`\`�Z2��-�ƥ�!��~x�]\`ڴi^xa\b�\r7��裏.[��z�<^���\r\r1�\`Ϙ1#��[nl�@.\\8}��~�.\0&�і���G_|��_��c�-_�|ժU���J\\2m۶͒��U�Wb͝;w���O<�Ċ+֬YS���{����!F��|�;1���\x1B\0�<�%Sf�=��s�m���Ÿd�zM��3��I'�t���z뭏=�X��Z�~}uZ�\x07|�^��﯌IM�\0vhT%�\x1B��Fh�W_}��O>Y\`/[|�������d�p�Qu�\v.�\`޼y��\x07V�X�v�����E�&���i�Bý��K\x1B\0�l�q�<u�	'�.W˖-��PT�oa�d\x1B��ȟ�<ꨣ�Ν�p����fժU�ׯo}t�\v��������}��w\v6\x000�T%7�t�s�=��\x1BnX�|���?�f͚\r\x1B6To�Z2�(U��!�'�t�UW]��㏇"��/�>�	��ڮ�_�"ا�vZ\b����\`\0�M~���W�z��?��#/��Bh�/���k���ƭ�Lq\x1B��_��\v��׿~衇�{�X6lذe˖t�+�t��\v��+?�s��l\0\`r�%7���:�6%���_�h��ի�z�W^ټysz7�m\\��\0zɒ%m��!�r��ׯZ�*{���q8!^!R��E�d��c����[\x1B\0�����ٳg�)��?]�re���6mz���BÍ���ʖL4G|zӾ\v�|����_b\vx��Wcغu�;�����"�d�&'سf�z��\x1B\0�����SO=u�UӞ{�����n\x1BK�޾��\x1B������ƥ�b���߷�7�t��͛C��l����b��E3	6\0���;��GZ5}��_ߴiSX)���\b����ߎ��p㦀%�S�t�ґR���|f������7�ܺu�m��}�ݪ\bxtC�0؟���\x1B\0 ���9眑VM���/��[����^\\/i�4Y�.��~�mK�'�}�g̘!�\0\0C�WMmJ�����v���z[�إ��Xm���'��޿�
[�"@�	�i��&�\0\0Q���x��n���V�[\r�&���0R�gϞ����[�"@�	6\0@�6%������$������i��>����OU�N�\0r�)�K�.�W\v�%��}6ՂM�	6\0@��%����M\b�����oFG�\0r�)�aA���t�}���:$�\0\x009�\\ʣ\vP$�\0ȡ�R]�"	6\0@%���I�\0r(��G�H�\r\0�Cɥ<�\0El\0�J.��(�\`\0�Pr)�.@�\x1B\0 ��Kyt�$�\0\x009�\\ʣ\vP$�\0ȡ�R]�"	6\0@%���I�\0r(��G�H�\r\0�Cɥ<�\0El\0�J.��(�\`\0�Pr)�.@�\x1B\0 ��Kyt�$�\0\x009�\\ʣ\vP$�\0ȡ�R]�"	6\0@%���I�\0r(��G�H�\r\0�Cɥ<�\0El\0�J.��(�\`\0�Pr)�.@�\x1B\0 ��Kyt�$�\0\x009�\\ʣ\vP$�\0ȡ�R]�"	6\0@%���I�\0r(��G�H�\r\0�Cɥ<�\0El\0�J.��(�\`\0�Pr)�.@�\x1B\0 ��Kyt�$�\0\x009�\\ʣ\vP$�\0ȡ�R]�"	6\0@%���I�\0r(��G�H�\r\0�Cɥ<�\0El\0�J.��(�\`\0�Pr)�.@�\x1B\0 ��Kyt�$�\0\x009�\\ʣ\vP$�\0ȡ�R]�"	6\0@%���I�\0r(��G�H�\r\0�Cɥ<�\0El\0�J.��(�\`\0�Pr)�.@�\x1B\0 ��Kyt�$�\0\x009�\\ʣ\vP$�\0ȡ�R]�"	6\0@%���I�\0r(��G�H�\r\0�Cɥ<�\0El\0�J.��(�\`\0�Pr)�.@�\x1B\0 ��Kyt�$�\0\x009�\\ʣ\vP$�\0ȡ�R]�"	6\0@%���I�\0r(��G�H�\r\0�Cɥ<�\0El\0�J.��(�\`\0�Pr)�.@�\x1B\0 ��Kyt�$�\0\x009�\\ʣ\vP$�\0ȡ�R]�"	6\0@%���I�\0r(��G�H�\r\0�Cɥ<�\0El\0�J.��(�\`\0�Pr)�.@�\x1B\0 ��Kyt�$�\0\x009�\\ʣ\vP$�\0ȡ�R]�"	6\0@%���I�\0r(��G�H�\r\0�Cɥ<�\0El\0�J.��(�\`\0�Pr)�.@�\x1B\0 ��Kyt�$�\0\x009�\\ʣ\vP$�\0ȡ�R]�"	6\0@%���I�\0r(��G�H�\r\0�Cɥ<�\0El\0�J.��(�\`\0�Pr)�.@�\x1B\0 ��Kyt�$�\0\x009�\\ʣ\vP$�\0ȡ�R]�"	6\0@%���I�\0r(��G�H�\r\0�Cɥ<�\0El\0�J.��(�\`\0�Pr)�.@�\x1B\0 ��Kyt�$�\0\x009�\\ʣ\vP$�\0ȡ�R]�"	6\0@%���I�\0r(��G�H�\r\0�Cɥ<�\0El\0�J.��(�\`\0�Pr)�.@�\x1B\0 ��Kyt�$�\0\x009�\\ʣ\vP$�\0ȡ�R]�"	6\0@%���I�\0r(��G�H�\r\0�Cɥ<�\0El\0�J.��(�\`\0�Pr)�.@�\x1B\0 ��Kyt�$�\0\x009�\\ʣ\vP$�\0ȡ�R]�"	6\0@%���I�\0r(��G�H�\r\0�Cɥ<�\0El\0�J.��(�\`\0�Pr)�.@�\x1B\0 ��Kyt�$�\0\x009�\\ʣ\vP$�\0ȡ�R]�"	6\0@�\x1Bn���#X�|y�wЉݑR���tH�\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0�\x1B��vS�NݩE�������	\0�+�/N�?�����b��b\`\`��_4�HX�W���ح�\r1�u�]�\`���_.��H�v$����w\r\0�}風�-�r�QGU�?}��~�L.�(��GC��@-X����%_�����+\0\0覴��Nww�§��)K)�Y�Knm2A��u��M�>��z�
>��_\r\0@w�����A�u���Z5�ń?dj*H琇��<��HS��hy\0�ѻ��t�����^Kn�Q}���%�<sC6���[?A��2�&0�5�>�ډ��VɭՁ�p�F���O�:��L�_Һ���j\0�\f�%�:E'�S�L����dԕ���:�0{{�>
�k=�{,XKx�p	\x07\0
0k֬tG�+��@׋3���Kn�T���a�O��^��kmV�I�\0@���G1k��c)�����6�_���_�wÏ:�n}rm?ױ�\0@����Y���i�ְM��㒻nݺZ�c�npp0T��k ����\x1B��\0�]�3�OKWbv��Jnh��j���eб�6n�O���g�5\0\`���V;Tm�d;�~��\f\ft�T�4�=-H_Bw\` \0P�ty3�����.[\`��hK��ŋk\r�f\rQ{xأ�~�ǎÿ\0\`�,X�\`�/d�_խa�Q����^åQ҇��:X����g\0\0�ک&��K[k�������Kn�[��@���|X鱁&����%v��W:�l���,���|Li�4]��-���8\0\`��Ml�vyS;���+1ء��[k����4�=�~��r\0&}!k�Cq�J��o�A���tt!gj�4�8�<�^��t\0�\0i/�\vY�F4J�����\x1B����S��!���Wh\0�x��&��q黑Jn\bgk��p�����7�8l\0����J\x07�\\�K\f[rC�M+C+�4M��8����\0�<�]��p�����[�.�\v�1N�����(K��s�M�#�"\0��vanNc\r?��^\f=U+���[M~�s\bv�h%\0\`�҃Grf���\\�Q��Lݴ���\f��ƕ\0Ʈvan�S�j;�^i�!jw�i�C�c<�>/����\0\0�"� �m�؟���.^�x؟_;!�\x1B�B\0\0]��0?=�����Zrw�uב$�|�P�w�;�㰵��s\0�T�\vsGZ��~��qi��ƚ�3�*�&Mr�O�\v���wT>\0P��-�t��z\\%\r�.�Beb���\r��t��v ��}\0�09I�u�3����L���ڤ����z��t��}p\0@yj�&��̘�/X�4��!�P�0��S=�O�a\0\0����z�g��߽�4�XJ�C�h�t�f��O\b�ڬ��\0�H隧u����4�K�C�h��\\Mgg,�	nS��sFzE\0�\0��*}���_�h�%w�!T4Fm����ܪ�;x�z�:\x000I��Y����$��\rԕ��*���\x1Bb9�+�jy�ԩ��}�����?�\0(X����-�,�h����!�P���:�T��f^\r��&,X��\0����O��JOAq=.�ԭ�;�*c�s�O\b�髸^?\0&�t��?��	�4SK�C�h�ֹ���^HT�\x000I\f�f5�Q�w0���!�P�\f���#�юз~�Q|\0\`�I����n�ǥ��^rk��t0,
]Q�6�
y�&��ŋk#�^�\0&!���p�^r�BEc����vuC򇭫�ޮ�����'\0��Һ4�Z"M֋�;�*#�6B����ɣv��YM�G%w�?/�����Z�\`A���6�/�{���yt\0L����ǥ�zWr�Z�r���>�]�)S�ԞR.\\��V��.\0\0�G������a\vo,��H�'[��\\\0\0\0&�j���\0\0\0\`�ӧO������\0���
endstream
endobj
9 0 obj
86939
endobj
10 0 obj
/DeviceRGB
endobj
11 0 obj
<<
/Filter [ /FlateDecode ]
/Width 1
/Height 1
/ColorSpace 10 0 R
/BitsPerComponent 8
/Length 12 0 R
>>
stream
x�;r�8\0�M
endstream
endobj
12 0 obj
11
endobj
13 0 obj
<<
>>
endobj
14 0 obj
11
endobj
15 0 obj
<<
>>
endobj
16 0 obj
11
endobj
17 0 obj
<<
/Title <FEFF0061007400740065006E00740069006F006E002D006600690067007500720065002D0032>
/Author <FEFF00680074007400700073003A002F002F0069006D006100670065006D0061006700690063006B002E006F00720067>
/Creator <FEFF00680074007400700073003A002F002F0069006D006100670065006D0061006700690063006B002E006F00720067>
/Producer <FEFF00680074007400700073003A002F002F0069006D006100670065006D0061006700690063006B002E006F00720067>
/CreationDate (D:20260803210402)
/ModDate (D:20260803210402)
>>
endobj
xref
0 18
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000117 00000 n 
0000000311 00000 n 
0000000401 00000 n 
0000000419 00000 n 
0000000457 00000 n 
0000000478 00000 n 
0000087601 00000 n 
0000087622 00000 n 
0000087649 00000 n 
0000087798 00000 n 
0000087817 00000 n 
0000087839 00000 n 
0000087858 00000 n 
0000087880 00000 n 
0000087899 00000 n 
trailer
<<
/Size 18
/Info 17 0 R
/Root 1 0 R
>>
startxref
88392
%%EOF
`})))()}var p;function m(){return(m=e((()=>{p=`�PNG\r

\0\0\0\rIHDR\0\0:\0\05\b\0\0\0}@��\0\0\0 cHRM\0\0z&\0\0��\0\0�\0\0\0��\0\0u0\0\0�\`\0\0:�\0\0p��Q<\0\0\0bKGD\0�\0�\0�����\0\0\0	pHYs\0\0.#\0\0.#x�?v\0\0\0\x07tIME\x07�\b�A��\0\0\0%tEXtdate:create\x002026-08-03T21:01:26+00:00���T\0\0\0%tEXtdate:modify\x002026-08-03T21:01:26+00:00ݖi�\0\0\0(tEXtdate:timestamp\x002026-08-03T21:04:02+00:00���\0\0\0tEXtSoftware\0Adobe ImageReadyq�e<\0\0�\0IDATx���w������� �����P,h�\`b\x1B��(
��a"�
*QQT4A%�/���\v*�(�\rl%"Ѡ�;6�peg~����ܖ�:w���Õ-�3�ٽ������e	\0P:�al'�
˲j�.\v\0\0�*v\0���4�0�.a\0�rE��ҫ��\v\0\0
��\0%dF������.\0\0加\0�U���0�Aa\b\0�rD��1\fcOI}Oׄ].\0\0�A\x07\0Jg\\��F�Ga\0\0D�����64��5a�\0�rC�����A\b�j�.\0\0冠\0�1.�k�\f�v\0('\0(���j�2LVv9\0('\0(��\0�Ǡ\0\0A\x07\0�(>\b�Ȁ�ׄ]^\0\0�A\x07\0��&�iǅ]X\0\0�A\x07\0�k\\�v6\f�&�\0P\b:\0P$�A\bze�����\r\0@9 �\0@����\fJ\0\0@�\b:\0P�t�qa�\0�֎�\0�Q��{㣵\0�t\0�8j�xogIC�^\0\0Z3�\0�aC�� ~��^\0\0Z3�\0^M���0�=�^\0\0Z+�\0P|��
4�qa�\0\0�A\x07\0
k\\�5�A	\0\0�\rA\x07\0
�����\\��\0P1\b:\0P �a��'�4.��\0�5"�\0@��$yn��{��NI�<��0�Aa�\0\0�\rA\x07\0
 >\b�@���J�NҌ\0��ʲ�A�~%i�ﵚ��\0�ֆ�\0�q���<I\x07Y�UcY֏��Ĳ�Y���t��� Iɠ\0\0d��\0y�����[bFY�5Ȳ����ϲ�-˺Bv�y"�����\0�ք�\0�\x1B*�&I{Z�5�P3�,k�eYC%$;�\0\0����.\0\0�v�\f7)�?W�ܰ�\0�ք\0\0\0\0e��\0\0\0��t\0\0\0\0��\0\0\0��C�\0\0\0Pv\b:\0\0\0\0�A\x07\0\0\0@�!�\0\0\0\0(;\0\0\0\0e��\0\0\0��t\0\0\0\0��\0\0\0��C�\0\0\0Pv\b:\0\0\0\0�A\x07\0\0\0@�!�\0\0\0\0(;\0\0\0\0e��\0\0\0��t\0\0\0\0��\0\0\0��C�\0\0\0Pv\b:\0\0\0\0�A\x07\0\0\0@�!�\0\0\0\0(;\0\0\0\0e��\0\0\0��t\0\0\0\0��\0\0\0��C�\0\0\0Pv\b:\0\0\0\0�A\x07\0\0\0@�1,�
�\f\0Z	�0��4(~�NҞ�:�].T�E�~�4W�\\˲�] \0@�A���a5��I�vY�4VI�%�
˲��]\0@�\b:\0R2\fc��+D�\rZ�y�j\b<\0P�\b:\0�1\fcOI3D\vZ�+-˺"�B\0\0J���#�Mힰ��"I�,��1�\0\0J�Q�\0$�1C���~���[*\0��@R"�\f�@�t�4��\0���k\0�A\x07n\f�@	�����\0��t�
g� I/����3~\x1B�*�}�b����\\�>ϲ�Aa�\0��\b:@3\f���w$�
��޽�רߞ�C\x07��w��*���[��^�\r���s�1��پ���\0��t�
f�M��\v:��7ݢ�'�6�����\x07���l�*I{r�\0(_�B�����A�=���5��Wт�o����?^t�{-˪	��\0�� �\0*�(k'\f;I��8�V��=��N;yx��{Ӫ\0�᥁
?7gh��z��^'M$�U9���5�O��N^vy\0�A�*�P��I��[oQ�-��]V k��[�0� �ք]V\0@qt��4(�5g�V��r@��rv�����W�|5\0@�!�\0�iP�	�?4�2y٣�nA[u�]V\0@�t�ʔ��9�{oOk��aGd�=�.'\0��\b:@�1\fcP�i�:�ذ�	��v\v2ٞa�\0Px\0���~���\0�~��E�\0\0\0Pv\b:\0\0\0\0�A\x07\0\0\0@�!�\0\0\0\0(;\0\0\0\0e��\0\0\0��t\0\0\0\0��\0\0\0��C�\0\0\0Pv\b:\0\0\0\0�A\x07@h�y{��ܴ[�6��9E]ޥ_�X���|[ث\0\0���\0\0\0��t\0\0\0\0��\0\0\0��C�\0\0\0Pv��.\0\0��~\x07�~{�%I�j���.\0\0("���1��a\0\0�\b]�\0\0\0\0��\0\0\0��C�\0\0\0Pv8G\x07@Ř���]�F�=��\x07�2�����"}��G:�wg7{m����N;h�QG�c�y���?�·��+s�����y�����?>�uq{�G%)�zIҭ��!I:q�	Y��ҋ/�_��)Iz������y^���/��˯{���˯���\x1B��:\0*A\x07@�x핗;ܗ^~e�pP��z晧%�;�Ύ�G~�[n��Y�p��)������ǚq�=��&S[�$J�8�H����f!"�{�O�L� �tβ���ٞ�%Wk׮�ԛ�z>3\0\0
��k\0���h���\r9~W_y���ݹZ�v]V�z��׵��}ӆ�g�yZGz��������ÏU�둁B��9�;[�^|i�dӲ�<�pB\0�hh��\f^}�u�:�����O�{��l��W_~]����g�����m�顋.�C�e=�Уͺ��v�Y��^�ZP^}�u���]}���.�p�֭]��%��/��՗OJ�\\I�I�O��&�v��˯��?򄢿N�S[n�u֭V_~���8m�jk�$����+�Î;28\0�\`\b:\0��ڵ���;얕L���?����_��#���x��\x1B���#�ح�՗_�����>��uץ�b�,�#�t������}��i��M�y�'��󷿧\rM�:L�'M�,k��˪��ԛ�&B�oG������\0����\0�1��naG���_h�~ϟ���YOx�{��gӾ��$;�<��#��q�t�����''�;�wg��/�L:�;o/�t����;��l��V�d�%��.\\����Ï˞<�z]}�Մ\0@Qt\0 \r����+'f�C���������ϴ��~�O\v���ݛu\0���:�#�}��ӽ��k��'\r?9�A��j+]z����\v,\b��[o�Q���o�oN�j�\0\0d��\0\\z���q��~��&���.I��"5�|�ױc\x07\r?��\\����<�@\b\v��OZ�lt߲{��;\v�����%:�#5v�؜�\v\0@P\0����~���v�iG�㯿�&�t�������\\�'IC��iՙ��3��׮]�i9ʵ�Xǎ�$���Q�[�k\f\0��\0@'\r?9�0�}�-M��%�?B��\f<�D���Ï���\\�S�vةwN�p.���!G���\0A\x07\0Ҩ�y��\x1B4���q�>�.k~����Zǎ�Ч�<@q��i�\0�]�\0 \r��(��\b���[.�ܪ���<�t�,�䞻���B��G\0\0�A�\0��?@���;��f��[Q���K�����_���¤�*Ep\0@"�\0@�֭�������o�v�{��E��Ï���y�֥T�8�H\r<�]2႒~V\0\0d��\0!Z�fmh�~�Gu�7�5�����?>��9�g�SsB+7\0\0At\0 D7��y����{ԵL���KM�4�Y��oG��~{���v�Q{��_�\r\0\0y!�\0@�:t���8S7�|�]�N�\\p��Z:��\\����hh\0��B���C͗_~�=���w��	9�<�<�7\0�����\0�#�82q����*�������~\x07!\x07\0P�\b:\0�]��xh�y�Qm�i7m�i7������|��Ǟ�\x07�uD��(v \0 _\0\b�{홸��C��;o/�k~�.L�?��c���Gx�眜y/��'\0@p\0\b���<���#9�띷���L<��������T������y>\0\0�D\0\bYǎt��W&�uڝ9_�f�]w'�qđ���_&o�Uwϴ��{-���嗚|դ�?2\0\x002"�\0@\vp�I��<u�)Ywa���o�\\\x1Bg�)�x^�r�-=���߳j�q��S[��3�\0\0-A\x07\0Z����J��~��#=4p�εW_����<�����Ґ�{��=��Ӻ��Ɂ����h��N���C��}t�=��{^\0\0��ut\0��N;%���\\z����yc�^�@N~����kO\`u�):i��:\`�@�8���}�����n��F�hjGq�ƞ76�2N8�W���uڝzy�\\�3~��?������"}��Gz�z�ɹ嶩�q�T]�'��#=T��~�֮]�Q�9=�\0\0�\0�$�?o�:t�K&\\�x�������������Gj���4��c�����YOh������.	4oI�9�ĵwN:�מ��̃�\0h	�\0-̨ߜ�����I�O��}��\\�ܛ2�8�?�z���:���'���ox7���H�v�Ya\\\0\0$eX�v\0��a�$��n��o�E����N6�#U�1��)׫c�ͺ���˯��/�l��M�[��:�X��ӎ�V�T֮]��uy�i�M�e�d�eY��.'\0��\b:@�!��t\0�2�u\r\0\0\0@�!�\0\0\0\0(;\0\0\0\0e��\0\0\0��t\0\0\0\0��\0\0\0��C�\0\0\0Pv\b:\0\0\0\0�A\x07\0\0\0@�!�\0\0\0\0(;\0\0\0\0e��\0\0\0��t\0\0\0\0���f�~�I�E\0
�믾�\b\0��t���N�	>x����\b��/�d�]N\0@�t�
cY֏�V�������vQ�������L�,�r\0
��T���&x��.#�����Z�w�MA&�\x1BvY\0�G�*ӬL\\��i�A�v�_n
2�*˲�	��\0��#�\0�iV���z�֭�)�Y{��5c�_�L:+�\0���T��y:Od��љ��)7�]\\ +�|�T��<<��7�]^\0@qt��uS���t��e\x07��\x1B���)'�\b:�<��@�2,�
�\f\0Bb�\\I�L{�a����b��o���\r4�n�O��}h�/��m\x07Y�57�\0���T0�0��}\r��A�Ss�o5�������.>����Z��yQ�w�MZ�4�\v��lYָ��\0(�P�\f�')�qz��^:X�ﰃ:t��j��,��}��zt�ù�}��=��\0�A\x07�\fØ!id��\0J\`��A��\0��\b\0H�8I��.P�\b9\0P\b:\0��\x07����6ʲ�a\0P\0��cY֞��\r�,@���=�ڌ�\v\0(�\0˲j$���s\b�v�d<07�\0\0J���˲n���h�A�\\vW�A�e-\v�0\0��c�5\0iů�s�����z;@HI��nj\0\0��@\f��";�\f����/�2��X�#i��Y��\0pt\0�,�ڳ]��he�����2I��]�ֈ�n\0\0�t\0�D\f�$�%��OX�54�\0Pn�\0\0J�&�s��[�\0\0@t\0���8�L���\x07\0@�!�\0@i���\0\0�A\x07\0Jc\\��:\x1B�Qv\0('\0(�� �2LVv9\0('\0(�q�Ƞ\0\0A\x07\0�(^�\v8�a�\0�rA����bڡ���\0\0@�\b:\0P\\5YL�Y�а\v\f\0@9 �\0@��1T�\x07!�\x1Bv�\0(\x07\0(�q9���a{�]p\0\0Z;�\0A|��9�}\\��\x07\0��#�\0@q���#�\0\0��t\0�8jB~?\0\0��\0fF����1.��\0\0�5#�\0@��\`�\f���\0\0�Zt\0���#��:\b�_M��\0@kE���W�y����\0\0�D�����6����	{�\0\0h�\b:\0P8C�� u)��	{�\0\0h�\b:\0P8�<�\\�e�{��{�<��0��a�\0\0�\rA\x07\0
 >BZ?�S�$]iY�v�^\r0�\r�e�H:H�<�k5a�\0\0�\rA\x07\0
��u�^I{Z�uE�3�,k�eY�$���$I�1(\0\0�!�\0@�����H�A�e�X��,�yZ�5CҞ���?U�z\0Кt\0 �$��,kO˲�j��e�o�-�K�+	\0@kRv\0���,kV��L��>\0\0e�\0\0\0\0e��\0\0\0��t\0\0\0\0��\0\0\0��C�\0\0\0Pv\b:\0\0\0\0�A\x07\0\0\0@�!�\0\0\0\0(;\0\0\0\0e��\0\0\0��t\0\0\0\0��\0\0\0��C�\0\0\0Pv\b:\0\0\0\0�A\x07\0\0\0@�!�\0\0\0\0(;\0\0\0\0e��\0\0\0��t\0\0\0\0��\0\0\0��C�\0\0\0Pv\b:\0\0\0\0�A\x07\0\0\0@�!�\0\0\0\0(;\0\0\0\0e��\0\0\0��t\0\0\0\0��\0\0\0��C�\0\0\0Pv\b:\0\0\0\0�A\x07\0\0\0@�!�\0\0\0\0(;\0\0\0\0e��\0\0\0��t\0\0\0\0��\0\0\0��C�\0\0\0Pv\b:\0\0\0\0�A\x07\0\0\0@�!�\0\0\0\0(;\0\0\0\0e��\0\0\0��t\0\0\0\0�ò���\0��\f�*iOI��O�)�s��Z�E�~��L�;�fY��,�B\0�G�ʀa�$��t\\�e��rI7I�aY֏a\0\fA\x07h��g��^a��7K���\0-A\x07h�\f��Nv�vY�
�JR�eY��.\b\0 5#\0Z��98�����\rØaF��\v\0H��1\f�F�=a�@�"I���\0--:@+A�Z�~��Ҳ\0-A\x07h\b9@�F����k@\vgƞ��*�k��:���Wh�V�Z��3�g�Z�U�z\0\0l��3\f��G���/Рv�>{��&�چ�
@���\x07�魷���<��{>۷����\0�e �\0-�aWH�<�����0�p�\rP O���}������dp\0\bA\x07h�����)@��޽�׃�_������@�Y��^�_��n����o�Ҳ�+�.7\0T:#\0Z�q
r�5k
!\x07(�M:��\r�\r��xAз�\v��\0\0Zt��0�e�ze�����;ovq��p�
ڲ3ʲ�a�\0*-:@\vi-cȹ��?r����_�w��L:4�@�#�\0-SM�	;�P��_��*�&�����ua;.�@�#�\0-Ӟ�&���_�]F�"w쮁Zu\f�vY��t��i\`�	�S�e*��ѿ2٠��	\0����0�al�i�aÎ�Z9@����<�.a�\0*A\x07hy��4��{�\r��@E�S� ��v9��t�V�c��a�h���$�"\0\x002 �\0\0\0\0(;\0\0\0\0e��\0\0\0��t\0\0\0\0��\0\0\0��C�\0\0\0Pv\b:\0\0\0\0�A\x07\0\0\0@٩
�\0\0�ߜ�>�g_|�j?��������}4��3$Ig�vq\0@ �\0(�ի�5�o��\\�q���%:s�E��3GK��:C�:�|�Na�\0\0h�����;_]�(�$3���r���ݹ����^\0\0�
t\0�g+V딑S�3nwM�VwM�V����n��|��v��\f9��iwNW��՜�>\f{����^�h�A��\x1B�����8\0�V��k\0
b��:a����]�x�9�&�y7��}\x07��#\x07h�s'������\x07I�>��3��?nհ�w{5\0@+A���}�bu��s���h���f=����v����믿����ϡe\x07\0\0F���ի�u�9�yB�W^���t�:un��|��~��v�����\v��\0\0�@\b:\0�2�o�����$_q�E���!��#\x07�\v�I<��]�{��Zث\f\0\0Z���-^��3�ڐ!G,�8.��1���x|���Ҫ\0\x002"�\0�٭w��<���S\v��N��&.&����a�:\0\0h�\b:\0r�x�JM�sz��W^�}\x07�(ʲ�\r��Ӫ�\v�^}\0\0��1�4���yq���a\x07o��N���c\x07�������s��s-�d��}��g�>|�.�ѳSA����ϴ��ϓ.��\v����=4l�^y\r��6�w�z�Oi�W��L�yJJ\f&���{\0\0�aYV�e\0�b� I/����[��1��\v����~Vb��#N���[��^U8L�w~ʝ�d.��՜r����h���^���i�&v�/^�?]���@��;�C.�y�هexn��y�s��p.�\\u�l]q��Y������畯h�A�&�gYVƉ\0\0�A�5\0Y[�x�g8�}�٭�e\br>[�Z�����ο$]��[��^'&Z,r1�w��^'9�=��)#�j�������z���X�1��@�/^�RG�&�#٭>�;��>I\0\0rC�5\0Y{�O<����:�"5�x��f1�얅�;o��|�����\v/.��3G_�Ͽ̾�e�sj��M�b_p�9����v��ͦ{~�u�_nM<����h�[�?�P��|�?K<�W�wਗ਼���4���R.�����w�g(�#N�!\x07�O��n�sj�/<�hڝӵ���
>2\0\0��u\rhaZC�57���S��K
��uؑ<;�\\x�.��1�9�u���7S�+w׵믿R�?o_[hȐ#t�%�f����i��#ֽ���ߗ�z9������>z��))������<����,��*�E��� ����s�����k\0в�u\r@־�be���!G���#I�2�YP��O'*���vң]�����i���+�r�uL��}\x07�����y�f�6��z>􏦖�tc}c�g��s״k�I�ѳ����4����8�{\0�\x07A\x07@�V|�E�~�m[V�������)���s�n	�۷�}�j�s�k��@\\���du����v҈'&?��9E_�a��\v.l�bw���&=?蹗�M�1�Ĭ�ӣg']qe��Co��^V�\x07\0 \0Ys����&�.���O���_]�G��ᘜ�ӷo���Ȓ}~IГ�����#��rp�����%�l���θ既�g�)\x07zϜ���4��X�����f�M�s\0�lt\0�e�M6�\b	����\v2��3��V�Pi��d�4��Ο��6�ǟ}�<�1�3O��g=����iI����=��^U�YV��7\r<o�N����	\0\0��(\x1B���\x1B�W^��Թ��:�׉�Þ�県'��qb���u����q����z�<up���S���n��s����z�Oy�\0�lt\0�eM\vځu��q���d��}��!q��v��M�v�e���4 ���c\x07罞醕�ԹmAF;��6X�?\0\0
��k\0�6d���k֬\v�8	�nk;Wg�,��;o�y�����N�>�5�g1���<�
\0�h��5�Hk����?q?�sI�:un�#NL���k6������f���~���_~��\0\0�F�����nQl��g�z���_Kg��:���t)ؼ;u�$q��p���\x07(�I������i�\x07��xZ�R2�\bz�/�:\0P
\0Y�w�z���i��(�ի��u�����_���~\`�뾠F\0\bC)�s���5�/�ӎ�V]�G.<#��9�g�c�f�?\0\0�D���}��p�x�E:�?�����5Ϳ��>���يպ�ҿ5k�}��g�>��6i\x07h\0\0 \f\0Y�۷����$��ۣ�\r�o��\x07��������?�t��dV�Z���I�p�\x1B����Ag��z�}�m�k�\\��:�_��]\0�tu\r@N�:�׉�>��ޘ_��_xqA�~uu�f!�?4�g_|h���^U�i���FE]�L��i�|�|�\v������k��\x07r\0\0-A\x07@N�������w���+=a�ק\fM:݈'&��-�.s-a��B�����U�� E�\r�.���y큿�JܿkڵtQ\0�\x009�۷�F��t���_[�V�G�������vO:�>�언�_n��U�y/���>����:ap������z�[�~��=�/^�x\`�н
�\f\0\0J�� g#O9������|���\\�e�Yg�lU�w�<�g�Z�ײW��םw>�x|��紈.[����]��z��X��!��Hvy�������\0��t\0�l�=tŕ%Ϟ����fv��zU������<�W��\frD��Lϫ�c欅��C\x07��
�������<��]W�^�6�e�|�]�y>\0\0�A\x07@^���!���+.��\`a���� _p�9��9������%���'sZ���+u��7d�EB;\x1B�Z�[o{"qĈ=�<�/�:�%Ag��يպ����{}W�ِ�<\0\0��� /�:����Quu��sW\\~����GsnX��^�;�>M�sz�!C�Х8&�{����d���r���;?��/^�R'\f���ܥ��Z��3�B��U�����<u����t�<�q�SY}���wjk�x�pP�;o����vyq>H\0@�"�\0�[�����CW{����U�?'������	9��}tݟ��k�>�S�3G_8x�y�C�0�RO��믿�E�6��z�^U�?��QϹO\\xN��N��6�x�e�g>��;r�|����d��mz4]+iڝӳ�[\0T6����۷��{z�����v��}���i���S1�3M�w�v��,\r?�O�2�\b=���Y]�3U���\`M�w~ҝ�����)#�j��gz�ŕi��{1�\\e������{���u�_nM<?bĉ)[�F�����;�'�g+V{^s�ǣ�^�����e���:�;�TM�w�n��y)���{W{;K�\x1B\0\0��e�]\0.�a\f��R�in��O3z�@�\v��{�{�o����K�pLΣ}-^�R�w�|"�]Ӯ�#\x07d����$��=��w�_{��@-I���'��[�L��y�C\r9�̜�g���J�]u�lO+�#V77��O9�ӽ.��[��5ϲ��\0��\0w����9���+sz����^�_��鄼�4�۷��5�b�5�ڬ�7��3���G�
,���z�5�Z��ޱ?������^�?��lF�8Q�.|������R�w��vm��\0���)��9�}�Ͼ�^o�g���\x1B7g'�����:���i�Ygh���h�}�Ϫ�\\K�n=���"m�զ9��w9�/�=]�$����:H}w�&cK��U�-�D��E\x07\0Z6��c��A\x07\0Z6��\0\0\0(;\0\0\0\0e��\0\0\0��t\0\0\0\0��\0\0\0��C�\0\0\0Pv\b:\0\0\0\0�A\x07\0\0\0@�!�\0\0\0\0(;\0\0\0\0e��\0\0\0��t\0\0\0\0��\0\0\0��C�Z�3M��ڰ�\bT�\v�\b2ُa�\0*A\x07ha,�z'�4/��J��*���_�읰�	\0����L�ӽ�t�'z�O�.#P���ԫA&{'�r@%#�\0-��L��ya��H\v|��3\v2�;a�\0*A\x07h��f�\`���=O\0@�9�� �-�,kY�e�JF�Z�YA&���Z��>��o���w�\x1Bd�Ya�\0*A\x07h�,��QRƽ��{^�_�x��*�\x07|��Q�\x07�����\v\0����\\7���o��x����^|�=tB����\0�ϰ,+�2\0H�0��F�vذ�5a�0��u���ƚ�����/�K���m�	:\0>�Ђ���쑛:\x07}��x��=ro��5��5�_���<��{>���lYָ��\0 �\0-�a�$ݘ��;�P����vܱGث\0�k׮ׇ�\b:���rI{�ϱ\0�����ta�U�Y��N�\0�\b:@+\`F����vY\0$�+˲f�]\b\0@F]Z�xW�A��]\0͌"�\0@�C�Z	W����\0�J�A�e�\b� \0��\b:@+bY֏�e�H/{'\v@8��x\`n�\0$�9:@+zz���a�� �$��\x07\0Z>����1HR��\r(��n�4���u �\0e">2���m����(����p�F@�C��T<��v9����)�2�K�����(im����	6\0��t\0��\fè�t�eYەp��K��eY�K��GKzֲ��R.\0\0F]��\x1B'�W���R9P��a�]��������p=\0�D���2\fcOI��kJ����X�e:g�.\0\0I\0(�q��#�ÄU�g��ßŻ�{�$u�?�o�\0�d\b:\0P"����jJ�h+�%Xf��q�,\0��\0��P5����\v���������+K�\`�M��\x07\0�� �\0@�K�\\/�0�q��Zo66\f�ha�0�ޒ�$y�V\0@�t\0��#��K�rM�*�sP�T�f�".\0\0�\0�FM�׎+Ơ�V��S��s1%����-���=\0\0A\x07\0�,��?2�d㊰�L�6�a����C�\0�A\x07\0���@�o��9�d{\x1B��q��\\f\x1BI����Ơ\0�R �\0@�\v0Mg�0j
�� �5\x1BKڻ�����U\x07�\0��t\0����
8yM���M�)�5u���\0���\0�5.�i\x07hP���z�m\r�\b�R2\fc\vI]NކA	\0\0�F��"����|�Xt��4�\`����\0���\0�S��{��Gi�I�uf�,ߖנ�A\b���m]�YO\0\x002!�\0@����Β���\\Zg6V~͵\x1BZ���\0�A\x07\0��0��
>\b�߸���(j�t_˵\x1B�6�� \0\0
��\0�1.���3\fc��w��B෹a�d��� �^���!�\0(8�\0X|��y�f\\��wP�rxO��
���\0H��\0�7�\0��jP�xk��y.�l%0\f���m�\\f�x�\0\0E��«)�<:g9�\\Zc��fh�B]\v�k�\0\0
��\0dF��R\b�.sc.�d3��
����\0\0Ph\0(��Ϋ�a�L��B���0��#����r� Zu\0\0E��)� ~5�)Tk�#�5u
L��\0\0\0�\0�)��:�{�x~d�A	�/�B�!��?3\f#�<3\fBАcY:�[�\0\0(\b�\0@<�\f�=�Jҕ�F��,I{I���qiޗ���[I��e��I�)�|�Z_$�)��\0�}IҺ$��}\r\0P0\0(���Bp���,˺"�\f,�zǲ�A�FIZ�z�&���V�����I��-�oY�����������<�@�?IOZ��4�2��,�_���[����\0�7�\0Ƹ���$dYV�eY?�2#˲fH�Svk�*ك\fM2����I�-�z&���dY�c��\x07�76\f�ٹ?�a��䌐�Rҿ,�zϲ����Y����'e�,9h�\0A\x07\0�dƞ��ZeY� ˲��;O˲~���)�	%o�9\\v0�Բ�i�e�xɗ��eY����[%��[v���,�zѲ�u�,#�2\x1B,˚/�Y��i�|?;\0\0$�*�\0@�Qv7�\v=c˲�IS	�a��t��Y������ao��N��_��3˲j���%�hFo�0��\0T�\0�)F���w|���{O1����q�����2��\0@&t]\0\0\0Pv\b:\0\0\0\0�A\x07\0\0\0@�!�\0\0\0\0(;\fFP"�aa�@h���F�idZ_��\0МeYV�e(7��\x07\0\0\0�J�I\0�A'Oi�\r�\x07@62���8�BLS�u\0�gI��5	>�tr�"��z@�\vr>�p�B*�2#����\0�$�x��'3�N�#�}\0��-+�\0��[�efZ.A\x07\0lNX1�<�,�X��\b:�	8A���\x07PY�j�	#�D,��\0�YI�[����=�!�F���r�&��d��<A�N���\r8
�� ]�
�L\0(\x07V��������A'\rW�Ij����J��	:�\bAZt\b:\0�2	8�[��\x1B�avl�҄�-��A��T� ;�~��E��ˌX_~{\0�I�.k�B��\0���c��&	_��p"�e\x07@za� ��#�dZ.�=\0��tR��<3�k�{\fv$�c�L���7�=R�V�d��/Zt����]��<옲���&0}����?6.iB�?�$\v<�Zv��a\x07@e\bt�\0\0*W��s,5�Sޠ�n�1�m�I̷��A'.C��\x07�����t-:A\x07�Ta\rF��Z����A\x07\0��u_s��E�h����C�q!�(���ܢJ޺�MK�\x07�-uxiF]��Xi�s���%'Y�!7�7��=g��N�!'��A�����6���=��\r@��#�4�Iک���$�e���M�i
�L\0h��㷵��ğsw_swYKw���t=WQ�ƭ�N�s�mDR'I[K�T��Y�\0Ӵ�}Ф�2m㋱LIj��z1�	\0�"&i����<�i�q��Vi�:t�h�qBΦ�z�:\0\0\0@�9����n��*���+Z������~��*T1*:���i-*�K�β�y\0\0\0\0��QҎ��Χ��|X�tCUK��SI�:\x1Bt���8��-9�$��
��\0\0\0�����;��L翞�3��ᛦ"	��꺶���"�\0\0\0 \\QI�ewi�d��X��Y���d�9�s�H�%�\0\0\0.����NM��Zr�\r^P1�9R�_�M֚�]�\0\0\0�L���:!�TS�5�yGE\r9]�]ג�����]�.\0\0\0�ƶ��[S\r�Q��*��ZE��ĥj��SY~.g�u�v�u�޶��t��zha^x�qM����Ӝv�:���
��?_?.��o��F��a<\0P�~\\�R_��L���-�x��l��[�\x07���z�n�Ivݝ�h͑*0�$I��V���J�	g�u��r*�\0\0\x009�ҩ��t�>;�C\x07�J��}<���V�����E'Y�qTL�5��5��F�8������N\x1B>��\0\0���ҩ��;Z�7[�{o�m�d7^�\x07�Jp*F%\x07��oh���{{]�=��^a�\0\0\0e�W��u���\r;Q٭:��߯�t�u_�.�\x1B�t�Tu�|� �\0\0\x009���ل�nJp**ܸUj�q8_~gI�3M|դ\x1Bի��a�\0\0\0����j��.
2iTR��d\x07������k7A��䬞ʐv9d��w�L+v��>H,˒i�
���\x07�(�2�D�h�9Q��\x07�C��d�����U��帕m�I����N��w��_��C/�0
e\x1B�v\r\0�Kw(����N\vt:�W����N�����,Fd7�m�i�{��\v��ưW@+dYf��\f3�X�%���[l~�\0Ъ�f\x1B�H��L�{�B�^���޽��ҥ�����{MR��*\`XiG�:)�M��%�W��H�\f���c�WU��	:\0r33w3MK�%:�e|�\0КF�b��3M%�6��9᧔�g��e
:�}=�K���T�6�d��g��Aǐt��Ч���87\x07@n�\`��X���d<G�\b��V�i/�X�$�e��d#b���	=b������pZ�VtR�d�G�L�o͉�?��?�mڴQ]���W@+�enѱLӨ��P��aYi�k���/\0�@$�a�A'�XvȱCP45%���zJx\\�	:N$Ϳ��s�ϩ��9�b1��ׅ�\0h�b�X4�4��H}}]A��V��#����V)����n�Q�5����D�p�VY�Xc4���X"�D#UJx\b;�j?p���.��h���c������>�Ɔ�կ�c\0�J���A�4�H]��B\x07���5f�����ː��fX�HD#bY��D#V,�h��H�ьF�,�2#vk��Zw����R�����<Q�sm2}\r\r\rڰ�� 7����-:�ٰ����4��]׊�L\0h�"���0"�����V��a(bD�h$j�b�V$����eYUr�aD�H�)ZwB֢�|!����=<��~$�-U��Jj';���ؠ\ru\0�ill̸��L+��n}� �\v*S��e�_&\0�f�E'ޚ#�Y�st�h4jE"+���HԪ��2#��eF�f̌U�6��LdY�i��\x1Bt\\!'�@Q׿�[а�t]k�4��A��\b\0�&�tLӌn���6���2��#�Ŋ�L\0h\r<;}�p�z>ފ�"ÒdE"Q�*�\f#bF�Uf$�L��iQ�m��1ÌY�i�X�Y���-AfTvW�H��"�^�\f:)B���p��<踧�#��B7R��X#�\0�Y��\bbf������E��\b\0�%�\vj���:�F$j�Kv+N$jF�Q+k�E�Q�4cF4Ze�U1����,�*f��}M3���X�A�)����\vN��,�w�������踗���Р:���Qccc��a�iE����E'}Љ�b_&\0���%���N(��fN�aE\f�2\f�������V��ʌF�f�*�F�f,3����,��aY�!�M̲ϑ��vLStc+�t����9��r��\x1BxRu_3R����YЉ�b�56���\0h�,�\f4�Z,��<�0��X�U�e@kaŻ������aX�=����H$"�0��s"V$�h���2c��k�XU�0MӰ,�4Ͷ1��T\x1B���uSؑ��_K���w]s\x07w�i�{���-%u��%�[�y:����^�V�
��ӏT�@�5\0�Y�z�f�����O�n����r�\x1B�k��\bMCC�Ƌ�v�\0�*��F�X{��~�,�ڤS�:l�iM��6\r#"ː�D�4:!�lS��f,b�1ôL�4���a�V��k1A'�y9ɺ�9���붹�=%U�\x1Bl�.��o;I]�M���?��&]\0�X�nM�LӬ[�n�uk�t)�r۴i�q�B/\0Z3g���7_H�:t���]�}�u�-V��j���fVUY�i�Lӌ�UU1ò,�4͘e��ܭ�d�5%E\f#b��&bI"�Y�\b:I�������-$$i���\0\0��n��.�֭�����6n�Y�[l�ͧ��n���\`F"��i���\fӴ�6m���:{��!ÊD"�eƌ�$&]�J�E�P�Nk����N��4 ��\0\0����X�7�|������}���nٽ秖e�e)b_[�sNd$Q]]�ծ�aŢU�b���y��5\f�2MÔ,�0h�)��tR�wkN/I�J�va\0\0PY�X���/W�z�ݶ��۴i� +j6���H�wb7�R;I��=�A[Ɋ������fD�!�Q��g��\0�I;!g���"�\0\0\0 D�֭�������5?tj4c�X�1������\r��U�X,��Pihh�44�Gc�33b�F�B=�)˒L�̷(H#�����N�v\0\0\0�n��d�\x07{�Y�C��iFb�X�	<��1�����b�X�1�h6FL3i�5�X,�\\������P��o�5�_�hk$�f9\0\0\0?'�[�c'�2#\r�V��Xc���1��ؐ\b?�i�Ve����RZtܭ8�stzI:.��\0\0\0ɘ�X���R_���e��i�1c�t�O,�����1ô���,��k�Ւ#��-}��\v���'�g?��v�ngu�tj~i�2Kkl�ך�?�����;j�v/�\0I�~�^}���\f\x1Bv��:����
\0����?���>��,�w�~��u\x1B6t���e�{��S\x1B�ŬH$b�-9Q��������F�"Ѫ6�i�F�4\r#bQE}�HZB��_(�	;GJ�:�LN;�\f\r|�z��9��\0\0@+�Y׭�Y׭ջg_\r��1z���h�+�\x07��_ٳK�;�ڥ�w�i��e��466F����j1M3b�-=���!�AhA'�hkέ���A�ӻ���\`���k���Z\0\0\0��]v�[�츷���I���s����ן���y��M�4b�X$�2Lˊ����b�e��LS��X�iJQ1�t�st�p������ػ�����{\b9\0\0\0(���8F��jd�i׭[�e��o�Z��,�4c33L3f��iX�eX�\fI2MӐ���j���t��AA�p������ۆ]n\0\0\0��]v�[G9<д߬�r[K�pLC�\fӴ\fIF�Zڰ,K�$K���kE���/�5�/��I�\0\0@I��~�}��3N�fͪ�7lX��߷�[sb�e�-:�p,˴��&��\b�\b�H�8��!�\f־{�4zZ�,�3�e�N�V���@	����\0@s-'\v���z����8���?tٸ�&k-˔e��=ͲÎi��j��Vx%	:��\x07O����\f�C�=5c8I�I�2d��Y���c�\0+ș�lg\0 ����RiC�&���>�k�[���n���ز���I��\0�tZs���8F^+���$�&�(k�5s���)C��޽��}���-g�ð�?.�\\��-��=\0�	t,�2,�j9�- dή�� ��������lB���t�oX��i��Ӛ���d��})4�$2:տ�}wȩ���2��v�2�X~u�!�4M#f��.3��L\0+Hl˲df�@E1\f��n|�h�0⻊���\0�%�[~��9ݬ��ڸC\x07��n]�i���6���8&\x07�K� A�pR��c�/�	:U�[7e a�-{*�/tXM�[\r�\rF,�NH�lT�� G�����\v\0TÈ����ш��\rÒe\x07 �2\f��S2dy[z��Y�f�^����i�����}�6��HJdO �D^A'E�Iv���qG�7�U��2�[�VCC}^+�\f�g2��#������1�&�e�\\��ƌ���XL\r\r�\0��$v\x07\rI�a2dȈ���d���zL���g�mw�t6ԯߨ��A\x07��)�d\b8�4���s��!�M�<i�NCc���7��NI2�XC�1�!�46�>B�����ƌӘ�i�t\0@J���!�P�0d�M$QS��ߏ�#��\x07��nb\r)�y�(����/�$\x1BT ��PS���:me\x07���U__��J;t�!#�E����.�0�F'\0�^ccc4�4�X̨���8\0T
C�st\f��ǐa�0\fÈ(b���H�2\fC�h4~"�a�Hx�3,1z��#���$�$\v0�h��F���y:m3����N�7��o�]�K�b�Ѻ�\rR�!�\0������]�\x1B���"\0�\0��E�3��+�(fD�H$j5�bF4������hS�1\f+��\f�)3���#p��w4w��RSxq�w���q���F��T_�A\x1B6���z'��0M�jC݆h�ɹ��\\�7�g\f0���Ȇ\r�i�\0�>�&~�	6��p"F��7b\x07�h4j�fT��iD͘U�R$U�0d��HĊ(Bة0���+��Ϸq\x07�*��9��zR��TIj��Luuuڐg�����iƢ�\ruiwB,S2c4:�M}}�kh46lXO���fD�!#޸h �"vؑn�Ѩ�D�H,jE�QUE�LӬ�eZFU�eYFD����)Ì���!�T��A'E�q�w�q��a�t���dt��:r�|�iŪҟ�#+��� ��\`-:Ɔ:Zt\0 �:�]V$b�-1\fKv����h��fE�UfU4*��T4�̪*�4ME����%+�w<#K�\b;"m�HqN���	6m�6���ݭ:�4��S��\b��봡.�st\\���mhL�bY\\�	@���P��לw?n:7���D�6uY�F�V4Ze�UU�e��E��6�iY�iYV\x1BS�TUՔh"� tc+{)�N�sr�!�p��*����E�}���\\����564�}M\x1BgxiÐa�f4f6�߹�\fѠ W��\r�\x07#�Ō ��\0@9�\x07��f�o͉�gt5�E�*5��*+��b��QU��4-�jc'��?��v����L]ג\r�9N�i�9Ag'I[I�-� �n[ʾhhJ�,]���w(��\x1B�,ˊX��6�dv�h^�VP�~Z�&��/�ol�bR���mۙ�:u�ۤc׺�mڙr�����i4�h�J�hԈFcV̌��iZ�eʲLK��x�NDR"��!+~Ύ7�	.7I|�9������F�7�t��_J�y1
������@�͝��F���\0\0����Y}�������ΛlZg_N'b�̘����ƌ��i��i���W�1%E$Ì�IQYː%�՚D�r�,�޶C�5'�[q6��bs���$m�J\0\0�|,\\�vۅ\v�n+��\x07�a�]���i���#��e��i��i�"�p\f�2M�y\x07�aC2\rj�/bFdE�(]��T���.\b�����&�TI#�^\0\0\0���_yi��_yi�8hC�=~�]�N���OEp��e&R��1\f3bD\f碣��Z�L˴"�2dѪS^2'�$\x1BamIWH�!�\0\0\0@e�\x07�mN��o�ۮ�Ϋ,;��9''�FdK1\f{�þ���E����ta3-S��Ϸ�:7�y-U��a��!\x07\0\0\0!��wo�λ�m��n}����F���!R__g���G\x1B���Ʀ[��7��e�7�1���2�*����	9�K*��g\0\0\0@�zzV�g�d+_�1b��Hc�!��Xi�\x1Bf,f�̘a��a�1Yv+�$ɴ�\f��/&�8��5�Jvȹ2�B\0\0\0n�����7�t��bF,�h�b�Hcc����h44ڭ<��\rFc��rZud�섽
(0�N�A\b�������.0\0\0\0�̫���h���1ӈ�1W��[r\x1B\x1B#�3�X�0͘aY���L�}��d����U�TI���!�\f�����M�l��\0\0��P�^��\\o�����HV�}|�C�6;������ZgF"F,�h44F�h�ш�Ujll4��*#fƌX,fD�Q+���}͐kP2Ok�:�����4^��Agzکg蠁G��{��~\0\0\0h��찗��~[3A��}\\7�49�{zdF�1g]�>�X�HԈ��Pc�#�X�e:��X����X�eɲ,�{II�f��hk���KY\\'�/�ݩ�ϸ��\0\0��u��MÎ����_\r=1�{֬YY���.�i�i:]��x�1�.k��k�;����r����� 3��{{=��<�����	\0\0\0e������]���:7����y�S]Æh��F�}�ôL�bvk�e�\f˴$˴��y:e#�����^�N�4�޽����ޣ�o\x1B��\0\0\0�L�k��N\x1B>>P�Κ5�#˖�ْ�a�4�V�x��ev�-9��V^���8�������]D�\0\0@I��+Ի���{c�˛8�ɱ,Kf|iӴ���s����W
�:���9)�\fN;�\f��\0\0�dڵ�X��|i��˗U�^�C;K�aY�a���D�1d%Zq����q���I�ZI}3�\`��\`'�\0\0\0���n��C2l�����ۙ�	4�< Y�����\v�N����_�]�� �\`�fz�!�\fV�;��\0\0\0�@C�x*��Y��F���i�a4\x1BY�Uǚ���4S���\v�0a����v�v���\f��\0\0\0�P�Tg�����|�ƹo�1��er���]���/%�S�5�:�]�0�uM�:ez�3�l\0\0\0��K�n\x07%X�����ǖ�o�)�6��I���=�.H��\x07#0|��ڨ]���\0\0�
��~��.Bk�����N� ��j0.�\0\0���\f/\rݥ

;��g\0\0\0���[�Ȱ\vQ
\0\0\0��L�4(�B\x1BA\x07\0\0\0�<�˾nf�"�\0\0\0\0����\x1B�.D1t\0\0\0�����ϳ�~�aۅ]�b!�\0\0\0\0��	I��tC�	���B�\0\0\0�����\v8�а\v[,\0\0\0��<(iv����]�b�
�\0h]~X���{����kM�2)�4cǜ��=w�f]��o�>a\0\0�R�?IC2Md� ˲�]�B#� ��+����Ќ�2N;�6o��k&O����vm;��-�]�MN|�&L��!��.RQ���\x1B=t@����>��=�tKW,֩#��k�L�*I�)�w��8�m����i��W�U)E��}*i���a$\fd���[���l\\|�XI��7�P�~�^����tL�0Q�v\x1B�a\v����Ԍ�1C~�-��
�X\0К,A\x07�_���z�f�|��|M�h�ܧ�v�~�f;u�����yZ���f���5;�|�z�9a����%�5�T_y�͙cwǾf�T0�Ȱ�TP3fLӌ�t������{�\0��?�������!gذ:�ĳ����k���� \r<\\��<�	<So�A\x1Bw�X�ݵ�l[\r_���$%\r��N5;D�ɧ%wq�[Z��RM�t���3�>�b\0\bf���-\v�����kH��O{BNM�h�39���];m�_;G7�8����)��\`Ѽ�W����ԯ����^\\��o������l^|��D Bi���G�:I/>�Ǝ9���y�k���o�."\0�tg\x07�Ȳ�ea�\b:h��~���sK����Ct���<���6\v;So����ua�*�ѿ�@]~�m�
��p�k�A�v�&N�����מ
�h\0Вu��K�a�X\b:h��e�U[�$���!��g�~=Gdkk��ͅ��e:\`����^�N�ŗ��W+��]��v���4l؈��)S&Ѫ\0�M��)�ts�.h�t�̊/�&�WW�)X?�!���i�^	{U��z�쫻�x��ܝw_���P(\x07�w���{�/\b�H\0��*�̀��
���B�A3�~�q��{�U��v����h�47���[��&L��x<g�l�/\v����<^����\0e�����[���H$��+�;v\f��\\߾��D��t��^�r���.REk׶�g��u?�\r�H\0�Ҍ��bp��]�bbxi��v��ίz��<'zo�Q���\`�<�߰�م��_E�9=ٲ$%֥���r�>��Z�W���UW�����f]��:#鮍4x�|����ve{�ͮ��Є	�י1c��\r�M�_����kS���m�u�u��\x07f��o�f̘&I��ާ��}���\x1B���O=�0abơ���+��r\x1B��}d\x07� 橌�ϑ\b:H½���.T]�:�k�} I�wϾ9��2�锁���	;�|\r<<��g�>���ɸ�S��|�r����@b�-���%�2\r<D�����?��u���É�d�̙��\0_k��fP�;��y���\v�A�n����1�����f�g;'�w�j����T���~����f�!�b}���Z�:X�\vi�wp���d3�Bn��P�I�<���V��khf�mwH�o	�����\x1B�x�%\0���v��:@KW,���V.ו׌	r�.�d��orQ>�ŵo��҆�9sf�ԑG�ٹ\x07~�c��:����(�͘1M'\fT��찝wg-�y!��ݞ0|�Y��n�q��䫕�u��'dr��+��r\x1B����J�p�[$�v���4�?z}�%c�>2W(_�\\�K.;�3ܵduL�U��O�%�<��ԑG�;�ؕ����λ�Mٔ�a�F���\x07��{\rl֪���3fLS�n[f����dG9�.2�#��k�R���yv�&M�H�ׯ\v\\��+�ԑ��R��1�������K�J|n獯�]w<���,���vm;hذ�.N~�~��s���wE������RU���u�:�a�\`��?����w2a�D��z��#K��=VR,�6(s�ݢ�rIW�]�R 蠙�=���ft������N*Y9�혌s�N8���]�+���:�즲N��2�p�}i��͜u�g\x07��\x1Bg�Z�o�>�[��~��A�q�����)S&��n
\f׾�	9��}4���R��;eڷ����#wxʴ٦�3vI�a�7��'���}�];m���>�)�M��2M�cv]�Z�޽���̙��/N>]>��z���pY�龷�CF5�y.d���]�p�={��}3gݝ�\\kjFg<ϪT�c��VJ,�6�R�\x07*�(|@�~#�ǰ\v]
t]CRÆ�F��}<�M�t��;���y�^��t�GLs�H�ӯ���|������\x1Bg$��.I{��+{��5���~P�N[��To7�ڏ��{�������I<���\x1B��/�Q�-����1�=�y_|�،�ٌ�o�|�7�8#p�u_d��v��=���?��d�M�{��,����|՝��ǅJ�^y����|�M'����{��ku��d<w/�ﱒ�\`)��@\x1B$)��~��A\b*A\x07Iu���&_u�gW���n�ŗ���C\x07h��{k��{
|,�����l����7Pc�4�2e����%�v�{���\r\x1B�������/��3xs�<O\v����z\`�1������X�h����ĉ�f}�X�E6�=ٻ�k�\x1B!��U�6���[v��W��y������-³s���N�01P��~�-���#Hh\b�{��:X�m<P���}^NPOJ�*�B�A\x07)m٭�.>�&NL5�)S&<�<5������>:��3r�����<N5�¢Eo%��������>�����t��3�ޡ�e��vm;�!����\b��3x�\r��Q�L��}TS3:��o�ܭ\r���n٭�g�3�U�	�u�����[�\r��Q*��K4x���GX�c%��Ro�2�Mٝg�3�.t�t�V��t����ڋKu�䩞�P����+�Ϊ����=-g�:7�᭷���S�����4���7��-�e����O����ڷ<�\b�C�L�~=�:�v~X������\x07�א�t\\^��}�r��h|>����z�>��nHŰ��-=;�a|�n�Z'n�qFV-�A����+��z\x1B���\x07�8���%�%iU�/5#@\`�I���LN\f�:��[2��;'�\x1B6B�z|�sL��TW����ʮ����h�i�����T�~C�L����Zcǜ������wPb�bŊ���������g޻g_�(e�\`���{���k�A#F��h�x���Ҟ��R�7�����e����GX�c%��0��@���#�I�ɒ�\x1Bv��@�AN���οA��̙j��\x073���>��C��{�.�Q��
2�N�k���\f��*�Nϭ�.�lhd�Q�a�Fdg�o߽$����bqgcǜ_���=�{m�}���P�yo)r� f6�a}��T\x07K��\x07��(I����^ҫa:,�?�,X4O���u�\voN��}���:w�I[*�G \v��_
��}��'��?�[o���6���9ϙ3[��γs�tim�{�|lֵ{�3iE��w�uw��g_,���3v����s\x07��K��[6����{��:���@K��?�Rv#�=$�a�;L�3R��N҂E����<}��̙�N�:k��ɞ��\x070(�N~�8�s|���Y]�<���/X\b?m��ի�����Q��f��v�SK��إ�����,����*�i�ڂ��]�M��\x1BD�kL�:m����{��:ؒ��@K����{�G�a�ߒ�\r��a#����\x1B���j�}���̜����}��ۘ�ް�[/]�X�}���U�S<x���wP��l�խ/�����[��qw\b-�g��������g��|u��)q�z��-�0��J��-e\x1B�&�����҉�f3��bI�\reXf\b:(��\x07����wL\fN ����;?�]��%-�+��8�Buu�1�� ���^!rP��k���R����(\f����3�����;L���?�[�.�\bkk%] {���G�AI0�H�ԌNt���]��V.Oyrq)Z7��Ю��ج���f�v��O=�ޮd�F��p�k���G]C~���y�6v�q����T��p�����/	�-Bk�[+>c ��w�ilm���x�y��v�[
����V��9#��^�~�y�����]-JѺQW�N��vE�+����{:��Kt��#Kz��\b���G1�[(
����ܥ��2�E�'P������b�~k�6�kߞn>���Xu0�ň������M���Qs����\bkS%����e�����q����S�������e�\v{����S:|�I�]���|��ʢ/�S�ή��{�(w����!I������w�Ca��ߒ�q��ae-�����U�x�5z���\x07=��?�amn��6�u�����\\a:S�l�U�\vqm���%Z�F�}D�ןx���k&Om�����~�C�����}.J>JQ�R�a�7���jjF'�JX�[I����ǌPU|a}��P\x07����z\x1B�6o.|q�[n�.���ńA\x07	��vPuu�����(��4�}���2�����~�=�����垁\x07�Bw!w*�瀸/���W�?������lg�|0�ϼP�n	��\x07��������n(�g�oI�_�����R�\`>-�+�Xh�Rn����O���\bk+%]v�[*�<;��-��K����]=�]�G7�Wsa~�����?�R�Q�����\x1Bs\v�U�G��̙j��y�M�\`ɢ��dW"�w���3_�bq�a�[�ŵoyZs��0�[)�ϰ�~�|pz���1�֝����=�Y\x07=���h��\r,�6hM�����]��lFX�Iv��d�\b:��s�}=�y잂ο�~���sK�quu�f#������uk�=��|���c�o����׳�u9\v��瓯�};=Ͽ�D��Z�b�炐��X��ͻ����ҿ�:ʚOy[��+�̳O�<w�oR_'�������nmL������ì�ݷ�:q?ז�l��������3�������i��*iY��n�\b:��[���\x07hΜ�zv����������w_����!��kk���N�8�df=����a�F4\vU�\v���������o4�����$�ei���3fL��:=��\`��!�[�|\0��k��>g�l�}=��ŵoy�Uk����u�ȣ<�]3yj�a�����j�r����}o�k0�J��Vt�"X[�$��f?�����ƧB�@K3��kN|�_���??Cқa��\f���0\f+~����.4s��<�'M�� a灙�j�m7$WW�IyNL�~=G7��vC��]Ϛ}��H���l����N���PVG�����.iv�|\r�ϻ�}����w@���{�����O�tQ����
2x�&�����u�5c<;��r�]��Q��ۯV.�%���y��S~��.H�~Z��+QX�cXup��w�<ζEv��{�9A�|���n��T�=y����gXo�+�8'R����[��&N���ܤI���.�霝ŵo��k�xB�$M8����Ԝ:�38�ŗ��3o�D���遙�zέ;���GR�-'s���}�F�\`�<����5s惪��Ӭ[S���t������D�ԑG���55�S�_�8�ĳ=��\x1B_8��[A���%ze��ze��z\`����޺���ͺ�\r9�\\�n%��\\r�Y�Vω�\r<��\vҌӊv-�J��Fܲ[/O�1c�f��mٽ��f�Tm�uϢ��l�ݨh���Z�{f�>2��,#�Vv�2>�>"8iR���̙&��9;�;m�kҮ\v���\r��8�{��7����Ե��|՝����ݠ��ݠk&OU�����8|�r�>��͎�\x1B6B'{F��\f��(�������tƨs��.�=C	/]�X�}�L/��/���?ޠ-��Ruu�DYOy���<U?�_��<�u��#5a�DO��\x1B_�a�F���\x074�w>��>x�\r\x1B����۲[/�u�ÞsS&M�Ho�1W\x07t�~��@O8�a�7z���>�k&O���=�+����l^55�u̐_\x07�
����V�wP��f'�O�01��� ���Iz��\`#cU���ǰ���cN�{ʔIZ��-|��Ͷ�u�����y�e\x1B6B\x07\f8�3�I�?�\\���\x07Z�W���ʫ.�,��:tX�nݺ+�.wkB�AJ�:I=��)7\\�,�$��\bb��!:���\x07>B�e�^�|՝���k=?�A�?l�\b����i[��vڢَEm��˸뎇�s�q�=�ęG�AG�����;�\f�A>�s�\\���/����G����&�����>g���'g���L�0Q�v\x1B��������r���@�0�]K��F�ݳ���<ճnA�YS3Z��87�tɔb\x1B�~�%Y��ۍ'O���,B�O'�\\s�_�:�ֲ@�AZ}���=w<�W�?��a6R�@�e�^����t�AOm\x07�ٱ����x�\r\x1B��O<�s��!'i�ʯ
~2�:�}���~�'N�6��ջg_�p�}�=�f]Sɵ$l'^���w�f]�e}�:�����9�3Y��>@,Y��\x07�h	��è�\x07\f8Rw��p҃[��|㌌]b3)�6�A�@K��c�][�d۠ӟs��vظӲ�����[DRTv�i+鏒.H��\x07^=v{PBN�II�h8���$FT�w�ȗӯ:��	�٦��jQX\\����ae�nw�\x07��\x07���J�Ϫ�=I�}����U���b���v��\0��ڂ�����Ԍ��}���
��#��1�:�\`�<}��מ�dG�m��mYR�e*�6���W�o�����n��m��f�v\x1B�\x1B�k�h���F\x1B���k��ٶm�X�6m�6m�Z�HԊD��1�������\x1Bo?�^�g�eVW��֦]�ۮ]���m�5n�n���ڵo����G>��ߏ\r�~g�v쌚__�ԋ���e�g�|��%�$5�n���t�,I�,�*�7��aK�>��b˲��g~�y��\0\0�V�5��,|��_�-��G=t�%��8U�\b:�c�5\0\0\0�Ȗ}Z�����?yuu�eN�An\b:\0\0\0@��~M�[n�|�����\x07�~���Z9��w_v�[;�\0\0\0P$�ׯm?����\r9:t��^}��n�\bk�\f�8�0��\fð�����5�{	:\0\0\0@����3�,_�l�ӟs���|����]��q�a\v$=,����{�0���H�\0\0\0�\`�^>����;��g�v��\f>�Ͱ�6�0.��������цa,p��t\0\0\0�[��þ�|򱃂N��C�~����.w��!�݂󈤳,�2�7I'�_s�[R�e��\0\0\0�O?��0��'\f:}uu�忩�\`F��n�Jr.�����,�:ɲ�fW��,�˲N�t��\r�8T���\0\0\0�\0bf�j���޹���]��۷o_w��<�����]���׵����̮���j�nN����\x1B\f���::�X��c>�ѲÎr>��˲�7\f�$�����<A\x07\0\0\0(��_u����\x07
9��~��v������˝��$�-�|��kN
r�e=b��tNϡ]�\0\0\0��X�߷w\\�fu�����M�,�?9��}�NW�0�'�\0\0\0\0yZ�|�V���a��\f\\����ሠ\0\0\0�c��l�x�{��.G�O6]�|���st\0\0\0���Ӻ\v��S��w�q�����6�fu��\x1B��hԬ�VY�h�eY�"F4��\0/�:K�M�i��K�A�\0������s�,+��\b�)�.k��2���y�\0\0\0 \x07�\bk��\r� ӷo�~��㯚ҹ��?�h���~��˵5')�\0\0\0��lFXk߾��\vΟxC�N��rjk�\r2�3t���枦5���t\0\0\0�,e;����?��v}W亼W_�\x1Bd��>�TD�qt\0\0\0�,,~���FX;�W'������.o�{�j�Ҍ����\r9��NB\v<?��\b:\0\0\0@@���M����#�r�a�9\`�#��g��?� ��R���먨V�\0\0\0��/?���k.
<�ZϞ�~u��G<��2��\`�^xaN�I��l�[Ew[�\b:\0\0\0@F���V�t�ĝ?���@#��k׮�SϾ�}���s]���~���\x07�~f�����I��nkA\x07\0\0\0��[�߮o���@#�UU���>�э�m�!��}�����QA�͑���t��ta�"���\0\0\0��n����Oam�]w]ڵ�f+s]���>�&�4JZ��\v���&�rZs$�*�\0\0\0\0-�\v�<��w�x��^���r��{~�˲V��V/�{B7�49��}&{�5w�I֊S1�A�P0�k�ҙg��y�_��k���he�o�f̘&I�0a��v�\0�\`j?y�����<��[t�~׾�/�f��|�o��R�?X���\v8��A�r5o�IڢSI�9A\x07@���7�=���\vt��#�.\0���߰V\r�m��WCc��\x1B7��a���o��m۪*�F�6m�D�De������8o�,��o������ kοE�HvkNڀS�8G\x07@A���\x1BM��fϿ�ҿ
��+������W�?]���3>\x1B\0h��G���7�|h�5�-*�>_�T���9�B��"[s$��y��I��3g�׾v�\0\0\b��޶�s�?x�I��nY)���� ����Tlȑ\b:\0
��rs�3T]�'�8Y�6\0\0Z���u�O��NY��#I�JX���r8/'\r���-�}Ks�̖$UW����׈g$^�z�\r��/�o\0Je�~��5����SU��na\x07\0��λ�w�1cZ�,�򥤜FX�A���%}����v��J9�\0(\0w��q�\rW���o��i�\\8�A	�P�~�.\0ĲO�t�t��;d��%e5�Z��}N�OJ�=��0ҕr$Zt\0��?\bA��쀳e�^6lD��BJ\0\0@!}�򳍧�ebu��w�q�u�������-�-IkU���,����,#~�6�y���\0yqB0l�\b���7�����Hܟ3g���Xvq\0��P�>�ē�>�\bk[l�=vԑ�s�����.�5I+�>���o�
9�F�5\0yq�����\0�k���_��}T[�D����� \0@)F�1bD�H$�D"�H$�F���>vOߗ^z~���Ӥ�{{٧�kL�V�����Ë����-&;���=�������Jr?�s�$\b:\0r��@�~���|�vm;��kʔI��'�xHC9I��f3bg��������i�^�̙z^���3F��ͺvS��}
�ܥ+�/���K�6{m��ճ���^K�/X4O�7�M亾�u{��SM�h�ܧ�vۥ��vڢ��oi�'��F��TU��UU�il�f��F��7�k۾��������t>���7w��g˾�zE�ɗHZ.i�졧7�9uj
=���H�/�i��O�I�� g�A\bƎ9?�ΠsΎ$��.	<(����$R2�vL%�����|�r�����f̘�r���%��<D�����-YW^3&��<5�Y}�r�����B���\\�	&j�QE�l�.z=�YL�01������S.����ǎ9_\x07<V[v�x��<�N���6<0�G��?����Q˲XD��g�\f7�y�I�'3���� �pH��z�����$/��+a=g�k��	�\x07�\r9~s��֩#�ҳs�y�\v��	�\x07��)��2e�n��9����э�]�1��M���0|P�(W��y��0�aȐa�g_~��/�_xL��O>��O��ۆ�웑n�3��3���3s	�3m\rh��� �\x07I�bq�AG'��Ϝ��N>�쬎ʷ�Z�nU��ŵo����<�&�&]����e�*���-�7�&�x��U��͆u^\\�����\x1B��9s�������s����Z�\\�\\vV�-�5������5�;ze��ͺ\x07^|�؜[X�����o�����ۯ�t���\r�qԩ���s�Y�Lat\0��=\b��\x07�v��v��y�����Ag�Q�vdSuC*���׾�	9��}4���Rv��[���V�}���5e�$m�i����i���眩\v���_\f8D��<*����n�/�y_!?�l����f!g��u±g�<\x07�G�G��C�ה\x1B.K�7�ϲ��'�֣�aC�3sf�����\x07�\x07�b��\rcF��W;��ܐ�⒵̘��rC�)��Ț����i\v�ԌN<~��魦\vP]�:=��=����}t�u�:e�n�4~�d���.�d�~X�"�o�1Ws�����Ct�+�\\���Ww���&���/��1J�fκ�r��<U�vN���V��Wݩ��>����/��>O\0�{iޓ������A��zҭ�v۬G>?XV�ϣ�\b:\0��� �hX{��e�~m�����֒��p�'�M��άG���K=�)�{��@�s�{�o.�j�}������bZ�h^���m5ڲ[/M��N�sO�~ �������o���ŗ��j��]��	vd*�d�鸟��uA\x07@V���Ǿ���\\SǱp��a�J ��%q�9�[Ԯm\x075dx��)��h�L�5�jk�nE*�W^{&q����N8����e�^�f����3�eu!�r�<dg�W��_�w\v:���^v�/�Zt��\fL�}��
�� +�A\b���Nع��cƌi-~gqq�[��V�;*�y��7�Ӫ���y�ޗ�2{l���񏫾-�'��W+�{8cԹy]���{\r��l�����	���ｪSs����Ӣ/멧��<��w��Q�^�f��R�nh�)2����\x07!1"����k�Hқo�\r{u�Z�E����]���w�AM�^�q��\r\x1B��2�t��^t�����a�l�k������Oj!+��(\x07/�:K�?�4-]��.�h��|�0�"I�;��>����i��?�سA������(�������g��z���:>8=�UJ����~x{��!���ܺw�����q�޽�s^V����ܟc�\v�f�z���_��.�_g��\\>O�����i�l����K?�g�_�j�6߼[�)'�7�$�\bk_�e�Y~��M֕M"�A\x07@\`�A\bjjF������v�׾�j���n�ﺔ�M�6}^s����
�٦���\b
��9"0J��ݽ��|�Ų��)��h��~�ӯҍ7MN��e��/��A�?� ��]~����գ��L���z���H�ՕS��o�Ap\0��\x07!p���\r�P���������z}���R)��6�+H�FK��7��\\�ڵ��a�F$B�O�׆��\0Ҩk�I��~Eƀ���G���G4~�%��g\x07�W��KR��'N��.;�le�i߯\r���[�a&����y:EE��{���W�����nА��[\\נ���E_Ə��mq�]h���ݪ���;%�_�:��T�W���Ǐ�ҥ�~���3Y�z�~��_j��vnz�~�W_��K?̫|��q��}�>$��\b��}4�d+$5�\x1Bt�[ґ�q��\b:\0qBPhｿ �k���\r�8��sl׮}�EPb��wО���*�8��b�����s\`���⫳��\vs�LZ��!'U���� #� ���K�jqA��F�.e��5��[_���9���\f@�Ү��:�wWHRQCK�.���w��}�A����O=�(��Z��[t��?�Ht[+:���܃\f<D�_|[��|e�Ӻ������O?e�z��\x1B��&�[*��Y1�?���&�\vv&�v��������\\'��s�N��[�;o��y�ҥKcM͘����<�{���S]pѨ��/P󐓮E�nkE¨k\0��B�5-�A	���c)�C�w�\x07:G>�>�
�9�կ��q��a�*�\fڵ�X�\r��&�Zz�޾|g��~�E��,��]pѨ�]��$-�Ԡ�-:��J�� -� �������PM���㩷�袏����w?|vqZ�a�F$�\x07�Pj���b�o\0�q��C����t�!�K����������n�閁�i��_�����~}��l�/zY��Aǹ%�F�� �\0H�=\bA���I�?D��\v煽�;��K�����ze����������u�-.�K߾{%�*��~�����:\0Z��o�I�SWM�Q�{o_����7�~�߾�/i�f��L�~��g���?��1����4��|#�5yCN���V<�� %� �^;'��w���>��]"IZ�WZԠ�;푸?s�z�iy�G���E���zT�_C�Q��n��o.����\\W�N>8=�x��+���������O��}<�D\va��%?|�释F��D��F#�F��#�D��ǽ�.�Nң���m�q��/J�)���܃TW�����h׶��;n��L�$�0a������KO���s+���5cƴ��=��7��+��=�j��!��<��[���N�\\8/����,�rԥS7\r;v��r��^��f?�h�!�{��g��O˾vN����ƵsJ��k\0��B0b�E9j�o��ǋޛ�}?���:���k�A&LL<�1c�,ʭ{ݬ'���?x����'��S��m2G\r��_[�D��szN��j���h}R��,׮���E�����;����������g���\\�M7�4�?&i��֜zyCN�R��C�)>�������u@�sJ�wϾ��՟x⡔�pt��9q��O�?�=����(�����h��Y-w��{<#��w�[�|?�L��\x1B�����v�^��tV��j�r]r�Y��N?��%��\0�B�ͷ�/��i��k���k/.�c����Nܞ���^{q��:rh�E�)��j
9� \bA\x07@R�A\b�\r\x1BQ�k�$���kk��]_�rt�b���\x1B	\0\0�\0IDAT3�e������v�B�L��y�ԑGn�y\`歉�y�=�C�~��Y�*��6��Sǫ��O��ŗ��3o\r48��ڷt�egy��M�xm���\b���o��z��9q�ҩ[��� i����\r9�.J��p��f����H1�|/��+�=�4\f�\x07\x07�����x�ť)����p�&L��	,獯Ѱa#����X�������i�=�xv�\x07�aCS��2W�~�At���&_u�'�L��M��]3y�zl�]��������?�xZ�$i�:|�Ial\0*�ǒ�����;�8��rBF�Ќ{�y)�vm;h���͜��N>��f�HN�'�NoP���Qj߾�&M�(��̙����Ct�+
:<w!����e�^�|՝���k=a:Y�J��S[��|\0*�����􆚇\x1B�;�rBB������A\bJ5t��7���CF5�n������\`�"�(fA����\x07���[�ֳ�?�U �8��V����g\x1BԖ�z��o��\x07=�U����c�����( ��d����\\܁ƹI�!'D����~�J���\vҽ���f�W���^\x07\0(��+�/��ŗ��i�pL�x�6nߑ��\0�󁒅����ڹO?����\0I�1�*����#9�����\x1B}7w��O�>��VHzG�s"�T�a&c��\b9aIբ×\0i���W�{������]���	���\0i̐�^v�Y���NM�	�/��.��z��2w��O�\0\0\0���;c�^�&�}� ��M������d-:|)\0\0\0('�FA��jP�<����7pZ�*˲,�0$�<\x07_\0\0\0ʅ������T!'Y�q��|愛�ߢ��*\0\0\0�K7ZZ�����nZ�t�K��\0\0�$;�F){_$дZ��d#H\0\0\0\0����]Ԓ��crZ���q��\0\0\0�V��u-�-1=!���$y�\0\0\0�� �9����d-:|�\0\0\0('�Hu�����8�*�]����o�.?\0\0\0*��i����ܒ��H������e����'��.?\0\0\0*���~d���dA'Y�AHw��3�y��]~\0\0\0T��d�o�t�\r<�2�.�,��:ݛ�.�D\v�{5�u\0\0\0@��k�I��G�nk������_'�4;O���C"�$9Oǔ�1&_��k�)��\0\0\0@y~��Z��� ������,�$\x1B�\0e ���Of��ҥ�������\0\0\0��?�@��A&����$ջn��kt[+S��;-:�)C�5I������9a�\v\0\0\0����~�?^>6����7u��y:t[+C�����z���х8KO=���ק�p�(�g�<P����o?��
�e�\x1BIOIڠ�-:��._\\2���0\fC�s�H�TR��NAfxکghİ�եS��׭\f�F���(��Ry��Y�l��l��I��}�\r���w�q��#Ztʇ��t��H�6TRVcI�w���ف��c�ױ\f4}G����%�]p\0�P���@].�W����\v5��G��\vY�&�_I��7�87'丯�c�nke'S�q������v�{o���\x1B���n��\x1Bu\b{}[��ߓ��w��ݨhI��@y�.��/��_��g=����I���Lv�q\x07w�q��X�9��H�}��������.4\0\0\0��Œ�W�V��9�a�	9�'��u���K����\0\0\0��*I����>'�	9I��C�)OF���hjcuwa�Sv�N��	\0\0\0��Bң��;�����R�.ke�\bp�?��\x1B\x1B\0\0\0Z����QS�iL�n\b9$S�5���g�{I�H��
\0\0\0�b-�t��\x07�4��3\0A���\b9$c�NbBoˎ�+�_$���\0\0\0�"��t����4�Z,��i�ivaPBN�\vt��a�xJ:G�Qa�\0\0\0�����C�~TӠ�P��d��SA�
:Rʰ�>���c%(iI����\0\0\0h�VK����$=#�]yC��棨��O� �T���N⍩�;�8������Q���.�(wQIU�� I�>�U�9V�Q����'��q�\r��~-{��O���~.i�\f�|C�wjڐ4J�)��������R�1�]�p�\x1B�:�ߛ�w�V��F-Y�[Sͯ��Z�����]$����!�>w�4_�"�}ҝ��4:C9���oy�s;��avW�F������\r�M�&��D�wT��hi����d��S�Gɮ{�puyI�d��7$�W���_dX�zI��8uyU�3���?���i^#�T��\\�hY�;�J�ܜ�f|�մC-nRq\x07E�F����d�\x1B�{$��wc�lD����'ṛtO�t��d���ވ�6��M�r�'����!_��k�xy�*�X��2;뺹2o�>����?�\f��\`�@�d���I,�N�^�{Hz_�E�wr��9*��=�/%�G��� �i�ۂ#��>�똳�\r�6˰�7]�N�%�T�/�}��>�^��Iz]��*|]�%i\x07١e���˙.%�F�6��uٿ/�4��׉�S�r:R�M���4������\x1B���璶�t�썩��U|����p�ۨ�\r�ߓ,7-�\`G[L�<��U��������9�ې:�J��h�7�15��1;E\b[��,ICe	#�Rv�y��k}�u�g�K&U}n�T+�E']}v��qM�N���Q�ђ�����Ͱ��:�K]^���[Ⱥ�_�!(ۺ��os)�r��!�Z��;���W�q�\b<R����? �7:I��_�Rv���nL��\x1BU�|�5U��\x1BFl\x07��,��h�7l�6��6�A���i��"�$���C�d��S���KũS��g�:���t��Y��h���6w��>\\��*������Ů�V�Ǆ\x1B4S���p�a�B���C4�<��\r�?���>��"�Ȍ{�g�n2w6f��n����\x1B.g��&w�b���?��XG�w�,7�N�����N�>G$����p���6����9��T�܃�g���l�t��#�4Z�Lu�x״�K���n�R���t��b���#� ���TpMc��H��}����)�o�w�Ǳ��V|z�qT�#H�&wgzS�7lA6�N�3Ӽ�j>A���-�\0���>o+� �4�Kz$~���9H��t"o����\bk��R��e�˻��z�� �\0I�⏩�E��d�hA'�@����T�(��{��q��su�餦&�5mT�G��V�74N�1�\0�ڈ�juI�r\rb�W�\x1B��\x1BR��Pj��$o;D��
�>;�ϩ>���A�FY\bP�G%y�ɲG),���N.�������?\v�#���ߐ�Gv9B� ~\x07�n������\f�߰�o���\v)@}�J:=�[�I�W�g�E\bP���>@��M�5��@\v@�i9�\x1BRgc��/���j
;C�o&woPG��|��N\\�\x1B$�3�Ҥ�ˇ��\f�x��!Նt;%?b�8@ލf�$��}���P8��s��wCu�%��~�g�eHW�G�y�~��?C]BF�	��i<Y��*%���V-{��}3���9��n�P�s/yO\\Nf���@���_J�a6���\f����TG���j��y��Q�FlP��JW�Gx�/D}Z�tu��\0�?D�e t��d8�1*�$����G|:�F3Uw�T'=�Q��>o*ﵰRi/�h1�\bA��|\\�Ym*�;*u\bA'|�\riD��/�#��1����d'>��F��(�T�9݉�~���\f�-U]�ԥ܍�\f���.Ӹ�A�%i�,�3Hލe��G�.RƑ#�0R��TCJ����!j��@8
U�wu\bA'Nt�J:#�Yn-�����d\x1BS��>��'.�)�3PR��/���v��+�2�N��G����_�0�A�yJ�!e�
G��d�=$u�\bC���M�5�\0��\f���Sb)��^Pp�f��싈��';�D9P �s��V*\x1BI�'�3P��
6\b�_W٭:�e ������_��1M5$&G���HU��)� ~�D}J-]]ΕӪC]J���Qg㶛����@��#InF�٨�KU�#
v-�T���C�g�T�����6u(9�N	ś�=Oɻ��v�M%�a�\rk�k\0� @}���e��3,��\f�)@]>\\���2,��\fA��$��:K\\���+ɔd�Xv���lD�쥪φ�����'�|�3P\\Ů˿��@�tl6D�\rB��\v�-;��f���#E@~����ʯ�����_��\f�B�����C\v0o�2�Nx�\x1B��\v8��$�\\7���c�\0����
8���>��˿)༩�@�tZ�_�>�P��(�A�ƴQM\x1B�t\x1BT���$�����\\� %�g��,��Ŷ�/�M]J������������1m��1uoPSE��\x1Bw}�������@���\bI�
<�#E]J��.K�FtD���J�O�y�H����7��J�A�D�9P(N]Ju�6�<�HZ���C$��(�Lu��\0�X���}E]J���F�$�?'�I���I�H����/d��_��\x1BT��#6�@n�uh[�Gl�>�t��������$���_��\f��.��{�}�u��\0��@҅���=�A��3u(�Nx�\r�X�s���33J�2�\x1B�LLI�%�+i���\\����&rwSy�#G\0r�ԣ_��[-�/������d>�H�]����^swy�>��ԡK\\ϭ�}\0�0e_��"�.�z�$Q��� 蔐eY�#4G�>j�Z�ٲ����\r�d�j:�OI#%=��\r��\x1BU �$�ٔ}�W��.iw٭�N�\vr��]��+�@�u���n����P��<%�˝d�����d��ە_]��4Uv]�I�^�.EG�	�%�tI�'�Z���4
�3bZ������?������\\�L�<�.��X�C�2�-8�%}/o}z�_���t���%\r�(&Kv�Y$�.OP���ò���.%Qv*���:_�r�CGF�ݰ
t�z����BN_�͕|T�rho�eG�p��I�O��sУ����IRy�g�g	����{Bŭ�Kj+�2Pt��,�2\fÐ�X����ݡ&>�\r���lX�˻�uoP%�ƛ\r��,�s��()_]�Aů�?��\fA'�\r����/\b�lH�nܬ$7w?_3�c��ِ9�>偺\f��N\b�\x1BR�pW;6|�|���2��_u#�|�,7���Z^E��\`�"2�\`��>'[f6�YʭN�?;�t
���2��QQ������\0��� ����������[6����j~�#U�\x1B��������N��,Q��e��E
���\bX�%�r���P��A�)�4���h�7�͎֤)S�#<�V7����1J��tϵ��RI����V��6b]�
[��9"�k}N�� �n9���Q�\b�K��d�L]nB=.�N�RlH�4�'�Ɛ=s\v\0"I�g��g�#/�t�$[F�r�G�q����E.י���w/ý�J?l�\r5�.����.;�%������T;AA��3ȶN\x1B�NgB]�B���|���ˤ.�F=	A'G��f:R���t�mԲݘ=j��+ݲ��l�T%+�{��Йj=+���*��F�qNĭ��k�s�%�� �ͷ>�?�lZj���:�]O�r\0E����J�˙����e�q�\b:YJ�1\r������|7��6j�ǅ
:��%�x�ژ�t�Ӻ�q-ùUr3���~��K+b�Zĺ�<�K}N��|�sН�|�s��Y����S~�u9�"�c�J�˙��̛���8�,�a�\bx?ٿ����E㷠A�yO�w?꺹���W$gCU���3o��\b�{y���Ɇ�Lt��fZf�#D�ｆ�\x1B�J�jCj%y.���u�Z��~��^d�ݥP�9�vęVʽ>��9�./��̨�I����W�u9�2���P�C@�	(ɐ��6��Z)�G9��lΗIv�oP�\r���|���y<�dy�ky�\b:�>k����%ۀ��3���;1\f�(�\rk	�{�l�s�#�Ů���.��g�g4�X�N\x07E]v)Q=vO[�u9�d-:��Ԩ�%F�	 �5Y�δQM�q����3�)�Q�������t-���l�9�IM�Jͯ��,�R�=;����k��y���9��/�V��)���%�W\x1B��e)y}��7.�S��-���g�g�N'�A���.���K��L�u9\b�qH\b:�6��6��4��w_I\0U)�Q�T\x1BS��Խ�K�1uuJǽѵ\\�v6��A'�2��$��YN���L�~��6���~�Z����uYJ^����>\x07َ8;G��g�g�M���\f�^��:M]�)q=�����6K��d��!"褑a���$�T\x1BX%��Y��oL3������#NU��{�lXSmL�i�qo�c�n��Z^�����9}���k���Jb�x�n��|?�=�����Z통�uY�o稐�9�v�]�s���ur����N7G]N"�z,Q���c�rr�����B�\rj��S�E��oX�����G���O����������<�ꈕ䭬���uȴ��y9M�N��Jۈ��?��߰:���Jͯ��ު6�!�e����lO\`Χ>�?�l�c�N�G]Vh�X�.gs�,u95�qH\b:Idؠ�7�Q%ߠ�;z$5�\`���ͨk�4�lFv�o]�,��-ǽ\\)y�I�\\�Qג}n��V�+U��r��s6����o=sw�hUG�B�����2RS��s6#�[���\x07]�d�uګ��r��ؿ�J��A��}���&_��B���b��?���葒��Y��oL�9"��\\�Fv���:AZt�\x1B0ӷ,g��n�N�1\r��1�ϳ�7���;�Q$�������L��[���-�>�[T���uȴ\\g�i/�r\\��ؿ�J���DD]N�z�t\\�ܠ�ύi+����:��I6����^�޷��I��[����mC����\b���zn'�k�e����){#��Z��{��LMֆ�/�|�
�AR?��T��۟�z���zIk��&;��j��n��h�G���]d����6V�>��"��u/g�\0��"�~�>G��>KR�>+^�Lu���=�i/�;���]�ݟIY��<�qDv=v~����79Q����Z���=�.g�_��Ȯ�Q��F�I/Ն���MRw�\0!9�Q �q����\x07}��De碌�KZ%i���l7���]j-�y���I�6�6S���Q���ǝ���d���մ�TIu9�orWٿɛ��\\\b������j��+%��ʪ�%EЉ��ȑ�A�&i\x07I��.{��v���t�����n�w���7�H�7������Z��,��f�[1;g� dB�.����Me\x07���<�HeP�s�M�TR/5��@�P�\v�_�?�7�HeP�[�Nr�6�N���v;FŐ�r\x07y�s6�_������Opt�wo�Ej��A���Nv��a��Q�����%}+;�4�|�r���v��7\v��e��\\<ew9�V�or�ʳ�����G�����F[�ޠ���4��>�������N�7��F�;��.w�ݧ|���[AB��(c�ˮ��d��w_�Dj�u9���N���ɥD].��eL�Tv�N���-E��?+I�f�%�&6�(/�%�"���t#�G1��Z�du����E�Ayi+�+ugyG+����7���MFyi/����CA�i��ȑ��6�w�r�wÚj�vc�:
\x1B�Tu���v�P����7�T���Z�2�ɨT�����:�?�dG�z�\r*ʟ�a�R�\rj�\rl���.w��"\v���eN�s�b�r�����o2ʟ;촺zܒpd�I�^:I��u��v�z��hZ�+�e�2MS13��_}U˗/K��޽��V[m�H$�H$����)��MU��UUjӦJ�h�"ш���"���H$YdY����[�^�*�2;w颶m�ؗ�Dd�"�!#Q4U$b�0"������\0C�͘��\\��}݇��ݱp_�9��Թ�R���r\x1B���w�qr�u��?�S�3�d�E�J¡+V�KQ	Y�U�u��'�(��z���-"AT0FP9����!�df������S�]]]�U=}U�|޼�5W�I>O��y�z
\x07b���̙�p����u��<�|�E,X�P��M�2{�O����k>goo/&L��<�̃�˗/\x1B�]����(��܍Y�'�Q}͖Ęef��'��O.�;s�q,t�����ə9s�~�tء8��C�z�mDm�Fa����A\\���b\v�Ï8��+����׋��>�����c�0����c1v�X�3=�=��r���<��c����⥕/�|�]w�\r�&M��9�����AOO��}���AoO�\\V.\x07)E������-w헯��5k�����[o#����j��T�vÚ� ò<\x07��;��^|	yӛp��bܸ�u���<���_�����7|p��l�E�|������׋׾���s
\r\fl��㑿������k��r���)�Q��;,.���x�a�b�9�1��rG\\��k���}�K��¨.tB�/�{��DWQ��\v��̳�QCJ�lӦO�qӧ���g��������I��]kg�s��niY���+��d����ŗ��.<ӦO���!\0�\x1B7�\f�;��ۅ����{c=\x07I\`:.��?�>�1��.��,S����/��Nȩ0݌.�qڰ�/�7�y���X3g�����G����X�P*�?g_|��o�/\\��.LR�u+��N�g9�4���|\v.��gx\`D�4m�4\\����'7�R�ݼ��ݘ��Ե�&��̙��eJ�iӧ��/_�����z�����b�c��יH0�5s�,�4����q��;����s�4	�B|���D�������#ᔵ��|\v�;����D�p���ԓ���8�r��,\x07_�.H�eo��,S78��'Փ�~�YFݔ�T\`�S���[�2�M��Y�gv��%v����3���5<��a\r��D+��ȡnSg�39�sڳ�O�#����op�L]�㏩gdǟ��85X�y�H&#A��W������>��on�M�z���7��';v��G/��Eu��?���$�N����mY�^�X$8_��/\\S�"@Dip�{O¼s�K��$Tfٓ�wܨ^����g �ͱ���?p�RM{J)�(�(�(G(�D=	�5$ ��PZZ\v�~UJ	�!�v�Q��q��6�/�lq��Bh��a�J��c	��P�Ь�!�LՉ�|��I'�)���?'�1��*/u�\0>t��Mͱ',�:�Ψ�yv�J��sBi��]x��ͯ�,C��\r���)�޹	�fΜ��}��YΦ�e����$�����~���ƨ�W." �Ƅ��;���:��:NJ���68�RJ��['^��s�M:����֡rQC����O�de�L�r<m�4�=��$���_S�����\x07�;�ƍk���
�r2i��e��<ɦ�HI��EfGtbFC�N�0�M�6��z���m���W�(�\b�hzw��Zkh�,mz��#��8��Z	�6�g��9E\bm�k\\�LO�rl���E��T�qT�3TJ	�q�c;"�S�[H[\b)�P�RCK��&����-������WlX���t�	'$�	.%�֕\\�8�ջJ����y�I�hz�=yN��53ώm'ȳf�c�9��~ϻp���۬'�wi�r�>y\x07ļΣ�>�Y��D�����M�YG���(S�NDCU���Ktpt�������Xl�kw{\`۶�n�S-\0\bG)XJ�{%%��\b�Q�q��Ii�BA�\\N\v�$��"+�ZkQ,�B��Kk\r�\x07�j�PJCk�q!�E�Bk!t��o��iD�h�Ԃ4��,�?���\0�Ty��5����	�w-m\\�t�\x1B�l֓d�f�3�@ydZ�	\0S�g�]wiz�=ayN2���^���#q�)���Ҝ���'٨ٚ�O��>��p�[�c����,�Hs��c��}r��D�s����a둏C�t�=f͂��M�cSǶ��i;�{M���B@H\roޯ�Jki��U:������ضm.�\x1B��pG*�$�QZC)\r����
\rǱ��H�,\v��R*��6�eYʛ_lY��r�NF�Q�O+��RZ�kh�����UjE�pږ��/��ES.N6�����}���iI�=�yI�
����ʳ��a�\f1�5�8�\x000����� ��,��{��wޙY�0��R��S�77n����ii����\v���T�|/C�	�9�!�Q���������G)���r�,��P,H��Gt�Rn#(�TRj��c�an�X���aaYRZ9)�5�R�vBH�?>Ә*�������i>dQ\0�,��\\�q%��ڲ��ʣi���Z��p\x1BF�H�1����x�,��6�qMШ&�M#̱���<G�Z�$Ǟ�<;��g��hf����P�\\C7�8���{��'"&˓�La�]�rmݐ��bO�:ue�Ә�_������>�.bph���I+-��pG\vEQ(,�ul���J)K8
�p��s,�qrŢ���S(�U�A\b	�h�QJZ���Rh��RZ\v�v�m�R�ڍ��9�J�s���R�!�QVO��E@X9KK!$\0\b���4H\b�\b�{˄�	�RKK�F�md���
�2�$�r��f6��lT����A��r�E$�Q-ɱ',�J9���jLM�3\0�gǝ��<GK{�;����'��,���x����u�N�A�ի\x1B��J���w��L�E\x1B�[�{�Ͱ6�\x07e�X�������GY�\r)��Gٶm�U(�-+g��3��E��,˒�1���!����-mK9��ױmQ(!���H���%u.��J)KJ)ۆ��YjD�(�1�B�޳B\vhH)!��V��BHmYR\vaz���:���|>��\x009+���P�jX����߼stj:vkr�	˳��)��G��%��b�k\`�c?�L�=�rv0ˣSW:\rjش��������]>�3)\vؾ}{�ߜ��V�#Ǒ�B�RJŎ��m��������*Z�%\vE+�+�,�RB+�EO�-,�RҲ�%% P�5rW��cK�qj>oѱM��RR\b��t۶!�,KʜeI\b���԰��^#)�����I)��,-��%�����r���r�ql�Ŝ��9\r@�Waz��ctx
LC��������\v�Z�cOH�;���9A�iy�ֱy�mG2����2�O�0˙�,�^]S����)J��2���Z0'>�k��b����oT��'�^#ۜ�ۘjh˱�r�-PBY���R:���JH���ڋ],J+g)�\r��ȹ�Ff����V������/R*�@H˲ l[X�r
BH!��Z��?*\x1B\0)e�1\`����BBJ����s�T��ӹ�9��N�.5�R[:���'�9�:���c۶[�cOX�mێ?82����gwj�����\0s\\)��d��=�������A�uҢ���%mX�a�<j��Y,[3u��ƾJ9Ҷ���8��TN�'G
)u�hk!��z(�9�2���,Z�\fɚ�Կ\\�YƲ���5rY(\f[�0�#�R
�(��ʒ���ۘ��?6�sK��4\0�v\x1BU˒ʲ��\\.�\v��s���R�|O^�%lK�������z{{�R��Y9���э\rk�r��y��c�Tk�����q���V)%��gh��<m�9s\\���>��,w?fytK}�Ѡ�{|��iՍ��\`C�<\v@�7�}V4��7����Qf8[k@\bh)e�vNZRYŢ*��J8���U٘�>[��%�r���\b�EY,����#��BH��0��LOɨ�1��|����R(!$�4��%����{zz�b�������ɫ�㈞|N�{z�\\�|�\f�]װ�0��9��Ft�R-ɱ',ω�������g\0".ϖe1�1���bT�=�r�0ˣO�\v����E9�-�q�o<i���z�G��P��l�|\`whZ���mۑZ�$����vN[Z��.\rKڬ���m;N.g))�lW>��E�N0�cۢP(J�'�ʏ%���2�Qf�>Rf��\b��5���Ϧ��R
-��eYJ\b�-KjӸ�t�P�zz򎹶��䬢rz{�R�A���Z!�aM��8x��e�f���$Ǟ�<۶����7ݥYy�۶d�}s\\�5�d�ܽ�eR\\���\r6���ߠ�QٸF\r�����C��-��ր��|��se\0�::���RJ9�R��(Ǳ,i;Z\b�}-��RH���>a�\x1B"w��;GGڎ]�F\0��\f���B�k1��\x07f|h�Uz�޻B@
Q��e��Q��\`)meN|td�PT==y����(���
Z+���u�9A�AHÚ��6�8jE��9V�%9��<�NS��ך��-B���F{����m��a���L�-t|������߈�?�po;\0��\rd�{�a��'��\`h�5k����tWYy��f����V�<488^J����RI!˲iIGJ�H!���r����Uo>�R�\x07Zo��VA��.\0lX�~&���w���B����@��	{�cƎݚ��'M�8q�W����XJ-eQ[���m[�r9'gY�q��4\x07\0�ҎR
�\x1B��BA
��^�7�#��$\0{��x*�T��cz�ϬZ/��|�&On�\x1B�y��ͱO�z�����g7+�\0��f��b��/���њ�Z9�������74q���'�����kc��hN��b��a���L�T:!s�Æƽ4���\0�Hz%D�s�ر�Ư��*v�q���w��{�Z�m۶��m?00�'��6C����r*��99+����;O�kH�����z@�����m�F�eM�ںuˎ\0��K/\0v�q�\rӦOy���5�-)�RZ8�,���rNެ�#5\`z��=��\x1B%�%�r\0X�2]s�\x1B��\0\x07\0��s�=��u�Z\x1Bb��--�\f�y޼yS����p~�ƍ�ڜ�L��ߖy�j�M�s<y�u;M��>��S�j����|(��Х�d��!Y�e�]Wey�<Z���	�\\��?4�5�{8
���&��Ox\re�m)��M��l޴iʊeˇv�u��3vy�*G)�6��r��#�����H\\.�׎%u�X�|N(Gh)-(�����x'\0G�8�d�ssy9~a�r{���+w�c��==�,�q�w��'���ןE�rs���w��<Z����	.[�����N\0�>\0�t��f\x1B��(���-}�u�W����Y��L�:�UG)X�r{�W�Zk\r)$�\\�=�(�����\x07)i�����c���q�ܪ�_��v͚]��k�N�>}]s\f0˩�,7���\r�7̘9k�\fgyTIk�ՠ�{����i�����\`�3�x��;�|֞{.�VZ���Q\0�-�2��
a	)!eA[�rr��|)�AJ���a:+�u��5�q��s�>�߆\r\x1B���k��}}}���H�����CԵ
���}v�W_ݸr���$C��Q)U�N��+����#��X�j��B�0���/�X0<\\@oo�ł\`I)�e�e����|^9��]��%��� 	�O|����\rvVP���a�����p�c}}}�.�1�<ˇ\x008	�2e��ukwݶu�Čdy�J�b�Q"c�C��ʆ\r�����h.4�d�X��B1g۶e�V�h[�B�*��p�\`ٶ-m��S>1R)��+h���\x1Bx\`D488���O�ahp�'9�퓙eʜ\ffy�IM�X���\\��\0�v������\`���<�/�{n�q�],ʢm�b�h\vi۶t��P�����a;�T����մ�-I�w���%ʬ�����-z���PO�H���}2e���.�'�z�)t|�\0�z�v\x07pZ�_Q;��a��e�??K9�p�j�E�8��Gڶ-\vŢU(K\r,\0('5=GQ9�è�Q&\r�/~�����Y�
\`^�_Q;x�]��Q)U���{��8��\x07��ŗ��7�	����Y�g�n�]TJk���^y�՚�����?~<�MCC+\r�G��m|����>W�~���Y�m��\`�,�������}};f\fƎ���������V.\x07˒�BBH��%���^��
V�|	�?����ؖ���W��c�)�'M���Q�tlGڶ#-˱�E[��p[8vN؎#�E[Ki	\0�;2���~\bu9��o.�;�̚=���7r;�W�ZS�1{{��Ԗ��<?��xxn���Oz7}�a�s�\f�g��.��=����&�轢\x1B�����fΞ�B����hA�ӲO.�f9S�}��\\���S]��W6l��~����w���˳<����	^��kX�01�|��K�o��iӹ�u��)�1y�dp��������q�=�$n\\�.Y�'N|D\b)��ұm�r9Y,���b�(��Z�\f����9\r�S+�D�x�YId޹�ጳάY��Ø1cp��s����~?����x��/��y�׬��\x1B��(�@�}2�L]�r�|*�������nO�O~~��&N��jfy�JEy�ښw���$�3s�,�������}�E�Θ1cp��'��_�=f&;F�_���;khwޯ��r��8¶m���J�|��+G���f�r,�7�}�����/_�#J���|(����pп�1�����<�x�.�1P;��p�\f0˔nǾ�\\�?����&�N��8�W�ح��<ꥢ��)]�����I�8s�,�4��8�0^���m����O~<q���ʕ3�2'7j��RZh��RJ(���Z)(�*Vz頰����?����^�U@�6f���E��#�L����l�^�wQ���,�	���;Μ9\v\v��Wf�Ro̘1����4q�׭]�kfy�J[�������W�D��3�\b�ٞvcƌI\\�
�}�׬�I+-���]z��\b�(����R��ti��N�M/��I��o�q���ם.�s�}�C�$>@zqŊݺ0�@e��Jr��~�\x1B�'\x071˩����hd�q�ܺ5k�q�<*���9\0	z�.���lP���cܸ��mׯ�0UC�q��ZA+-GI���-�VBks�l�x9�\r�k�6��\vװȡ���3�b�N�ӥ7��0�\vs\fTfyR��_��78���҇/�0�>yͪU�vi�G�4:���I\0\x07��i޹����y'��#�)��M+@�؛����]mF��<��pW�qW��C�yZ�N��_�L�2�|�v�7m����S��!\r�q��ݞ"3�nN~��[Q�gΜ�3�z��s\\o�[��Zyn�����3�?����
�}۶���Y>,�N�w<��ޓ�~��,��,�����n��,�jm_u-��@����PyRd�w���\r�	bBi%�B���V�f���n#��5\0�}��PZ��q_�Rގû)\b) !��b��Fy߉e=�=��ؕ���mX�a�NӧmP�#�6'B
!����T�Vy	�k��bs���}\fcǎmZ�㲣[����Y%x>\r�9������\`�N�b��^�v���&lKI��Ǖ<�{#&˧�=��,�e�\\z=�r�,ˇ��P��Ww�fyۖ��)�2�hK�R�D5���.OE̴��3gፇ�мG�ݪ[Zi蘕1���y-ڜ�&�y��	7���kZ)az�̕x�VZk)��PRAB��'�ռS;��-���d�}Zi̘18������\x07kn�u˖�;M�iC��\v���v\b��'>����>����w�{��zd��Y��mQ�=�yN�y��hҗc\x008�m������6��Q.:�c�,˱SP�~�Q��'���Yn�4g��7���}W�m�n�2~��ٻh[��L1ZV�,����ߠ�\0섘���=\r�m7�:�{���m��qj/ڶ����u���±a�6��Ӧ�HhmN�3����B)\x07�-��@\b%��FY���\b*�t?7]j7��K\r�����iu��k��-t����g�i��>*�UPR\v)\x1B�c���zY��p����s\0�#���=�}&O���,��X:�59.���<���|��s�(�9���{�nS.��@���o,�{ f�|�9D__oCYN�>�����Is�<��Bg��I�2ա酎���*j�?{���A�����<�hҔ&)�QբX,�7�E\x1BN���:�alh-��q����{���m��(%�
 �(m-�0C�6����px�L8\0P�R�Z
Y�:!Q�]����ˮ��n�e˖��ת�}=�M��*��zy�����ݯ��#��bw��x���\r���r|�c�$ǥ���$�ܾ�>�s���x���s��v��9���#�r?b���̙��'�^��J���>��h�6g�F�i�ND�Ճ�����Byx�0\r1��^{����^��gF
Y(k��,�ņ�3�uS۶KK�➸)�Z�a~8�۶a�6
R
�j�^)KZ0��M�i��4�T}]F��B\b\b8f�r#+ �\rl�z�� �/�j��F^Q�4���Z����;x�P�tq�'5%S�Y��c\bђ�^KH��$'��=��s���\0��9\v+�/�������m�q�ô<�}}���'�^��ݐ�$ڔej@ÅNL�#k|\r��+tL��CL�Z,148���ץ�e-lۖ�bL�Z�QhI�c�*�\bGi���F�X*�\0��VJ�Ţ��ЎncmI\x1BR��QЖV�����7��Ҧ=�,\vB�R��f���ԫl\\�ٰ\x1BS�����	�����Kf���\`o���.�\x0719�m���O^�r\\��-�q鵄��Iػ�<ה��\x1B7��훜c�v���,�e�\\z=�rˤ=�qZ�O�&i��	9a�~��ʅ�D�Q�j=��p�C�6p���X(Z��p��̙����0W�u/<���\v�5�V�Zjiz�rJ��t{D���V�Җei�hغ=��\x07���HK)\`I�m!���ڲ,Hi��4�,_�
@@�4|���2lq�ݕ���۷ܯ
�=���~�w�<�^��ض�&��g9.�Z+\f\r�^���Wȳmۉ��g�c0ǵ?����Y�r��,�g�\\zE�rk0��#.tB����?-�����k�{�^���0�oh�(U��X������\r���e��f�^km�b��c��
7B\bQ(��4����m\x1B9��1R��n\x07_���\vm�C�R\b--	)����-)�eI-�%,K꜕r�i\\��-�4'�*h���M��hf�Qూ#����P>H�N\\V�>��2�Ї����s\\�^4D\\�m�Ao��f}��\x07�yN0U3�����\f|̲W\r�:�i�'�^��fb���FT������ɡ\\���������������� �\f6�x'�i\r(��\r\r����lٸ�7\f��Jk$�1+�8»��6
��Zk����eY�hI-���v�h�\\��9���v(�Q�eYZJ	az�t�ʕ�|΂c)a9n㪵��r��Ijǰy����ʕ�����3�/}��\x07I�Ｏ�-��:�\x07Gņsl^P9�q9�\x07=�=M�<�^O ��d���s�O��s�
���,�}ۤ6�i�'�>_\0�rSe ˣ��U�����9��m�L.p�ι	=Q�>9�a��#:CCh���<��X�C��\rX5����m۱)�J�qHaV��P�������Y���\rR
=�����ɍ�0s���%�v{�ez����t.��Ҳ��Xڲ��YP9��V��r�6\`Y�evN]w��+rjM;�2���[��\x1B��^����B���Y�ѱѓo�e��yN�\v�N�a���hud�Ƿ]j���}r�)��f\`������G9���_��o�b'X���ͩ��)08�\`�o	H�Q������\\��)_�Y\vۉ_��\\��J(!�	�VZ+GieYZڦWD\b	)LC:S?iI����B�'5BJ-���,H)�eYZZR�symWK�ry�8R����i�r�<�N�趆�;0R��u�).�lZ0�����\x07F@yZL�\x07G��s\fTfy(�8��ϵ��)��\v�M�a��1��"���,{�	�:�i�'�_���2�S�=}�99����qoy�W���QY�k쉏�C�ؾ��$�?�8�p�v�Y\f�u�F^+-�#:f�JGH)�RJ8��R
!�i9B
��4$R�����{,�	�\0J;)��R²,mY�Q�,\vŜ��I����y3�ڽ�YL'ozs��^���OWS����u��oa�x��SQ�ﾑ��b3r\f��<<\\{D�qrȵ��L��V�2�K	湌9�V1����"*�}���5˩�'�?bf��2uJ�=}�99�"'X���*��'jD'ؘ�{�b�B���{s��F5n5�v����#�Ip�e��Tp\b���%��_%���.�(��+3.�}
xk󻍪���RB��喔�\x1B&wr���ya;��m�8����@�Gk�5�c�2�Hi\\��\`dێt�ךz�ev\f*s�?@�\`!��72\x1B�RSS����r�P�]�(�|\v���|Yn��b�^\`�ه9�rH�EX��P��Mg�S�O.�4fyĘe�z�4��������\r�z\0�\b\`/\0�a��\\\r&�6梡�����x���i�֐к��V�jKO0\0lټ%w�Qǔ.Jv]�W��v���:���Lt�綼�����u&O�R�4y�p__�*\r�{C�Ԗm�e�|>�s����*���Zi�%�VZi�\v�����!sKj��
���r� I�Gt�\x07F��װB�u\0�\0��gTO}��x<�]k���/��P�����J�����==����C�2.�[�n�=�������<�3v�yp4�\b��V+��?�,�\`,R���=�r1��b�����7]�_���_wp$�c�ъ��_����/\r������Pxÿ������c\`���kT-K;��m���\\N+�h�e��Rڝ\xA0\`����z \0-�Y�T+�4\r����QfZ�����Z�GV�!�~\0�\0x�Z��,x��u��������v����9�9³��
N���$�}�\0�n�kc�i�JY�oΜ�=��{�h�2�G�B'0����(N��\0�p\\��Q-�?�X��?6��w���<�W'�0�v�;78��J)�(��2s�u�tp%����6�)��NM�RJxK������H�Cϱ��	���\x07&�D���\x07?�Gu�����q���<����ؕ:,����,����OTK)��Ĭg��'�xo�R�^c�?'g*�\v���7ET�;~���;~�������倃��j__�RJk��VJ)hH�\0(a�\0��ҒR*!mH!��\`!�eI��$��\b�\\\vB\v��	���6\0o\v�2<p��?��o?q�!o>lÄ&�Y�1P�e�t��\0��Q�~�D������w�!��iC����:^����a\0>��sj��n�-7O���?���9笝���a���I\0��55+�H���B��#aI��R\biI@J��)==H�4�����C�V�h[J)oξ��{�c�rw�u��\v���\x07�������} +9³���f��9�f.�e�rw�����w��,f��#r�߹9�vQ���\x07�;\`�J�r勹k���k�<��x۶�cۢX,�b�(�E[
EY,d�X���\b�v�m;�q�8��(%4�6�ʩ.�\x07�h;�Q�TʑZk/ϻ��cʈ�[��o|�+����L����쮞�ey���,SFxY~�ɧv�B����8��W�\\��7A�
��﷧.ynq�ر��,��P(�B�(�Ţ�5��4����B����Tj��{��bQ:���m[Z��Ca�NU�̙�����\x07v�B���,�:,p6�eʠ������ej��B'�����\x07��N��V*;�i0�͑�mK�X,5��c�qs%lG�Q
J+x=H�-�����#������9Ţm\r��N�D�t�������ԍ9*WZ����Ե�,S��q����x��Iݚej�Z#:a�x�Λ\\��O���﷧��n}��8f�#��B��Ț�%�q�r؎-���:���R±m��#�R�\x1B�Y�f�ԗV���N�>�v��W������5�@y��\`�����N�>�v�����V���,S�Գ�7mm"�k�}�S�7s<���cǍ����Qh��\0�\\�z��w�=u���?�Ѵ\v/��e�k;�#���Ȝmk�q��G	�Q"��v!XR�N����Wڻ�#mG�'}���:LGq�8�h������te���Z�EOa������M?���_v�Ўw,tk���,�Y��L0�ԅF��|�Ʃ��B�g�Z�V�#P��p)���>��s��g��������J�C;��<<��i��'7�߿1��V�|1����&���6Hi�q,�6r����Е"ʱ��9�aAiKX�H����⟶�8J(mVlzd�#o���q��������⍇�������-�)��V�)-_�m�����/�<�t|����g?�9��b�	[�n�����'��=��)ǀɰ������;m��x�|�\x07��{O}^���e�8/���?��\f�����o��-�?/�|��OX�mY�����Xm-X����l��3g�����~�9�:����~�|���c��Y��3���'lݲ%���RJ8�F�4���\b��Rp�4Tޑ�s|'\\*G	�T�͛6��^���I�/|����8���>�j�6}.�Ϗ���c�?���}/�X1�\x1Br\f�ϵ�fy��uG%}�����p�g.�k_�wG�\vQ�Y�g���}������|�]w�]�j՘n�2uF�st���H�3g��M��C;�����{n����\r��>:Q)�1U��5��Z(�����Bks�fo��N��@9��G�RjL��_��/���~g��\0Q����=�G�򾹉�����&wS��e�F��v��;~w'�=�ξ	��v\bn����Y��Ït�>��/nyi����\0N�{@�ș5{f��\x1BQ"�f�L\\���_�\r\rKezUan�A����Z���PJ����Jka~G���C��������X��ƍ��K8���c�}���/��m9�Y޼y������>�}�r�f��t��%2k�L|���&�'?���}�lx��\x1B�L�7��}\0Mu��7��"��ά�3q�g.O����K�k\rh��2�3rmz�������7���Gh��Iq�_��e�C]gܸ��ꋟO����w[��r����3oH2�s�|��[�_6Q]�M�����D�>����'S�D:a��Ď#�;�<NW��u�{O¼sϋ�n�%�v��7��B+�NS��4��J�J�����4w��VkV�>0�~s��ÏxKG^3Q�f͞���pM�v��]�c�rQ�dy���\x07��oΜ��#���&j��s��e���|�/\v�&��~qS�<;�����8��N���$�7��������7=F����N_�L)%�m�{���;}cBV��R��%����b�ٴi�ܰ~Co��0Yؖ,˞��2��%����c�y���[��1�\r���.I#x}���\\]����s�M4����c��C��!qeNt,�������9�	�J)�u�ֱI����מ�=	��(e�M���^|I�vkV�����'�Y�vrܴ��v�V��ӎ�K�JӦOK4���W^��,�\v ��B'��t��\0��{�9\x07�Έ!�
GuT�6۶n��~^����m�r����r�8�V�w���~f�h��F�\`o0u�C����m
�Ö��T��\\&��;�\x1B6�2%�'�T{T�Y�nq�a��n�ʆ���S���\`aSS�U�\0\`B��?'�"�
I�-oۺ5�5�����Sݥ'=ΘQ}�As<T���WP����g��8/��rL7���\r�Į.���~�,S7J����-��'GHR�d�\r7"����Nl�7vܸN�����߲r�'6�\x1BSo�N�J	����k^\x1Bw�	w��[��B�^U�W��4�w�ϴ���\0�űq��e��Z�Y�n2{��e�7o�T�e��,7�|Z\0�Uy�J�[:�YiG&L\b������B����+g���,S77.�����,������7ۈ����(U>0�}����%��2Q&�9����B�h�ܕ\\�Λ�����\x1BQW\x1BM9f�)�FI�Q9M-8�3*>�z��!�-z����|iu��)/��^�6�~7D�4��,u�\`�U��\v�Q˶��mr���\`HxGK哗��DD��z���m�9f����߿1�f:��\\,t�F�M\x1B7�ncYR�")EŜ� ��'j���A�[���6��,�L�^˖.O���BF��7�}�5��Ѩ�f͚�m�z{!�t{�e�T��%i��}֯[�MO�[�0�D�u����d�a�9͉�B�h�m\x1B��{O�vc��A\b@Ji:~S]\0��'�?=�\`�6cǍ��Y&J���������d�͈/rX����!����?m7n�8��HBJ	���9�D����c���رc �d��R�������˒l�	����8�SC�:O<�\b�'M-����-}��?yy鹾������'jئM������R��"Y>(�"��g�\vsLԘ��A�}ם�����3f\f�L�R˖.��/�8ɦ\0������+��qu]�CD#�m�V�z�͉��8i�R�wP$dH0;��ڪX(�������@�'M,9�2Q�\f\fl�g?���n�2*�����:X���7n��7�4��QO>����!�eV^�NdF�=�D4r�\x07���[�'��bI\v;N��e1�D)�l�r�ץ�H4��\r\`\0ǽ���9�r�~D�z���>\\��'��5��RH�R��bu&�\0��_y�����ʕ/&�~�����a��R��{��g?�����\0�
$;7�N\0\v��ںm\x1B���Gqӏ~�?�����\x1B7n&�i��	�R��6�/8h�g0Qk=���������������0e�S�0�D�p�����?�����6\0/�r$'���hN\0\v�o~��s��\0�3ft��PJض���!h�!�.B\0ZCk\rG9(�F.�C.�+ύ�X�h���\v�4i���AZ�<r���<�=y��=��s����\v+V�uP�Rb��v)Y���i.݂9�0���-�c�<u��bs��Yx���\x07�\v/����M�:Ռ�H�,S�y��ey$�d�3(9�ik\0Gqjb���'���/�Rȱ�\v�ZCk��?Q��R
Ţ�|>���<,˂eY��_��+�?��ӱϻ\`�C-}_Ӧ�d�������u6¦�tK0sLal�nz�7o���$YoԸ�cK��0˔u��r��0E�&$���ќj,t��d���\x07F^�w\`�i.D�A�f�������a�S\v"*B@Z���:����L��Vx
��I�ȩ\v"*�.|�y\`D�}�e���,��.n��w9u\`��;�m۶0'>~�a#z�'[�%K��E���o���'0k��x��'��\\ï��%K��cO�O<����C��>���K\x1Bz/~��r\x1B\0��/\0��w�\v\x008��S�z��?y9n��z\0���݇�0���W�Ƃ�V��˯��ؿ7��F3�]H�\x07H�~\`���g�\\\x1B��,�� �'�����I��N�?��R�/���Ȇh����\x07�4$^#�������|��q����|��}#\r��K����A���Y���Rx�	��%��U\rV?�ޏ�O|<v;�.�����Hm�6�o���5���Y90��(�qv1��rf9�����]ذ����ew��{~ȡ5\x1BԠ����bl��z�-��Z�A\r�����c�������y~�R�;�D\rj�E����|���~ǱǳA9;n!�^PНޒ��F1Ǖ��s\0l�ۈY��,Wb�;Ά)n�\x003]m��Z9\r��N�,xh!>x֙��/��O\`��Zs�C\v��T4�o��y�.����J�\\��r[�0�y�_�9\x07X�[�ࡅx��'p��W�~��O|۶��Z�^�W_qU��\f\0�v:�rԑ�C�\vZ�%K��h�o��zL��s�=d�W�ƹg��ŋ�+���+���=�mˍ�{u��\`�{; ~�ꫤ��#�9n�zs<\b\`#��0E�A�wa���ef�EF�O^\r\`\r����#��=�����i�m�p�wM/N�P��G�Ï8\fǿ�x�p챥������q|����V4�{�����9��=�	�8�b���+�����jc��߮hP�j6h��:�\\uM�s��7�5<����Ԡ�w����>�ً�	Q��r�z{z���^����7v����g�\x1B7��\x1B����󪧧G��y��崻ī��/ҷ��0C��m(�\r��[�iLL��H���\0s\\�\\�1�4;��|>��&ɱ\r��\r�},��f�.�r��6,�C����\\�{8#ék-���\`��Ox\x07��ʵ���0\x07��������{j���x�A��W�&:�qϽf�\x1B���vz�w}�B�^�:t�'[T1���|7q�͌3��~��w�?�(��d����K_���^��B@I)�Bʢe�B.�+Z9�����=��|>?���3���7���;���3���;���3���\x1Bz�i k�a.�	�w�\0���W����	�!��U�k�/w^�(?0��,�h~��e%��&$��TN_a�G�Y��,wd���9���@i����c��^��W~���~�a�ܝ��u�����ޜ���Gu76_��58�w�~�m��B�[�?���{��u��8c�\f\\~ŕ��������_�*\x003���:���͘��A���.,Fu\`��1�MSo���0�՘�ht�Y�\0,p���N�\\~ŕ�s��u��-GY�~���"{s�rc�������ig��-_}��']���GB_c=�M�V����K|�ŋ��	'���##zޖBЦ�Z@h!���Rj!�蘿�&�B�ސ�L�XF6��\fs\\�9NE���:1�՘�teY\x07t���
:-r�����~{��g��kW�\v�n�C\v+N����O|[E�]w�]��m�*z�F:D��?�����'q��Ք�d@='.F��b��1�M1���L	1�՘��>9L��HVq1��{��#nx���)�vK�<_�����D��c�|�[K\r�%K���]d\f\0f�5sD��]�m$�~�	\r�����\0%\x07xP4b�q8�)��1�� f9�ܰz����\0:-��k_;��&m��ig�\`x<��k��g�Q���q\r_T\f\bo���{���9*\vk(�Q6�#��c���9n#f9��ug��7�ũk-����*�\v���Gb���k�����}q�8?�ޏG|Q�FvR�=�.gC� �s�4�q\x1B1�՘�a�S�#:](x2���fٺuK�=6�W�Ƃ��~^�fm�E�F�;�.���g����g\b�<jq��X�t��m�[�kW��9d��c��d����V�dE9�w�ȷ����4"�F48!�SJ1����ʕI6�7ǼN�1ˣ��)�B�\vmۺ�c�}�-��_�j�Z��{\\t饥����w������{r��I6\x1BFe��9Jt!AJ\x07�8�����MV�9�f9{��rʱ��B���+~~�O���īW��5W]S�St��\`΁\x07b���Lt�i
�l��$�m��Y���<lX�\0s�=	;,\0�8S���yj�SI6\x1B��z,t�и��?�\ri7j۶|�㟬X���/}��v
W^i��.L��&�\x1B�\`��=򦻰�M)�8{^�p��V����R
1���dY^�:���ڏ�N
6��W��-|�~�G\r����Ǟ�&Z�f-~��\x1B�l�"*\x1B�\`��q^�1��20�?����l��q�0��20��o�Y�MW��,S\x07py�.�j�5kZ�\\���;�e��d���DE�V\0��>TΆ�\v1��q�mw\`��eI6]�8s���#���,�\v�.��y}�{���F��[n��IS1}�Tq��5��_���$�F����ƿ\x1B=��|�\x1B_K���(7�v�k�����lX�t9����%��%\0\`�3�YΆeK���\\�dS\v�.���\x07�����x�E\r=ޢ�/}�;�U��\x1B\\M���������k�����D\r*\0,�iD�7o�<l�\`�z�q�\x1B؎�\\��=�O�9�$f��\r\fl�g?���n���2���\f:]�-G����_̿uď��c�p�\rח~~����^�y�Wg����W�)�-]�3�?���J\0/�ܘ�{�xq�.�w������K?��~1?��[\0<�8����v�Z�ץ�H�<<\`��\f���B�K�����W\\Y���\x1B������?�w��#+�<}F�������~�իW��_��,5n��o�)r\0�A\0��-�{�^�.�w�'=�c�8:i�\0�9�,f�{=���|�Z�e��t\v�.v���T����ά{��[_�ߊu�O;�̊�O�1���[n���$o��ŋ��8Ys4z�/ŧ>�i\\x޹�9�,�iD�5��\vWv�b�qwy�ɧq�羀�}t=9^\x07�Q0Ǚ�,w���|��ħq�;�YO�_��UX�t�3f����n��N8��ĽH�]�߸��+J?�w�x��o��&�Ku�ݿõW_��a����������܌���\x07�_�ي�7:����m��u�v�Z�Z�/�|	+V���K_��b�s���<�;s7�����٧����tR�e�=�\0~	ӐP�5��î�L]�9�M�6%��n�!�>�l�[��o~�ާ����c�;��,{���y�H��w�Y�*]��uf�p�W���N��DN=��]���q��Ygb�i��-G�SO;�b��,��=�o~��+��p�;�}$�9N����ǿ�����K/��GVq\r�'[�%K�ǝw��b��7����s���{�}J�{±����.�m\x1B�\x07?tv�?ʺ���w�7����Os3̲������=]w�\r�9�g�y�<�t���n�^�r���B���1�,3˝Ѧ,߅f�ӟ�h����ؿc\\?>����~7���1���qч/���	'��|���+9Ϙ1������w�~�x�s�\x1B\0~q��u��~FE�=F�5�m�+�ik��4v��n=8"�8�G�|��9��\v��c�3�/\0�
f��p�ZF|�Cg��߁���^�����W�ß�(�A�~�a������;��ӱ���+N����sp��t��J��\0<\f34^@u�Zk4��s�)��9��Q�YΔ��f�+	���\v�Ȃ���\0��@������};�~\b�C՞k������BOj�C\v�z�ꪡv��D���wa�����Z�m\r]�U�\\�4�v��q���Y�ٿ������7����/@՘*�^�s�\r�q�O���V\0�D�s�g���\`���Yn\\\x07�|�{�\`��sX�t����\x07�cz�T�]�̻<8"��\x07GC0�8ޅAG�c�Y&�t{��sx�Q���\0��܈:0\rpp%��H�N�9��9&�n�r���!�A\0O��\r��i
��j]~6�D�W\0�\0x�1Q7�+�O�:D�3\b�y�\x1B@x��B~��(=�\x07�L�7�9&�VOxf �3���Ȭ�9��Va���;���+�<\x073�ETs����[	\x1BT��\0sL��2�JR��Q�5\0����˻�����n�\v���o,�|�Hc�Uۆ��1�,���,S\x1BD:aWZ'�2�I��e'���W|�/?�k|���\bT�(^�s�X�2Q�n�2�Y܈�'����XT�o
�j��U��9\r)sL��r�=>U�,S�T:Zkm������/�(���d��a�･)�C�iL�c���2����e��R�e�Z#:�'\\��ޢ��4�k��6��1Qmݐc�Y&��-Y�6J����U�[�%���ZkUϓ��5QY7��{�DT֭Y������F��Rpx<j�<���m|��W�(\\�s\f0�DItC���d����Y$Ţ���^-�ï����ʺ%��k�%��n�2����;�q����%>ɱM�5Q�׮Y���I�ݒc���O�Qe\`\`{�M�)��&q#:lTi��>0�d3�R�I\x1B�N�'�6^�vm\x07_*Q�,[�<�fݒc�&~-	�?Q�-}~Y��֣{�LmTU�+M�o�{��=���B�O&����\v�	�h�:�/_�h�B�zK�Ot��O�8�@d��w?f��"aѾ)�2uF��؞��\vt��5�C<�d��\b��r�a��Uwh�J��m��o|��iD���S�:,��;r\\z~��"n��7��C/����~2��}2�Y�9:@���~1O.z��!O.z��{O�MQnL��lX�؃�謌�pႇ;�Z�20��}��$�>���1����-�6Z�|���N�V���]����גl�m�dj��#:\x1Bav\b5��'7u��5$��(�4��-�{����:Ly������LԘ�o�#�f�,Fw�\`�i��O�d�\r\0^F�d��(���\r���a�4��~��\x1B���G:���F��{���c�M�iH\v��߃ְvDD�w���\x077���N�l��,[����$��]�c��,����͈R��EO'�}]�ej��S�4�\0p�Es��:˖.�g?����/@�A�7����)�\v���׈��\0��bvZP�؎�~��%����uf�����>�����v\\pnޭY�6�,t|+�x��\0~\x1B��˗/Ùs�φ��Ʋ��q���c��D��s��0������($�
�����ҋ.�yw�5��.�D�s���;�$�@h�7"�L\v\0�'SW�p��4�t��2�W��\0�\vI�+v�#Li���G�)r\0��\0�\`U��?�1�=G�B'�'x��ex��Gs�\v�ޓ���瞏�~1?�]~���10�,��od�)��\\�4�=��z��#to��\rD���B\b�~+}��83�|��Kp�Yg\`�왝~�D%O.z?��MI����
��\`�AT6�^O���T4�9���>Ƽs��g������ɷBTa횵��O�t��I\0��r\fDf��\0>��1�eJ�іej���mX��\`��\0L��Ny�\\v���o�~\0�F��ʛ��Ԣ��p��zz�<k|�+0\r����ߠ{���F5$��	����8�w<�8�(�?g?�7�9��Z�t9�m\x1B�������O&]v�o\0��0�]�.�@�|�a��>����r���}�\v��,S{$-t\0Өz=HG���/���΅98
��jPS�s���0+���iA�ž\b�vti���,��=\`�i���,S{Ğ��G��q|\0��~�Dm��!r�иטF]}9U\rjD������F�&��Ktq���,?��~mDm2�2�G��\b���x�p~��N���
��0\r�x<�QM��.9~\0�1eߝ0�t}��iT�f4'Y�֋��V�q��\`o��\0�w����0�F�%+�z��bpD�Op8����70EN�r\f��'	�2e��0+\rf.��:#)t���(��D6���\`Vr�\v�\r��Joޯ%��iPk��@�b�����Rj\x1B�k��1���\0v��k$j�m\0>sZ&�L��h����%l��>\0n��\x1B"j��0���(��B�I��9�]Ѡ����\0��@����$\0?CFsx�aY~#����k$j�\`��\x1Bd8��:u���T݋��I:�7��N�9�:�\x07s���Q����5����lPcr<�\x07-�5��R�09^�Q�c�Y�L�Y��\x1BQ�D6�^�*\`׏8\0�4�'�����y��48߷�*�@�6�	r<��\0>\0���e�)-�<�Q�c �>�]\`�)��,�F�>��oąN��\x1BW	\`G\0\x07\0x�����|�N)7��aVy��v"�w���r���v�W(��&j�\rs�.��w�!߷�J�\0�\0�P�8�\x1BͰ�+��"C\rj�9����9��a���Wkl���\0��l����������O���i��f��f��i�"���}r[���-1ۅeyg�����
�Kfyf����B\x07�hX���5�Ȇ݀ꆀ*}\x1B����g�,���}f�w������=�q����a��Fx*O�\v60�)����'����}:�\b�]�b$��5��q[�\x07s�\`���mje�ڈ���w\0X���0�Oz'�Fey\vʣ!�q�c���2�L ��QY�s1�*�<����F\0πY&\`�0��۸z�肍�B�Ɣ\ri�P.r\0�4\0�
l��m�܀�����>�0+����vB�����}�e�9�(7�^/RX����u�W�s�� �\r*s����\x07Lg�\v�m���z��\b\`-�\x07A��9aןϰ,/s��rۜӑ�c :�� >��P���H����,�4����h\\��SĆ5����	s\0�5��^#��5���:D7f��_F��|��{o5oPp4g�K;�͡MC�Q�=G}��~?ZR�evD�	����s�,��9^�r��L��b���Z\0��9�f��ޅ�t����ߛ�e\vɲ�\r�2QIS\v���o�k\`���5�lT�}4�w\0p�����iT���0'�OCx�G��1̻�\x07\x1BH�\\X�w�%T��x�W�e�t4�Q�#r��hmL��\v[��"\0W�~������|0�3�W)
f�;�b�3�Yn	�~�,\0��^+˯C|��s��\`��e��:~\r,P�W����#aN\r:\x1B�9�^���}�>��G<���+0'j\0���Öo��aֲ���c�0sJ��6�՘㦸8�w;�$���9*�{"��e����e��S\`:-��ߨ,��9//8��9�(f�)��YQ��1��\v2\x07����~�ey%�e�*-/t����[�����������#矚\0�"��������SDeϏW�x�3\f\`5��ƃs���sT��sd��9
����Qݻ���~���*�{��@�AMX��鯵�O�g�<ba�^��Ƴ��,�@�,�f��J[\v�(��N\b�\x07�w��$�a��0+�}_��.�깼a��+~�.�׊�#�?�>�?�&�8�Ɵ�Q[�9w��2�8����3P����P^e�9���M\b1/��G�]k��W(�4��ݟ�ɲ�\0�L�#;���y1?���ң��Z\r�g+�\r0�陊�+�h���עr�<jH�\r*�zn��91�]�m�~�gy7�s�*6�1������\x07�l�1�Dup��"��9���W���|����N�0�D\rc��n�l�Mm\v[���\v����48mm�{��F}�Ș�p���Y޿����9�����key*��3�D�̫񷓅�N��dy���H��e\`��"��I)!�Ɉ���7����-�AX/�s0�9P�#�s��&�爨�l�������QX���,V�\v*v²<\f3]�9&���\0��Q�#��\v0Y�ϰ���5\`��"��I�y	��fZL���Iz��0+�����OZ�������=GlPi�������nS\`FiB�#��"�V�_��>sLT�Kl�_@ȟ�]Q=5l�z��}2Q\r,tR(�"ACu���5����1��F�_]YE܇h��WǶs\0��,�	l��W\`��ME��{��NRf��"\b!vDy���9\0D�\f�$Y^sO�,�Y&��B'�.�s��Q>@�N|�7b[û��\b\b�ߖ��5LΞ#�F�a�ek�{E=���LT�Dey�3��v2�!\b
��֚e����gX\0���\f�2Q,:�4o��\b�wE��.a=G\0�\`Vv�*n<�\0\f"|x����F�KFp�w�,J �Ce�E��M���	NW	fr3̊��1Q�.�c۳a��yENp
jT�7�̰H��\`��b��I���+ky�\x07Ho�zx�m-�hN�\b�n �y�Q��\r){��\0���b\x07�b'l��ǟ�m0��
;��򋨼�sL���(D�1�و��Vzh��U��Y&j":�3o���\0�$T���s��\0�Wly梂a���sD��\v\0�\f���D�x=�=�@t��=��1Q}��>�4���F��*�e��X褈;����S�^�%�X����q\x07fM���\\�sDn^��\r�\0�\f�[���\`>W�9&���\b�9#��n0�����C�z��$�K�,%���\v�
�k������稞�AT��5<�2̹<�ik�9"�Є\v\0�w���@t��0Y���fD'8Յ9&�7���~\0���ʲ�"b�,�Y&J�#:)Q�ҕqN	{x�-\x07sp��� �\x1BK\x1B��q��V��#"\0�wX\0�	(O-�{���|�t :�/��c�9&J��{�CC~��L�,t��d�|N�߾0\x07HQ=G\`����]��hNp���F�&vX\0�,D�x,�<}�v�ע�b"sLT\x07w��\x1B|������{?�y7@�,�\bf��n,t��&>�,����\x1B���=F@���YR��Ɏ\0{���NFs:,\0�u��=�;�1����\`�{昨>�4�1�	��rL����,Ս�N
\b!@�KW�� y��g���=B
�KW���sD�&>�8���9�9'�^F_B�|<�oas��(\`��\r3fa <��,�0�Duc���4��$���5�r�5D>\0s�c��(8��=GD>-�\0�Gg%�����",�6����7\x07�1Q=�5�f~�fX��̞\`��Z��N��,]�H��x*������a��mFt�\0,C�E��sD품�/Mp�?E�~��!O?���5n�P}�sL�ܼ&>����\f�$Y^f�h�X�t޼��=\b\`&�����\0.�)��]\`Fv�ќT��9�ܛ�����\b�f\0p^�����\0�-�o^�E��b#�"��<\f\`%8��hD�'��E\b��Q/�cP9m-*�a3,�e��X�t�%��_\0���QZ�	�/\0���0�;E�߼�u��5��e�畈^����\r*Q�<T.Bp%�=��?��1^�G\0��L!��t�Np�����e�E�v��9�X\0�c��"~�dtvq��_�򈎗�ќ\`��?3�Dub��A��+7�Rk�����:F���I\0w�0�\0i�h�����W\`V~	;/'��eDTv���A\x003�֟�Zo����\0��9���c0�8\0{��\0���\fX\r���\\~�(F�"�����C��\0�~g�|�,P;���,5��Ng��#���ύ�1$̔�v�i0��$y���E\b��A�P}�c�I��9"r�\0pt����ʅ\f��\0���x����(/��Q=�4j
*sLT���_G}���0�����e�Ͱ\bNA\rfy9�e���:�F��i��h�1�EB���<�ݟ�B\x07�_��U֣
�����\0\0+��{4��^!�/\0xf�\x07���Tfy3�|~�Q�9&�m���A\0�F�q!\0�~�,L����t��L[�UW+�\x1B�,5�#:Ԅ"\x070\rg��}�Bd�Jk@��ư���hH�sDT6���<�"p��8���?�+a����c���\`�idtv,������y�=�c{c��ڀ#:��u��9o\x07(���3�%l4'�����o:���\vs�\`��-\b���s�¦�D��HD��h���4TNW�\`\f��SP7�Y&j��t�=ܯ����7���a���oD�
����$�kp4ǿ��/�\0\0�IDAT�\x07��rpT6��:�9&
ӤY�ݯa#��Y��ִ��\`�����N�\x1B���ɢ����Y�?8m-��"j�i!�\x1B��Q��Խ���L��Q�Y���N!�\x1B��\f\v z��:\0�\`�����N6�{�r��وʫ*���	�\ri��x!2���!�\x070\x07>�"|��7�?l�i�
M�1Q�gX�Gf�\`���l�Y&j::�3��9k}��{���@�ќ�\v�Q[{�������s-�T�\`�Ö�'��\vΰX��,��L�t,t�_p4gL��kP�P�~V�T]��=GD-�\f�B\x07�̩��us����1Q�E�/\vDgy�e��c��-?�Wv��������&�����{��TN[Q0\x07F�\b��e��:�V��SP�Y�Ηe�����NJ	!D=��\\K'8�lP5���Z�5x£���9"j��Y��^��Խ�\r�e�s�e9�e昨a�d9��ł�\v��gX0�D-�B';�V_{	�#9�
T^�,j"j��ќ�
M
�j�ϱ�O	��LD�1!�w����2Q���I�$�G�hNO��C\x006��'h\v�*l<7�(}�z���B���������1Q���/\vTOA�)~�e�a��BuN[j�����lL����\x1BV6�D\r�3�a=�[Q���_Nڿd|بliU'昨qufy���������\`7�L�D���:��q\f
��
3�6��;\0�ɉ:A"�\x07x�{�ע<�?�QQu��Uf���f���8���Ɔ�ΆY>�ߨ�@�Ɏ��+9�C�}������\x07HU�c���}0�/�Y&j9:���'���ښ����Np0" ꜰ�u���
�\x07x\r�;*����JDme��.8u\v�,\vf���X褌op����y�P�\x07\\J:8�S#����<�vֿ<<\`Fs�=�a��K�c��hB��SPf��mX��H���3<�����9�C�./����\x006�|0��q��6�(=���փY&j\x1B:�t�Z�u(��俨\`��q�&j����C0�[���3��\x1B�\r^T��2sL�|#�rp
�J0�Dm�B'E��FZ��{���
��î��Ɣ�I��e�7���D-&��H�쟂���Y&j:�6�F�[m�F�E��W9�9"J\r��Qp>�ӂ9&J/o
�\rf���X褓��z���<mm�57���׈�=F���y��(��X�b�\0�L�*#���h���4�L�f,t�e%LC9s�N��!J��0-��\0;��^�î�������Ͱ\`��ڈ�N�4���jT���oPÆǉ�uF�e��h5�m(���i��^#+�zY�L�v,t�c\v�A�6�F�F��	��V&g�Q��Gy4�˰��e�u6J�f��R�;Ov\b�2Qǰ�I�}��0=C�P.r��[��Ȉ�%Fr�����e��?�QSP���F���0Y}�2Q��:�(R���
���y���ޣ���q4����ɘw��a�	v\\T,&���H��2L��e�\`��\r�a�����_脭�px�(�����nGe��Y�q��(}�,\x07���2Q\x1B��I'3�0i!�ֽ�WZ��{#:��QK�{1�M0~������/0�_���Z��,�\f3u�Y&�0:)����U�K�.	����\f����#\x1BS���NH��x�b���.�\x1B�\`��Zh�Y~�s\`��:��Nz)\0cl�\0�3Lo���un\x1BT���'oO\0X��{�����\x07�b"Q�Փ�gP��/�L�A,t�KH���ќ"ʍi�Ֆy!2��H����ݯ@9��s���&2�D�$s�\`��R��N���Ɂd��?\0l�?���\\jPy�#Q{�g̜~���Z\x1BDmTg�_�L�,tR��F���"��<��\v���!j#7�I6}��s�yAA��#�O�Y&J\r:)UG���T_lԿ�\0���Hr �\r�\x07��e��!I�����݇Y&j3:�ϛ��W�x��!J=��{�/}�#��c��R��N���\f\x1BS��k��Y&��2QJ���6�Dݭ�ÂY&�Z�2Q����~�!�\0�(\x1B�e����~DDDDDD��B������2��e\v"""""�:DDDDD�9,t�����(sX�Q��!""""��a�CDDDDD��B������2��e\v"""""�:DDDDD�9,t�����(sX�Q��!""""��a�CDDDDD��B������2��e\v"""""�:DDDDD�9,t�����(sX�Q��!""""��a�CDDDDD��B������2��e\v"""""�:DDDDD�9,t�����(sX�Q��!""""��a�CDDDDD��B������2��e\v"""""�:DDDDD�9,t�����(sX�Q��!""""��a�CDDDDD��B������2��e\v"""""�:DDDDD�9,t�����(sX�Q��!""""��a�CDDDDD��B������2��e\v"""""�:DDDDD�9,t�����(sX�Q��!""""��a�CDDDDD��B������2��e\v"""""�:DDDDD�9,t�����(sX�Q��!""""��a�CDDDDD��B������2��e\v"""""�:DDDDD�9,t�����(sX�Q��!""""��a�CDDDDD��B������2��e\v"""""�:DDDDD�9,t�����(sX�Q��!""""��a�CDDDDD��B������2��e\v"""""�:DDDDD�9,t�����(sX�Q��!""""��a�CDDDDD��B������2��e\v"""""�:DDDDD�9,t�����(sX�Q��!""""��a�CDDDDD��B������2��e\v"""""�:DDDDD�9,t�����(sX�Q��!""""��a�CDDDDD��B������2��e\v"""""�:DDDDD�9,t�����(sX�Q��!""""��a�CDDDDD��B������2��e\v"""""�:DDDDD�9,t�����(sX�Q��!""""��a�CDDDDD��B������2'��@5�\0�\`�6�:�"���M���N�H"��	�2QWZ�N�"""""����5"""""�:DDDDD�9,t�����(sX�Q��!""""��a�CDDDDD��B������2��e\v"""""�:DDDDD�9,t�����(sX�Q��!""""��a�CDDDDD��B������2��e\v"""""�:DDDDD�9,t�����(sX�Q��:������J\b1��8(b�G�
\0Z��:����#:-'�8V\b��c��N\ry\r\x075��D���@��o�s$�x5$�׻\x07bD�Dn���U\0׺�Z�΃���l�]\bqY��\x07�h�B�Ŵ���������|���֏�葈���Α�\b4��Z_������H�B��^q�H��A0EϫB��\x1Bx"!:�qk��S���>O�йu$�ED�'�8��!���c��G\b1K\bq/��QݩЈ�\0�B�+�����I4���i�\x1B?���E�\b:D]������7��xD�5]
 jj��\0>	�� �n\0.p���1q,���{�:�h�B�\r�i%U�:mz�\`�z+����;�?x��F�"�N�>��p;���\r\0fk��Z_W��Ak}����\0f���0����!j:�,t�m����U�N�?\b"��]�����Y�5�;54l1�G������Z/�Z_\0�\`����!j:m����@ůգ:��_ƃ$�tB�G���e0\x07]\\D��I����"�w��i�uGx�:����b��^�a�V:��%��'J1�D�\`��(�HNݽ�DT�|D�d��'�Z�E���-_��h4c��^���Zu=\x1B�q�=E��F�BB����:�SYX���{\\p�{k+W2t\v��i�\\z��EX贑;\fޮk�];�\x07KD)�N]��\x07]���g�x\bQ��]\b^�s�;��j�LE����%j\r:���iUON�q9�C�25��[���u��e��������ja܎�O~=�; �X�_������4��\x1Bq:D)�N/�;����Ц�e��*8�s_;�q'
>\v�\`��f���\`���k���s�R�]V�^��Dh"2":[v^N\r���妉���Ng���ؔ����T:�~�Dd�9�8�"M�V5��e��\f���B���X�tF�:a��Hg�;LNDV�
���!j�4]D;�ܭ��Ѩ�B��id�j����k�����m�53��Z3�D-�I��E����xQ��b��9a��j��������P*r�\r�z#��;1m�h�
�7��}興�nɵ��F+:1?��Q����kĉ\bB\\��"g�H�I�>�ќ4�/�8�C�D,t:+8]���%�\bQ�\b!�Ex�oe�C�v�""\rd�C�B,t:+l~�����y�D ���9Q�(]�Ng#��	i��Bpf\x07\v�&b��AM����C��﵊ϵ#�� �	N]K�>�)�� "��N�GuF:}-x?N[#j3wA���zt�:\0a��U��F�\`��B���X�t^�5u�+7'r�g^;����љ{Q=��Z�O�KHW]\r��N�v""�,b��aM����C�YQENŅ@�֟D���\x07	!��F�0���k��I��Bǝ��ݎ��!ꬰ\v^q!��P}2' j�n�&�B���X�@���	N[�s�:︈"�\x1Bŝ\x1B�'.N@�Z��l
��(�=
�b�����z
?��u�F�"�Z\x1B���\f�ӽ\\���e�ED:����Q��I�\`�rl�����5��C����{�Npq����D����Bǝz�B���X��\b���k���2\0\x07�;m����w�\rePp;���EÞ��Q��I�z���ikD�p��Y1sQ}ps>' j.�#"�wa�V
>�F�cK�\\,t�%xM�YB��F������9D]�-��8Q{�;s���YI�b,tR$�:Q�M�vQFpq��	:\x07Eu(�����l':����c��>I���s?"�"\\���-�3'\0�)�D��OX8�sge5\v��qWl�7���7n#�k�e\f' j-w�D�C��&��̇�R~��ڨ��}:WL%j:�wM��%�..N@�Z7�zT�zw��q��/^.sGwf�� �q�,t�Z��N:\v�S�����s�2���VĨ�,\0׎��Ǽ�����Y�Q9#\0>�KC�\v�r����x�䜊�F���!�.N@�Zna�ԑS�1<�D\0��\v!�E��s�Z����EX�WըN�k�vD�\\����FNG|N���Q��l�/,Tuݜ��@DM�B'��=<\x07��V�\r%��C�a\\���uܑӰB�|���O�Z�E|s\\&�X�T�5u�=��&ʾ��>q��5��YxAȟ��k��tQw��klrWK%j=:�,tf����2���=.�O\\���	�sd�����\0��#<�	!"���	!^p/�/�\r�U�N���Zw�5P\rn����Z�;���F#w4ſB�\rZ�\vF�x#|N�����/D�sGn�k�K���ь#:�5=��9D���8A�=��DM��^�v ^��颍�\b3UM�z���î�CD��B'��
��C4ʸ=�a���!j��\rZ�I0K�7r�2�k�L�v	�ww��8Ne#j2N]#"""��^��-���m�P��5�jL����T����Q\x07�K�{E�u�5	\v"""�q�����>��\x07#�
�3|;Ħ�\0\0\0\0IEND�B\`�`})))()}var h;function g(){return(g=e((()=>{h=`�PNG\r

\0\0\0\rIHDR\0\0�\0\0e\b\0\0\0��\0\0\0 cHRM\0\0z&\0\0��\0\0�\0\0\0��\0\0u0\0\0�\`\0\0:�\0\0p��Q<\0\0�PLTE���\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0HHJ\0\0\0\0\0\0\0\0\0\0\0\0UVX\0\0\0>>@			\0\0\0\0\0\0\0\0\0\x1B\x1B\x1B\0\0\0\0\0\0\0\0\0>>@\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0hgn���zz����žߔ�����]\\b���QPU������~~�FFI\`\`fuu~���&&'������kjr���TTX������qpyCCF!!"���CDE]a\`hml�ƶ�����ǅ������оQSS���qxu�Ͻ���v}zlqo������\`ed���TWW����ĵ���FHH������b^b���{syTQTECF������ݺ���ժ��oin�|�Ѳ�ܹɀw~XUXIFI���α����faf������������smrĪ�TTR�������Ŧ���{{s����뺇�|�ݳbc_ooi����ܲ�����wstm����¤fgb�꺩��XXU�ϫIIH����ѭEED���CCE<<>����ߚ\0\0\x004tRNS\0�\`0Р�p@��P ����ظ|Ę�L��X��������ܐw�3�DUf��"݈Z.ۈ\0\0\0bKGD\0�H\0\0\0	pHYs\0\0.#\0\0.#x�?v\0\0\0\x07tIME\x07�\bPH�b\0\0\0%tEXtdate:create\x002026-08-03T21:01:26+00:00���T\0\0\0%tEXtdate:modify\x002026-08-03T21:01:26+00:00ݖi�\0\0\0(tEXtdate:timestamp\x002026-08-03T21:04:01+00:00�(��\0\0\0tEXtSoftware\0Adobe ImageReadyq�e<\0\x002#IDATx�흉�u�gp�\x0038�I��I����%�%Y\\Q3 HI�d�,�x��#����$Hp\x002���,���K�����LWuw]]}Lw�ԁ��|v?��LM��v�z�UuO�JUs�t@�5�&LwTZ��e�\v���@��4�	PI�B�;*�f\0M�����0=4m�\x1B�R�z�8�i
�Պ�M��\bhx5#x�c�'��Ս�A��:�;��\fb�5�А��uMw4�f9x���.O͘�h(�z�8�q$
��4'ћ7�!Pq�J�P�t�@�5/ӃEZw�l'�͙����QR���I=X�uD"��\v�X�uC�,����1�[��Y�f\x1B,\`����e�(�Y:xA�7���)�u�ነ�,4�!nqA�(>�R�YH�\\$�.\v�,�粀��z.\v�,�粀��z.\v�,�粀��z.\v�,�粀��z.\v�,�粀��z.\v�,�粀��z.\v�,�粀��z.\v�,�粀��z.\v�,�7����9�ԉ���;«յ���[�'���jYpb��9$����n��9h��GZ�O��ɖg�\0�R��+)\x1B��T?��*��фD���?�U\b7��eP�����t���?��P���'�\f>������+�����Ӗٯ�}մQ��g�׭��<k�$.�,u�F���UF_3m��5j6���i7L\x1B�-YF���ᖾn=����Y�簀��z.\v�,�粀��z.\v�,�粀����i�\\��E|t�\\��\b��r�>�[L9�ҫBOC�@���{�G\v�y	���V�^zh5�x�ih��wAyp\rU�W�U��K�b�ߊ��bx�=-��\\z}�[�S]�_.KOK�@/��\`0(���.����U��OoU������U��O;�dr�F\\_yz:Zz�-���>	;d;������9MAo�V�^z�T��	�E;/"N1����h�V���\r��^azg.&���І<�sK'��M�X�@�2��drv!40g�5\f�b��o������
�
�*�Åcц+�k���7fy���r�+�*ЫL�1���Ś\`�KR���GS��i�i�wIHg�肷�y9�^P�+�*��@\x1B��ӥ8^dvN���gJzZz:�a\\�q>&C�����w��^n�@O\v�5!$a�����ׄ�����
���ÆZ���v�u!�^�V��z\vԴgH��L�Bo���*��A�O��1������8Cϣ��*��A�O�γhR�w��U�\v��o�i�ǒ�nm����E_���%�1g�V��z,9�/���Τ4���������k�i�G�3>Pd�Q/�H�ͧ�ݪ��
�+A/Nθ肳�y��U�^v�*z�^	z��X�\v$�Ή�����[U�[ze�E�Y�7Ylg< ���B1gv��\x07�����ə�,��%�x��R1zY��Q-�/�2���lYX	����{\vE���Vϐz[/�.�\x1B�\`dt��BЁ�֓�-�꙰�)��2��\x1B뉋:��q�Ľd��ȗ�\v�]��Hz�腛5y�	�2��C�s�����⭆l�cA;�e�W��
B�#�v^\vKdx��R?\f,���/��P�K��z&t�h�4��\x1B�x蕣G�����켊��[�7^L����xh�Z^ze�")y��|�ی{G�+�|��_N���*>�c\r/�G��~���\fK�R�R�9��p��b�xAރQ]@�e=��\\�sY@�e=��\\�sY@�e=��\\�e��܆���,��7L\x1B�%}�z\rڍo���K��%��\`�\r/6���қ����zA}�[�hSf鱉]��i���o_f6�5K��b]Ag?���o|t�3��[hX�z�Ƽi��y��M�6���l�F��6m7�6�7�&:�\r����Ej�U?��&+�f�.xϡ��&&�	���ݵh�E��Ow���87�57?c�Ԑ���=�l��t��<<)��Ѹ�.hW�x1}Tj�I�]Ю)�:��0᢯-i�6�l~�t'F�np�-ӝ�,�uɷ�R��<���%@;�z�j���_S|�hWu����k��"OJ�x�ګ)>^�p��0���ԫ)~&.��Q�h�ף)~\fyxR*���g��v-�sRJ��?S|��k��K��7�y3���~�Up9�{�|��ǹs2�k�V�{�<���[ONJ%�2�d��vZ۰��&��Z��⥍�m�*�L��\x07���F]NJ��t�>L���9y��*��܃)>y��w+ϡ�'��?�8'�*�����?ŷ��'��t�D���7���Iq�:?�O)�ɣ
.S3<���j�'�A��<�y��*��w�y|��=nO�x2hw�tN�6�'�?)��e:7˪��f��)>8��YnFǵ���w;����(�^p�snO�M4I��@�ќ����i,�\x1B���h��]��g��Y�$��籢��ț��ͮ\x07������y!�粀��z.\v�,�粀��z.\v�,�粀��z.\v�,�粀��z.\v�,�粀��ze՜�ֿ����c�{ҝ��u��Vz�S�\x1B3	uZ����H�٪r�>k�.~����#�k���������T���{t�x9��'�4�x������Л�rZ\x07E5�ڪ��,,E��x����7��]o�7G��?�O��1�����r��O\x07=��\`?0m-���?d��Fz������Gw�E=�8�Դ���_��:5У�Gn�N���.��㧁}��M[�V� ���O'��4m%[�\\����̴�l�sY@�e=��\\�sY@�e=��\\�sY@�e�Mo}�J��Սk�-]�|�w��qs��ol�O�J�~��v;�cw�ѻ@�"��H֭!>�~7�3!�;)���z���$#��#77B�W��.G<���L����(ЫF�����:�w���1���d�J�Ho\0���6��K)�<������x����쓰 6{�\`��K��#[�ҝ� ЫB�r�a�Q����$������]���ѻ�\f+�[�,�\0ʦw몺%|�\\\x07z��P\x1B;<=���S>�U�w7��Yi�Py���L�|�ġ���6/_��+.\x1B\x1B(L\ve�����y�3	zѷ�����A�w�Pt����R?x�{���@�۪��.I$$zw�"~�� ��yw���ozw
D����b��*�|$f��ݾ+~K���{��9D@�;��(4d�n���ySX��2�[(��E)>O��K7Cw}��-��]���\fQ��^X����r�_���/��y�$�5�ӻ!4D�{tQ�pݖ\`lz^�K\v1oH�������1*'(�h9zץoY�)~�#�^�Ӂ���7WTo%�m�g�]���ݨI��9��^X爕��|���M>�K�L�\x1B<�������yM�wW���%�[������q����<�mŵ�'2j�"�6�+�J\f�ѻ����=1��R������6z��&���X#���(Bo]x�b8z\x1B\x1BҠ����s�Ԥw\0�I� sS����\b=��͔q��qf��@�+׊$�\x07�1y4\v�]��$�u�{��[�+�nR��H/��o�WU��:(���I������;\x1B6Y8_����f�P�[|h\\�_�u�%O�\0ы��������8�,D�O���\`R�w�\v��ޑ�W�+��q��+��:R�\rM�͔7�#��s{\x1Bx�ᖊ^�����#����K�nq-r�֣}����_z�R邯��S�����=.���O.c�S흛R\x07�?I�QK���Bg�zbN�������]A�J�HWc��,Y&��M���\x1BJO��1s|���K,CH��4�d��Wz�j=����j-h�ZK��z����һ��!����e�N?�]E);�7��\\^����h�cq��w%����^�A��	�8���7頼�^c�ȋ�\vS�\x1B��)�k��Gv�G�Ɠ^<⮢��E�\\�
k��@��ǈ����Dz��#Y��>�p�8�c��Z'�\v���$>R�\`u���:��o
�CEzd�PȔ�M)�\v�?�9�\b=,7�yJ/,�m
W�5R�_R�k�p\v�Đ^����2��1ܠ�q��z��k�4Օ��|��܈�doE+f��=eIz�⎨��$G����#���������md��a�c�ȰS�����$�.ody���&�c*=bv!Db�B�t-�o(Lz�UPb��^0�$<�r��量!����\x1B�����9z_��@n�IZR\r42�e�A=H��΄h��6�����1�����Z��Juɒ�绀��z.\v�,�粀��z.\v�,�粀��r��X�����V�U[���ߛ�W�_�6����\x1Bl�o_6)��6���o�@��lc���L\x1B�F}��������h� �L����\fO\v=�:���o�\\V�{�G���B�1�x��X�yô�V�k�(_S���ט1m4��&z,c\x07�iR���F��2m�U\x07<m����T-���kLwL[�bi�t�\v&?\b=�j��O+� �l@YsSu��M/Ps�
�ѿ2݃P�+�5ӳDS��tF!_�uд�.�@�қB�}�<���\x07�\v��Oz���jʱl���H�U�Z�}�^X��1ݍ��%�h���%��%��蜼�[|�7\x1B�Ӽ��-��m6m�=�[>�c��q�]�Y�\x1B�����R�<�7�����Go���{��?z��(�\x1B\`��w����~�-��\x1B�i���.yGoR����+��\x1B�	yS��q�o�{���[<����I��;��3z���>/�zFO�\x1B���e~ћV��9n�^�Ф!:9����t��\b�ΒUv7�yE�\x1B$\b�&���4���u�^��ah���e>ћ�\f�K�^���vs�O��X�;��|�+A�[=��\\�sY@�e=��\\�sY@�e=��\\�sY@�e=��\\�sY@�eU�7=޵L�^�9�=IhZ�2Ez��m@ՙ�\b�=x�x)�{�xz�UN� ��뾦���a��WK�����ƫt��Q�҃_��(-w6��7\vn��t�}%��U�7\b��!�,GO�����TH������Y�7�~��?��|��>�J�����OM\x1B�1����p�G���Ǟ�𷦍�~F�W���R��.��\x1B^��s����t������\x1BJ��HJѣ_�?M[�I�ȳ��c5z���>z믁��z.\v�,�粀��z.\v�,�粀��z.\v�,�WJ��__��V�7:B�!yӣ����h�3V�1B��޾��	�B�E;��픣;��\v��P#����N��9E��yt����}m%�;wӯTAN�CORM?Rz��^:=ܝ{Zp��S��{h���
:��fR�s�XT��\x07�J�m�\x07GF�aA���\fz�X����J9� f��x��
��\\e�\x1B�C�>\r���ؓ���\b�=Rwcxe��I��8�D�:�#�FHo{��0]Y�>}Z$2r�v��	�q�#���(\x1B\f�Lz�b4^N��V��	f����A�@�I���+I�� �N�+�I�}��"���)IV\x07r��Io'-Fs��#UʷE.R��6�ěh�?�'A�R�ؖ��o�\x1B�A����gG�h����S������Qz��dwBb�ޣ-�8�1;�0<2=��쨺�%NH����Z!�v�/����]�u�E�aҝ<\r����axB�����8�ףG�\r�h�Y��}]zi�\x1B\`��0���<࿋�{D\\&9��)w�\0�'�N���r���v�˝���Ã\f�]v�}~���@o�JM�E��ˁ9�'=�\v0=aj���f�{����J���kV
N�s���JS�=j�	�63O���4�n\vA�c�d(>���K^vK����Ἁ�1z�l�S|��H���H��\x1B�=B �n��
�Ä�}Ħ��(qpG��=�Ob��Ϙ/��Ɔ��m)��mE6�S�n����	�\x07V�W�����9�|9�
�-��\x1B����a�v#�BK=:L)��L!?�>RxX<��Rz����Ρ7�ǩ��		s}� ��?��WY�S��
�|��{���F��z;������z��G���6aWd�|�Y){J�OG"zOQ�����@���Ԭ�ҀC�C�I�Y������!B�m�>6\bz���z;$��e����+��8��M&�>�&�z���S�G̍���\v|�}��'�_O5GL/.�d\r>��=ul� ������Y�\0��S��,s���Xkk�k��rl	�k<PH��\0eڔO:�q$6u?� �G�y� �c)��b$�\x1B����\0#�����A�Ή߿\x1BVO�ޤ��O��y�K�rv����\`����ܽx��z1Bo�Qd����<����C/�\r���NQ\\�@��;҇�M���	�e
ط�n��7�/S;H/N�����wIŴ���ܟ\v	��Jٽ�b�d�3D�9�0�cf���.�^b"����ws�2҆4L��������Z�?�\x1B�\x1B(�G(Q�cNŧ���I
�8m�X�\x1B�i�����	'��P����;r]��|�3JOgoE/�&�\f��G�)�{�7:�l�a�[��1ݏ�\0�\vm!�'���0n'i�m5��-��6l�H��k\fO(=9�f�y��
_�E��Ja$�C⛨p��dz�0�/������{�\0��b
��YW/{
fG�{��Ş��"�2��^�+I��&U�̐�]�\rC�����.�a!,�=�n_\vou�0b���x�P��\v\`cs�\0��Dj�Z1�������:�����<��B��]�6"7�����G�\x07�%��Ax��&6[�l�X7���M("+�%?g���m���{����P:y���9��V�¸)�	�$�G�-�������{�Q�M/��r��~�A�,�Dg�@<y��{�E�
���]�b��
��B�\b����p���dZŬ��^A�X�K=�Tغ�%���TzO<��aH=	���Ts��\0{��l*E�{��}\fB�_��1d�i��)�Z�(��E4�CDDI�?��Y����V��Ч{g��n1,���B�^	m�j��|��+�b�k�B�W�k�L���f]�^ч��2�-2�*л����
�R��W��=Ϟh������
9f,[���'���ZB~1��~���O���׉?�iC���E/~3�}9F�~�rx��Z�i��8�����7�؏OV�W�^�v\0�F�P�)�W}�+G��b]@�\0�����~�\f׮�8KқE�~�#P�V��/����"PEu������O�yUN*Лm�>{�5�^iz�	�WE&�*��<�K�ȫB�ќ7mW59�\x07^z��\x1B�r\x07UM�*� x���r"\x07O��:bMM�\b�i\v�o������cj�g������B��k�
묖����3݇�Sz��fMwb4��=��2݋��'=���a��vyI��\`��[������o�vyI/���N�����&�s�>n��3�{��!=n�b�=wv�CzS�^�t_j���:����?�?z��r��q���}޾;��'m�ֳw�VyGO���w����H͘�P��ތ�\rh�t��o��{}�[<�7���u��=ŝim�}�Q��S���"�_���|�\\���lh���w<�[��Gb��YZ��6�ؕΛ�Wm��<B�i�N��͖ϛ�|��l�Iz��\v���7n��x+d"��uo���Œ��+�粀��z.\v�,�粀��z.\v�,�粀��z.\v�,�粀��z.\v�,�粌ћ����I��C�����u}C�k�-�f�5��Z�e@��]?~�a����\fЛp��2=����xs�&�Ϥ9=�����e��&L�[�����k�3��2�X����L��2Zz�m�?��_��I���~}�;���h�qO���/?sX�\x1B+�h�,�צ�_U�\`���\`6Rz�Q8?7m|���=�g����8����5��u\fz���Ѵ�u�W�Z46���M[^�(=c�\r#�Gg��x���@�a��\`ћz@�=��\\�sY@�e=��\\�+�g{�Ï}���41�7��_ ^{�4�=h�9�\x1B�ϑ��@�z���ۿ�{C��\vQ~�ܠ����a?#�*[荂�x�K�u8O�7z�z\b��_��zC�7z/��\f;�=�g=�w�(K��\fυ@�zz_�1�P�YO�m"f!
�$z����x��ޞTqy�U�P����0S���쑼�7\\%��\r�"��W��\\������	\rs��p���/��&z�D���� f�7o�#�\v\v�^��z\x07���{)�P�M��+�=2�b��\f��}�\v2
)1��_����s�]@��Ͼ�\f�0�ϩ{����}�e�d��d�>�?A��7�C$�@/[��2����~M\x07�K��3�B\`�^�e����\x07�@/Gl�z�$�a�K�C��s9\`�^\`���|ÿ\v�,�;�^�^�ac���DT�&roe��*7�^/��u��U���.�{�H��#�~���0,2�
?����\x07�
��1~�\f�;EB�bo�*���^䲧��N������/�+E�Ƙ��,�����g/�R@OÎ���,�6UC��a�E���'������\0I�O��,?���
|h��P��\f��P�\0�J�\f"2�^�ᾬ�\\���]�ޛ4z���@��p�ы�e�:Q����"�|	�FN�X�䍽g�fB
BA�MQ'	��,5&�^�=��	z�J��D���	�J�SW�i=%#�|�\0���Q�݅@/C�Z����T�{��I��\0���v��<�7̼�Sn)�,��ȐQ�Zޑ|B��)bN���˭��/
����#ʍ&ta ���.<"x���Z1�}�2�p	YU�z�er�!�C_$��B/���Yڶ�2�z�e\fo�q\v��:�����7r<.���Hp�Zn�X��e��J���z\\�Z�ϣ��\x07�[n�ٟ�s����R�P��-R���\vR�/��Z^}N�"������zo'n_\vٔ�p}��;��^�ZK����ɾ��_������!$�_�A�#K|/��p��{�$z3�'��\ri�m��\v���\vnY6��cVڵ��7i�拈��[v��\x07�
hO�S�����{���/���o_}����\v~���;�+�W{�BOoO�Ȉ�n�����}�*�)Y���y7�}�@�e=��\\�sY@�e=��\\�sY@�e=��\\�sY\x07�ޯL\x1B^�������b��7{ ��_[����M�A�F���yz��|c���ņ����פ'�~a��U���L\fz�1��7n;�_2x榽ӛf����o~�*���o�i�7bz��<���7jz�M�_]s�FM�1e�غ5i���5Z�ͭW�恢��΄Ix���<猎<#�����Gmsi�Az�Ƹ\x07��]���Fcvj�a������Lҫ[\`�\x07����Zȼ_�_��k����N��\v����>�@��� ��MF'?鑕(�+7�����j�����Kz��)�\\�����\rO����Kz�蜬���)����4f�'u�Gzl��q���fY5y�t_j��������,鵹��qӝ�W��\x1B����\`$򏞸����;z�<ϋ��ѓ6��oY�|��l����[|�7.�3�S�n�F/�Q��n�z���<����n��8n�^"f��xs�_��\x1B\\���ǋ�~�#˲�?��i>\\+�ws�W��V�v�=� ���q�W􂘥5���	\`���'zM4I��@�ќ�ws�O�f���H�ј�v��'z�dz�
�,�粀��z.\v�,�粀��z.\v�,�粀��z.\v�,�粀��z.\v�,�粀��z.\v�,��&�g��Eo$�3ݓ���Zwk���~jr���?5�kv�U��c��u�>z3�.]��8Pm�櫜�����?��y��lu�]�짉��U���Co��i���;-������h�'���gAT��-��w��?����΀8��˜q�W�t���}մ���7�N����#:�uh�>2m*\x1B����>�k.�1��%ӆ�S߮�uj�Gd��L��R��\r�;i�@�N{_7m%[���B����7M[�V1�i1�/����z.\v�,�粀��z.\v�,�粀��z.\v�,�粀����i�\\��E|t�\\��\b�\x07z9f^L9�ҫD�z�@���{�G\v�[B���Y�W�ZM5^z՛zE�]P\\C�Un��һ���:�,IOG�@/�^	�g
���˥��h���[��ű��إ��t4\v��魪s3b�
�44\v���a_���ֈ�@OC�@�\0�EUn�'Q�l�~?�Ҿ4���\r�,�+O�*7["�h�E�)�u�\r��R2��#�+L���dn�ڐ�wnI���s�j�U�����.����ax��}�d�ϡW�Y�W��\x1B�6\\�\\#Go9|o��"3���W�Y�W�?b���5�̗�hg<��RI�H�@�:�K�@:\x07����ɷ���^�f�^uz؈��.��b���|B��W�Y�7<=��\v0��d��W��B�d��m�頷&�$,�\`�������~z��=����0k���P�^~�@O\x07�j�3$�^��K������m����f瘿S�[\v|h�����m����f�Y4)һԿH-��X�^n�@O\v=���pK;<�~/��^/1�9�zZ��\f�/�23��Z�_�?�O/�Y������8�e\f�F��"}�\0��f�V�^	zqn����#��U�^v�
z�^	z��X��#�̉傢���U�[ze�E�Y�7Ylf< ���b1gv�䃋�v������L�
����ڽ��fU��K@�\f�07[V�b3�&��B�l=�YRo�%�z����l�N�Y�9��z2��͆�Oy	蕡��XO\\Ӊ͌��%�� �<�E�]����>I*�+E/ܬ�\x1BL����z�w�5��U�Y��;��_z�� �DGF�L���%�K�0������Bԗo6��h�4��\x1B�x蕣G�����̼���[�7^̠��l<2c-�\0���V��<�ی{\x07�+�|��_N���lp��^\b=�Z\rW�X�z�JsL\v��Ő���\x07�@=��\\�sY@�e=��\\�sY@�e9A~,ENЃ��K�Ϳ�\x07�}�'��~w6GV��,��s����g���L��{��u"t�k��e�~�e�8��z��Ct�,��[�e�M+�5�\b��)����k̘6�\vҝ.h�'�N�J�~S\x1B=�����~x��5�M��nM��\0O��\f�.隯�mj��hv��Zs�k,5�\v���\r{b�״e\v��U���|-NS?=������y��\x1B���ҟ��e�Eo8M��ՠ�m-2LoL�]�fk�/�Yz���2m�\\�5;�1����R�3�u�����#���M4+,�Zy�����9�*̂��ƌҋ�|ƴ2�=[y����ɏ�6B����טIz��]_1B��_c&�Ѳ��sJ�qd�5f��K۴2D\rd�5f��\v7m�Tq��,������ְ�C��=�]c��	{),�S���r�]c�艻\b�M�!E���k�=�.�7���$��3FO���s
���3EO�����H��h�5f�^b�g����,��\f�K����)d�5f�^�.��)\r��RK�1C��v�nN�oȷ�3COa\v�T�fص��\f=�=+�m�i"�1#��'��I\x1B��v|���K۾k�\b=b��Y����qb#��27�����s͖uטz�]:�ܳ&�\x1Bͮus
�2�
.(J�ј���3Ao�	(�^�M�,�SƢ[8zA�;V]c&荵��W���6��v�F�8	��-&��\v-=v�5c)ҳ��&w%%�Y)��Mzyzj��zyzj��zyzj��zyzj��zyzj��zyzj��zyzj��zyzj��zyzj��zyzj��zyzj��zyzj��zyzj��zyzj��zyzj��zyzj��zyzj��zyzj��zyzjMw����׵�!	u�^��Jӿ�\b�&�粀��z \b�@ \b�@>��#��2ϡ#GLw4�br�Y�HУ�i\x07�;�;|�����_}<�\r��7�Wo'NC	;a�je�#D�.�CY�U���'k����H���\f�$�\fz��FƮ4ܳc���p�;N�e�5'b7z�x����HM���]�*\x07O��
�ک�ȰYF8�v��E��O�8֪
=ϡ����!���#�ر���l��M1�j6�0\`S���Ɗ�/���i�=<�3�~���el��>i�6�
Iz$�:d���w"���z�a2o|�v����M��ar�2���z/=�{/˫V��c�C���C��R�;u�π;��ȇ���Hά���DX�H���L�1��S9V��:�wq��y�-���҃�����+�k�>��~n@�[�\x1B�dzǏY��N�x���d�K�N�:�QJ�g����	utp8mLjұ|\x1B|h���0[�L�z~;�:jQF�+��tJ%�;bQ(�Qe�p�^�u���Q��/�ӣܿ\rW�dW]�j^�+���a����i��k*G�J����>jCd��K���d����˾P�Gl�h�����ƽ�(��|��d/﹑[���"z���\x1B�\\g2B���RP!z'lHBzau��6�\vIJf\x07��������g~�l�\x07�˰ޯ7�k��9�9�!�"����,V�[Q\vW\`9|ں�����X���V��X޳/rى�=�[ٺ�w�={n������jE*euʋ�T��Y���e��N�Ū�ǭpQG�9�!{�gC����(��\v��\x1B��j_�m�\v�Z��*�:k�
W�)�-r!a�qڵ�/��vF����9m�\\���Ñ���ջ��DmݕDdY�r�����=j���;I�{wY��ղ�#���ݸRh{�n0'79X�\x1B˲�%^V8:�NQ]���~tm۰�'�"�"�hI�\f��\\�ʫ7��=iͼ�s��-�KX�:1�M��՛��\x07qY�ˤ�;kU��ǜa��r���V�agܷnS�Bʊ�I�b)�|>~�_�1�\fz�l��]ֈw�'�:p�\b{\0��L��(c|����X��'�\b��)e>mǦ�%��G<�<m�C��V&�p���\v��������Ӥ\x07���{f�\v#+��\fݸ��{���#G����y|�r:j��-�0z������Os0��	��\0\0\0\0IEND�B\`�`})))()}var _;function v(){return(v=e((()=>{_=`\\documentclass{article}

\\usepackage[preprint]{neurips}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath,amssymb,amsfonts}
\\usepackage{booktabs}
\\usepackage{graphicx}
\\usepackage{microtype}
\\usepackage{xcolor}
\\usepackage{url}
\\usepackage{hyperref}

\\title{Understanding Attention: A Worked Guide to Transformer Reasoning}
\\author{Lattice Tutorial \\\\
An editable, collaborative example project \\\\
\\texttt{hello@lattice.example}}

\\begin{document}
\\maketitle

\\begin{abstract}
Attention turns a collection of token representations into context-sensitive representations by learning which pieces of information should interact.
This tutorial develops that operation from a small numerical example, connects it to multi-head self-attention and the Transformer block, and surveys several influential extensions.
The manuscript is deliberately written as a compact NeurIPS-style research note so that it can demonstrate editing, citation management, figures, and collaboration inside Lattice.
All diagrams and prose in this project are original teaching material; cited papers remain the sources for architectural and empirical claims.
% Tutorial: revise the final sentence above, then select Build to see the PDF update.
\\end{abstract}

\\section{From sequence models to attention}

A sequence model must decide how information at one position can influence another.
Recurrent neural networks pass a hidden state from left to right, creating a path whose length grows with token distance.
Additive attention introduced a learned alignment mechanism that let a decoder retrieve different encoder states instead of compressing an entire source sentence into one fixed vector \\citep{bahdanau2015neural}.
Multiplicative variants made this retrieval efficient and became a standard component of neural machine translation systems \\citep{luong2015effective}.

The Transformer made a stronger design choice: attention became the principal mechanism for communication between positions, while recurrence and convolution disappeared from the main sequence-processing path \\citep{vaswani2017attention}.
That choice exposes parallel computation during training and gives every pair of positions a direct interaction path within a layer.
It does not make sequence modeling free: dense attention stores a score for every query--key pair, producing quadratic time and memory growth in sequence length.
Later work therefore explores sparse, kernelized, recurrent, and hardware-aware alternatives \\citep{tay2022efficient,choromanski2021rethinking,dao2022flashattention}.

\\section{Scaled dot-product attention}

Let $X\\in\\mathbb{R}^{n\\times d}$ contain one representation for each of $n$ tokens.
Learned projections produce queries, keys, and values,
\\begin{equation}
  Q=XW_Q,\\qquad K=XW_K,\\qquad V=XW_V.
\\end{equation}
The output is
\\begin{equation}
  \\operatorname{Attention}(Q,K,V)
  = \\operatorname{softmax}\\!\\left(\\frac{QK^\\top}{\\sqrt{d_k}}\\right)V.
  \\label{eq:attention}
\\end{equation}
Each row of $QK^\\top$ contains compatibility scores between one query and all keys.
The row-wise softmax converts those scores into non-negative weights that sum to one, and the weighted sum of value vectors forms the output for that query.
The factor $1/\\sqrt{d_k}$ controls score magnitude: if query and key coordinates have roughly unit variance, their dot product variance grows with $d_k$, which can push softmax into regions with very small gradients \\citep{vaswani2017attention}.

\\subsection{A numerical example}

Consider the four-token fragment \`\`attention connects every position.''
For the query at \\emph{connects}, suppose the scaled scores are $[0.4,1.2,0.1,0.8]$.
Applying softmax gives approximately $[0.18,0.41,0.14,0.27]$ after rounding.
The new representation at \\emph{connects} is therefore a convex combination of all four value vectors, with the largest contribution coming from its own value in this illustrative head.
Changing the softmax temperature alters concentration but not the underlying value vectors; the interactive HTML file in this project lets the reader inspect that distinction.

\\begin{figure}[t]
  \\centering
  \\includegraphics[height=.25\\textheight]{figures/scaled-dot-product-attention.png}
  \\hfill
  \\includegraphics[height=.25\\textheight]{figures/multi-head-attention.png}
  \\caption{Scaled dot-product attention (left) and multi-head attention (right), reproduced from Figure~2 of \\citet{vaswani2017attention} with permission from Google for use in scholarly works.}
  \\label{fig:attention-map}
\\end{figure}

\\section{Multi-head attention and Transformer blocks}

A single attention distribution offers one way to route information.
Multi-head attention applies several sets of projections in parallel,
\\begin{align}
  \\operatorname{head}_i &= \\operatorname{Attention}(QW_i^Q,KW_i^K,VW_i^V),\\\\
  \\operatorname{MHA}(Q,K,V) &= \\operatorname{Concat}(\\operatorname{head}_1,\\ldots,\\operatorname{head}_h)W^O.
\\end{align}
Different heads are free to learn different interactions, although a head should not automatically be interpreted as a clean linguistic rule.
Attention visualizations describe routing weights inside a model, not a causal explanation of the model's final prediction.

In an encoder block, multi-head self-attention is followed by a position-wise feed-forward network, with residual connections and normalization around sublayers.
Because self-attention alone is permutation equivariant, the model also receives positional information.
The original Transformer used sinusoidal encodings \\citep{vaswani2017attention}; many later architectures use learned or relative position representations.
Masking changes which keys are visible: bidirectional encoders such as BERT can condition on tokens on both sides \\citep{devlin2019bert}, whereas autoregressive language models mask future positions so generation remains causal \\citep{brown2020language}.

\\section{Where the pattern is used}

The same computation supports several application regimes.
BERT scales bidirectional Transformer encoders and adapts them to language understanding through pretraining and fine-tuning \\citep{devlin2019bert}.
GPT-3 studies autoregressive scaling and in-context task specification without gradient updates at evaluation time \\citep{brown2020language}.
Vision Transformers divide an image into patches and process the resulting sequence with a largely standard Transformer encoder \\citep{dosovitskiy2021image}.
These systems differ in objective, masking, data, and scale, so \`\`uses attention'' is only the beginning of an architectural description.

\\begin{table}[t]
  \\centering
  \\caption{Representative uses of Transformer attention. The table summarizes architectural roles rather than comparing reported scores across incompatible tasks.}
  \\label{tab:applications}
  \\begin{tabular}{@{}llll@{}}
    \\toprule
    System & Input unit & Visibility & Representative use \\\\
    \\midrule
    Transformer & Text token & Encoder / causal & Translation \\\\
    BERT & WordPiece & Bidirectional & Language understanding \\\\
    GPT-3 & Text token & Causal & Autoregressive generation \\\\
    ViT & Image patch & Bidirectional & Image classification \\\\
    \\bottomrule
  \\end{tabular}
\\end{table}

\\section{Efficiency and implementation}

For sequence length $n$, dense attention materializes an $n\\times n$ score matrix.
Approximation methods reduce this cost by restricting interactions or rewriting the softmax computation.
The Performer, for example, approximates softmax attention with random features and computes associations without explicitly storing the full attention matrix \\citep{choromanski2021rethinking}.
The broader design space includes fixed patterns, learned sparsity, low-rank projections, recurrence, and memory mechanisms; a survey by \\citet{tay2022efficient} organizes these approaches and their trade-offs.

Algorithmic complexity is only part of runtime behavior.
FlashAttention computes exact attention while tiling operations to reduce expensive transfers between levels of GPU memory \\citep{dao2022flashattention}.
This distinction is useful when evaluating a claimed improvement: an approximation changes the mathematical operation, whereas an input/output-aware kernel can preserve the operation but execute it more efficiently on specific hardware.
Benchmarks should report sequence length, precision, hardware, memory use, and end-to-end context because asymptotic notation alone cannot predict practical speed.

\\section{What attention does not establish}

Attention weights can be inspected, but inspection does not by itself identify why a model produced an output.
Weights are conditioned on learned representations, interact with residual streams and feed-forward layers, and may be transformed by later blocks.
Likewise, long-range connectivity does not guarantee reliable long-context reasoning: optimization, positional representation, data coverage, and retrieval behavior still matter.
A careful analysis combines mechanistic probes with controlled interventions and task-level evaluation rather than treating one heat map as a complete explanation.

\\section{Reproducible learning workflow}

This repository is also a worked example of a research workspace.
The LaTeX source uses the bundled NeurIPS 2026 preprint style; \\texttt{notes.md} separates reading notes from publication prose; \\texttt{attention-demo.html} provides an interactive explanation; and \\texttt{figures/} contains the cited source panels and a publication-ready PDF copy.
The bibliography gives the Papers panel several records to manage.
Before adding a new factual claim, import or open its source, record the evidence in the notes, make the manuscript change, and review the resulting project history with collaborators.

\\section{Conclusion}

Scaled dot-product attention is a compact routing operation: compare queries with keys, normalize the scores, and mix values.
Multi-head projections, positional information, masking, residual computation, data, and implementation strategy turn that operation into a useful model.
Understanding those surrounding choices prevents the attention equation from becoming an explanation that is simultaneously familiar and incomplete.

\\bibliographystyle{plainnat}
\\bibliography{references}

\\end{document}
`})))()}var y;function b(){return(b=e((()=>{y=`# Markdown component gallery

This document demonstrates the Markdown text styles, blocks, media, math, diagrams, and interactive embeds available in Lattice.
Edit the source on the left or work directly with the formatted document on the right.
Select a block and use its \`+\` button to browse the complete insertion catalog.

## Headings, rich text, and links

### Inline formatting

Combine **strong emphasis**, *italics*, ***bold italics***, ~~revisions~~, \`inline code\`, and a [link to the original paper](https://arxiv.org/abs/1706.03762) in ordinary prose.
Inline math such as $d_k=64$ and $QK^\\top$ stays editable while retaining its LaTeX source.
An escaped character such as \\* remains literal, and an emoji such as 🧭 can sit beside regular text.

> Attention is a routing mechanism: each output combines values according to query–key compatibility.
>
> A block quote can contain more than one paragraph when an explanation needs context.

---

## Callout and accordion

<Callout type="important" title="Attention maps need validation">
Attention weights show routing patterns, but they do not establish causality. Compare them with ablations or attribution methods before drawing a conclusion.
</Callout>

The surrounding explanation remains ordinary Markdown, so it stays easy to scan and edit.
The accordion is only a compact optional aside:

<Accordion title="Why scale attention scores?" defaultOpen>
Scaling keeps the softmax distribution and its gradients well behaved.
</Accordion>

## Lists and tasks

Unordered lists work well for parallel ideas:

- Queries describe what each position is looking for.
- Keys describe what each position can match.
- Values carry the information that gets combined.
  - A nested item can add detail without starting a new section.
  - Another nested item keeps related evidence grouped.

Numbered lists make a sequence explicit:

1. Compute scaled query–key scores.
2. Normalize the scores with softmax.
3. Combine the value vectors using those weights.

Task lists keep research work actionable:

- [x] Add the original Transformer paper.
- [x] Check the dimensions in the attention equation.
- [ ] Compare the explanation with the interactive HTML demo.

## Tables and inline math

| Component | Shape | Purpose |
| --- | --- | --- |
| Queries | $n \\times d_k$ | Express what each token seeks |
| Keys | $n \\times d_k$ | Provide matching features |
| Values | $n \\times d_v$ | Carry information to aggregate |
| Scores | $n \\times n$ | Compare every query with every key |

The Shape column uses inline math rather than code formatting, so subscripts and operators render correctly.

## Display math

The visual editor renders display math while preserving the underlying Markdown source.

$$
\\operatorname{Attention}(Q,K,V)=\\operatorname{softmax}\\left(\\frac{QK^\\top}{\\sqrt{d_k}}\\right)V
$$

## Code block

Fenced code blocks preserve indentation, expose their language, and support syntax highlighting.
This example implements the complete scaled dot-product operation rather than only listing its three equations.

\`\`\`python title="Scaled dot-product attention in NumPy"
import numpy as np

def softmax(values: np.ndarray, axis: int = -1) -> np.ndarray:
    shifted = values - values.max(axis=axis, keepdims=True)
    exponentials = np.exp(shifted)
    return exponentials / exponentials.sum(axis=axis, keepdims=True)

def scaled_dot_product_attention(
    queries: np.ndarray,
    keys: np.ndarray,
    values: np.ndarray,
    mask: np.ndarray | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    key_dimension = keys.shape[-1]
    scores = queries @ keys.swapaxes(-1, -2) / np.sqrt(key_dimension)
    if mask is not None:
        scores = np.where(mask, scores, -np.inf)
    weights = softmax(scores, axis=-1)
    context = weights @ values
    return context, weights
\`\`\`

## Figure

<img src="figures/scaled-dot-product-attention.png" alt="Scaled dot-product attention from Figure 2 of the Transformer paper" width={223} />

## Diagram

\`\`\`mermaid title="From queries and keys to contextual representations"
flowchart LR
  Q[Queries] --> S[Scaled scores]
  K[Keys] --> S
  S --> W[Softmax weights]
  W --> C[Context]
  V[Values] --> C
\`\`\`

## Embedded HTML

An \`html preview\` fence runs HTML, CSS, and JavaScript in a sandboxed inline frame.
Use the buttons in this compact attention demo, then open [attention-demo.html](attention-demo.html) for the full project-sized visualization shown in the next tutorial step.

\`\`\`html preview h=360px title="Embedded attention demo"
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 0; padding: 24px; background: Canvas; color: CanvasText; }
    .tokens { display: flex; flex-wrap: wrap; gap: 8px; }
    button { padding: 8px 12px; border: 1px solid color-mix(in srgb, CanvasText 18%, Canvas); border-radius: 9px; background: Canvas; color: inherit; }
    button[aria-pressed="true"] { border-color: #6757d9; background: #6757d9; color: white; }
    .bars { display: grid; gap: 8px; margin-top: 20px; }
    .bar { display: grid; grid-template-columns: 76px 1fr 42px; gap: 10px; align-items: center; }
    .track { height: 9px; overflow: hidden; border-radius: 99px; background: color-mix(in srgb, CanvasText 10%, Canvas); }
    .fill { height: 100%; border-radius: inherit; background: #6757d9; transition: width 160ms ease-out; }
  </style>
</head>
<body>
  <strong>Select a query token</strong>
  <p>The bars show its illustrative attention distribution.</p>
  <div class="tokens" aria-label="Query token"></div>
  <div class="bars" aria-live="polite"></div>
  <script>
    const tokens = ["attention", "connects", "every", "position"];
    const rows = [
      [0.58, 0.24, 0.12, 0.06],
      [0.14, 0.50, 0.11, 0.25],
      [0.08, 0.17, 0.48, 0.27],
      [0.06, 0.16, 0.29, 0.49]
    ];
    const buttons = document.querySelector(".tokens");
    const bars = document.querySelector(".bars");

    function render(selected) {
      buttons.innerHTML = tokens.map((token, index) =>
        \`<button aria-pressed="\${index === selected}" data-index="\${index}">\${token}</button>\`
      ).join("");
      bars.innerHTML = rows[selected].map((weight, index) => \`
        <div class="bar">
          <span>\${tokens[index]}</span>
          <div class="track"><div class="fill" style="width:\${weight * 100}%"></div></div>
          <output>\${weight.toFixed(2)}</output>
        </div>\`).join("");
      buttons.querySelectorAll("button").forEach(button =>
        button.addEventListener("click", () => render(Number(button.dataset.index)))
      );
    }

    render(1);
  <\/script>
</body>
</html>
\`\`\`

## Footnotes

Footnotes keep supporting context close without overloading the main paragraph.[^components]

[^components]: Type \`/\` on an empty line to browse everything that can be inserted.
`})))()}var x;function S(){return(S=e((()=>{x=`# Example project metadata for the Lattice format preview.
# Lattice keeps its own settings separately; this file is safe to edit.

[project]
title = "Understanding Attention"
kind = "tutorial"
primary_document = "main.tex"
bibliography = "references.bib"
keywords = ["attention", "transformers", "research-writing"]

[preview]
compile_on_save = true
default_view = "split"

[demo]
markdown = "notes.md"
html = "attention-demo.html"
board = "attention-map.tldr"
spreadsheet = "attention-results.lattice-sheet"
`})))()}var C;function w(){return(w=e((()=>{C=`@inproceedings{dosovitskiy2021image,
  author        = {Dosovitskiy, Alexey and Beyer, Lucas and Kolesnikov, Alexander and Weissenborn, Dirk and Zhai, Xiaohua and Unterthiner, Thomas and Dehghani, Mostafa and Minderer, Matthias and Heigold, Georg and Gelly, Sylvain and Uszkoreit, Jakob and Houlsby, Neil},
  title         = {An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale},
  booktitle     = {International Conference on Learning Representations},
  year          = {2021},
  eprint        = {2010.11929},
  archiveprefix = {arXiv},
}

@article{tay2022efficient,
  author        = {Tay, Yi and Dehghani, Mostafa and Bahri, Dara and Metzler, Donald},
  title         = {Efficient Transformers: A Survey},
  journal       = {ACM Computing Surveys},
  year          = {2022},
  eprint        = {2009.06732},
  archiveprefix = {arXiv},
}

@inproceedings{dao2022flashattention,
  author        = {Dao, Tri and Fu, Daniel Y. and Ermon, Stefano and Rudra, Atri and R{\\'e}, Christopher},
  title         = {{FlashAttention}: Fast and Memory-Efficient Exact Attention with {IO}-Awareness},
  booktitle     = {Advances in Neural Information Processing Systems},
  year          = {2022},
  eprint        = {2205.14135},
  archiveprefix = {arXiv},
}

@inproceedings{choromanski2021rethinking,
  author        = {Choromanski, Krzysztof and Likhosherstov, Valerii and Dohan, David and Song, Xingyou and Gane, Andreea and Sarlos, Tamas and Hawkins, Peter and Davis, Jared and Mohiuddin, Afroz and Kaiser, Lukasz and Belanger, David and Colwell, Lucy and Weller, Adrian},
  title         = {Rethinking Attention with Performers},
  booktitle     = {International Conference on Learning Representations},
  year          = {2021},
  eprint        = {2009.14794},
  archiveprefix = {arXiv},
}

@inproceedings{brown2020language,
  author        = {Brown, Tom B. and Mann, Benjamin and Ryder, Nick and Subbiah, Melanie and Kaplan, Jared and Dhariwal, Prafulla and Neelakantan, Arvind and Shyam, Pranav and Sastry, Girish and Askell, Amanda and others},
  title         = {Language Models are Few-Shot Learners},
  booktitle     = {Advances in Neural Information Processing Systems},
  year          = {2020},
  eprint        = {2005.14165},
  archiveprefix = {arXiv},
}

@inproceedings{devlin2019bert,
  author        = {Devlin, Jacob and Chang, Ming-Wei and Lee, Kenton and Toutanova, Kristina},
  title         = {{BERT}: Pre-training of Deep Bidirectional Transformers for Language Understanding},
  booktitle     = {Proceedings of the 2019 Conference of the North American Chapter of the Association for Computational Linguistics},
  year          = {2019},
  eprint        = {1810.04805},
  archiveprefix = {arXiv},
}

@inproceedings{vaswani2017attention,
  author        = {Vaswani, Ashish and Shazeer, Noam and Parmar, Niki and Uszkoreit, Jakob and Jones, Llion and Gomez, Aidan N. and Kaiser, Lukasz and Polosukhin, Illia},
  title         = {Attention Is All You Need},
  booktitle     = {Advances in Neural Information Processing Systems},
  year          = {2017},
  eprint        = {1706.03762},
  archiveprefix = {arXiv},
}

@inproceedings{bahdanau2015neural,
  author        = {Bahdanau, Dzmitry and Cho, Kyunghyun and Bengio, Yoshua},
  title         = {Neural Machine Translation by Jointly Learning to Align and Translate},
  booktitle     = {International Conference on Learning Representations},
  year          = {2015},
  eprint        = {1409.0473},
  archiveprefix = {arXiv},
}

@inproceedings{luong2015effective,
  author        = {Luong, Thang and Pham, Hieu and Manning, Christopher D.},
  title         = {Effective Approaches to Attention-based Neural Machine Translation},
  booktitle     = {Proceedings of the 2015 Conference on Empirical Methods in Natural Language Processing},
  year          = {2015},
}
`})))()}var T;function E(){return(E=e((()=>{T=`import katex from 'katex';
import 'katex/dist/katex.min.css';
import type { CSSProperties, ReactNode } from 'react';
import type { DesignSystem, Page, SlideMeta } from '@open-slide/core';

export const design: DesignSystem = {
  palette: {
    bg: '#fffdf8',
    text: '#29242d',
    accent: '#0087b2',
  },
  fonts: {
    display: '"STIX Two Text", "KaTeX_Main", Georgia, serif',
    body: '"Inter Variable", Inter, -apple-system, BlinkMacSystemFont, sans-serif',
  },
  typeScale: { hero: 104, body: 28 },
  radius: 14,
};

const C = {
  bg: '#fffdf8',
  ink: '#29242d',
  muted: '#716a74',
  blue: '#0087b2',
  blueBg: 'rgba(0, 135, 178, 0.08)',
  blueBorder: 'rgba(0, 135, 178, 0.25)',
  green: '#4d9a3e',
  greenBg: 'rgba(77, 154, 62, 0.08)',
  greenBorder: 'rgba(77, 154, 62, 0.25)',
  red: '#c9535b',
  redBg: 'rgba(201, 83, 91, 0.08)',
  redBorder: 'rgba(201, 83, 91, 0.25)',
  purple: '#6573c8',
  purpleBg: 'rgba(101, 115, 200, 0.08)',
  purpleBorder: 'rgba(101, 115, 200, 0.25)',
  display: '"STIX Two Text", "KaTeX_Main", Georgia, serif',
  body: '"Inter Variable", Inter, -apple-system, BlinkMacSystemFont, sans-serif',
};

const frameStyle: CSSProperties = {
  width: '100%',
  height: '100%',
  boxSizing: 'border-box',
  position: 'relative',
  overflow: 'hidden',
  padding: '76px 92px 60px',
  background: C.bg,
  color: C.ink,
  fontFamily: C.body,
};

const Frame = ({ children }: { children: ReactNode }) => <div style={frameStyle}>{children}</div>;

const Pill = ({ children, tone = 'blue' }: { children: ReactNode; tone?: 'blue' | 'green' | 'red' | 'purple' }) => {
  const colors = {
    blue: { color: C.blue, background: C.blueBg, border: C.blueBorder },
    green: { color: C.green, background: C.greenBg, border: C.greenBorder },
    red: { color: C.red, background: C.redBg, border: C.redBorder },
    purple: { color: C.purple, background: C.purpleBg, border: C.purpleBorder },
  }[tone];
  return (
    <span
      style={{
        padding: '9px 18px',
        border: \`1px solid \${colors.border}\`,
        borderRadius: 999,
        background: colors.background,
        color: colors.color,
        fontSize: 18,
        fontWeight: 750,
        letterSpacing: '0.11em',
        textTransform: 'uppercase',
      }}
    >
      {children}
    </span>
  );
};

const Footer = ({ page }: { page: number }) => (
  <div
    style={{
      position: 'absolute',
      right: 60,
      bottom: 34,
      color: C.muted,
      fontSize: 18,
      letterSpacing: '0.08em',
    }}
  >
    {String(page).padStart(2, '0')} / 02
  </div>
);

const attentionFormula = katex.renderToString(
  String.raw\`\\operatorname{Attention}(Q,K,V)=\\operatorname{softmax}\\!\\left(\\frac{QK^{\\mathsf T}}{\\sqrt{d_k}}\\right)V\`,
  { displayMode: true, throwOnError: false, strict: false },
);

const Cover: Page = () => (
  <Frame>
    <div
      style={{
        position: 'absolute',
        top: -250,
        right: -120,
        width: 620,
        height: 620,
        border: \`1px solid \${C.blueBorder}\`,
        borderRadius: '50%',
      }}
    />
    <div
      style={{
        position: 'absolute',
        right: 170,
        bottom: -300,
        width: 560,
        height: 560,
        border: \`1px solid \${C.redBorder}\`,
        borderRadius: '50%',
      }}
    />
    <div style={{ display: 'flex', gap: 12 }}>
      <Pill>Lattice tutorial</Pill>
      <Pill tone="purple">Open Slide · React + TSX</Pill>
    </div>
    <div style={{ maxWidth: 1420, marginTop: 168 }}>
      <h1
        style={{
          margin: 0,
          fontFamily: C.display,
          fontSize: 126,
          fontWeight: 700,
          lineHeight: 0.98,
          letterSpacing: '-0.045em',
        }}
      >
        Understanding{' '}
        <span
          style={{
            background: \`linear-gradient(135deg, \${C.blue} 0%, \${C.purple} 48%, \${C.red} 100%)\`,
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            fontStyle: 'italic',
          }}
        >
          attention
        </span>
      </h1>
      <p style={{ maxWidth: 980, margin: '38px 0 0', color: C.muted, fontSize: 34, lineHeight: 1.45 }}>
        A live research presentation you can inspect, revise with Agent, and present from Lattice.
      </p>
    </div>
    <div style={{ position: 'absolute', left: 92, bottom: 62, display: 'flex', gap: 12 }}>
      <Pill>Inspect</Pill>
      <Pill tone="green">Agent</Pill>
      <Pill tone="red">Present</Pill>
    </div>
    <Footer page={1} />
  </Frame>
);

const AttentionFlow: Page = () => (
  <Frame>
    <Pill>The core idea · query, key, value</Pill>
    <h2
      style={{
        maxWidth: 1260,
        margin: '28px 0 0',
        fontFamily: C.display,
        fontSize: 70,
        lineHeight: 1.08,
        letterSpacing: '-0.035em',
      }}
    >
      Let the query choose its context
    </h2>
    <p style={{ margin: '18px 0 0', color: C.muted, fontSize: 27 }}>
      Attention scores available signals, then mixes the most useful values.
    </p>
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 82px 1fr 82px 1fr',
        alignItems: 'center',
        marginTop: 76,
      }}
    >
      <div style={{ minHeight: 300, padding: '34px 38px', border: \`1px solid \${C.blueBorder}\`, borderLeft: \`5px solid \${C.blue}\`, borderRadius: 14, background: C.blueBg }}>
        <div style={{ color: C.blue, fontSize: 18, fontWeight: 750, letterSpacing: '0.12em' }}>01 · QUERY</div>
        <h3 style={{ margin: '58px 0 14px', fontFamily: C.display, fontSize: 48 }}>Ask</h3>
        <p style={{ margin: 0, color: C.muted, fontSize: 25, lineHeight: 1.45 }}>What information matters right now?</p>
      </div>
      <div style={{ color: C.blue, fontFamily: C.display, fontSize: 54, textAlign: 'center' }}>→</div>
      <div style={{ minHeight: 300, padding: '34px 38px', border: \`1px solid \${C.purpleBorder}\`, borderLeft: \`5px solid \${C.purple}\`, borderRadius: 14, background: C.purpleBg }}>
        <div style={{ color: C.purple, fontSize: 18, fontWeight: 750, letterSpacing: '0.12em' }}>02 · KEYS</div>
        <h3 style={{ margin: '58px 0 14px', fontFamily: C.display, fontSize: 48 }}>Score</h3>
        <p style={{ margin: 0, color: C.muted, fontSize: 25, lineHeight: 1.45 }}>Compare the query with every signal.</p>
      </div>
      <div style={{ color: C.red, fontFamily: C.display, fontSize: 54, textAlign: 'center' }}>→</div>
      <div style={{ minHeight: 300, padding: '34px 38px', border: \`1px solid \${C.redBorder}\`, borderLeft: \`5px solid \${C.red}\`, borderRadius: 14, background: C.redBg }}>
        <div style={{ color: C.red, fontSize: 18, fontWeight: 750, letterSpacing: '0.12em' }}>03 · VALUES</div>
        <h3 style={{ margin: '58px 0 14px', fontFamily: C.display, fontSize: 48 }}>Mix</h3>
        <p style={{ margin: 0, color: C.muted, fontSize: 25, lineHeight: 1.45 }}>Combine values using those weights.</p>
      </div>
    </div>
    <div
      style={{
        minHeight: 150,
        marginTop: 42,
        padding: '22px 34px',
        border: \`1px solid \${C.greenBorder}\`,
        borderRadius: 12,
        background: C.greenBg,
        display: 'grid',
        gridTemplateColumns: '290px 1fr',
        alignItems: 'center',
      }}
    >
      <div style={{ color: C.green, fontSize: 17, fontWeight: 750, lineHeight: 1.45, letterSpacing: '0.1em' }}>
        SCALED DOT-PRODUCT ATTENTION
      </div>
      <div
        aria-label="Attention of Q, K, and V equals softmax of Q K transpose over the square root of d k, times V"
        style={{ color: C.ink, fontSize: 42, textAlign: 'center' }}
        dangerouslySetInnerHTML={{ __html: attentionFormula }}
      />
    </div>
    <Footer page={2} />
  </Frame>
);

export const meta: SlideMeta = { title: 'Understanding attention' };
export const notes = [
  'Introduce the tutorial deck and explain that it is part of the research project.',
  'Connect query, key, and value to the accompanying tutorial manuscript.',
];
export default [Cover, AttentionFlow] satisfies Page[];
`})))()}var D,O;function k(){return(k=e((()=>{D=[{file:`main.tex`,find:`reproduced from Figure~2 of \\citet{vaswani2017attention} with permission from Google for use in scholarly works.`,replace:`redrawn for Lattice after Figure~2 of \\citet{vaswani2017attention}.`},{file:`main.tex`,find:`\\texttt{figures/} contains the cited source panels and a publication-ready PDF copy.`,replace:`\\texttt{figures/} contains redrawn panels and a publication-ready PDF copy.`},{file:`notes.md`,find:`alt="Scaled dot-product attention from Figure 2 of the Transformer paper"`,replace:`alt="Scaled dot-product attention, redrawn after Figure 2 of the Transformer paper"`},{file:`main.tex`,find:"Consider the four-token fragment ``attention connects every position.''\nFor the query at \\emph{connects}",replace:`% Demo: select this paragraph, then choose Proofread in the toolbar that appears.
Consider the four-token fragment \`\`attention connects every position.''
For a example query at \\emph{connects}`},{file:`main.tex`,find:`Changing the softmax temperature`,replace:`Changing teh softmax temperature`}],O={"//":"Edits the demo makes to the bundled tutorial (src-tauri/templates/tutorial), applied by tools/web-demo/demo-project.ts and by `node scripts/web-demo-content.mjs` before it compiles the PDF. Each `find` must occur exactly once. The figures are Lattice's own drawings (figures/), so the captions say so; the numerical example carries two slips for Proofread to catch (tools/mock-backend/text-tasks.ts).",edits:D}})))()}var A;function j(){return(j=e((()=>{A=`% partial rewrite of the LaTeX2e package for submissions to the
% Conference on Neural Information Processing Systems (NeurIPS):
%
% - uses more LaTeX conventions
% - line numbers at submission time replaced with aligned numbers from
%   lineno package
% - \\nipsfinalcopy replaced with [final] package option
% - automatically loads times package for authors
% - loads natbib automatically; this can be suppressed with the
%   [nonatbib] package option
% - adds foot line to first page identifying the conference
% - adds preprint option for submission to e.g. arXiv
% - conference acronym modified
% - update foot line to display the track name
%
% Roman Garnett (garnett@wustl.edu) and the many authors of
% nips15submit_e.sty, including MK and drstrip@sandia
%
% last revision: January 2026

\\NeedsTeXFormat{LaTeX2e}
\\ProvidesPackage{neurips_2026}[2026-01-29 NeurIPS 2026 submission/camera-ready style file]

% declare final option, which creates camera-ready copy
\\newif\\if@neuripsfinal\\@neuripsfinalfalse
\\DeclareOption{final}{
  \\@neuripsfinaltrue
  \\@anonymousfalse
}

% declare nonatbib option, which does not load natbib in case of
% package clash (users can pass options to natbib via
% \\PassOptionsToPackage)
\\newif\\if@natbib\\@natbibtrue
\\DeclareOption{nonatbib}{
  \\@natbibfalse
}

% declare preprint option, which creates a preprint version ready for
% upload to, e.g., arXiv
\\newif\\if@preprint\\@preprintfalse
\\DeclareOption{preprint}{
  \\@preprinttrue
  \\@anonymousfalse
}

% determine the track of the paper in camera-ready mode
\\newif\\if@main\\@maintrue
\\DeclareOption{main}{
  \\@maintrue
  \\newcommand{\\@trackname}{\\@neuripsordinal\\ Conference on Neural Information Processing Systems (NeurIPS \\@neuripsyear).}
}
\\newif\\if@position\\@positionfalse
\\DeclareOption{position}{
  \\@positiontrue
  \\newcommand{\\@trackname}{\\@neuripsordinal\\ Conference on Neural Information Processing Systems (NeurIPS \\@neuripsyear). Position Paper Track.}
}
\\newif\\if@eandd\\@eanddfalse
\\DeclareOption{eandd}{
  \\@eanddtrue
\\if@neuripsfinal\\@anonymousfalse\\else\\if@preprint\\@anonymousfalse\\else\\@anonymoustrue\\fi\\fi
  \\newcommand{\\@trackname}{\\@neuripsordinal\\ Conference on Neural Information Processing Systems (NeurIPS \\@neuripsyear). Track on Evaluations and Datasets.} 
}
\\newif\\if@creativeai\\@creativeaifalse
\\DeclareOption{creativeai}{
  \\@creativeaitrue
  \\@anonymousfalse
  \\newcommand{\\@trackname}{\\@neuripsordinal\\ Conference on Neural Information Processing Systems (NeurIPS \\@neuripsyear). Creative AI Track.}
}
\\newif\\if@education\\@educationfalse
\\DeclareOption{education}{
  \\@educationtrue
  \\@anonymousfalse
  \\newcommand{\\@trackname}{\\@neuripsordinal\\ Conference on Neural Information Processing Systems (NeurIPS \\@neuripsyear). Education Track.}
}

% For anonymous or non-anonymous
\\newif\\if@anonymous\\@anonymoustrue

% For workshop papers
\\newcommand{\\@workshoptitle}{}
\\newcommand{\\workshoptitle}[1]{\\renewcommand{\\@workshoptitle}{#1}}

\\newif\\if@workshop\\@workshopfalse
\\DeclareOption{sglblindworkshop}{
  \\@workshoptrue
  \\@anonymousfalse
  \\newcommand{\\@trackname}{\\@neuripsordinal\\ Conference on Neural Information Processing Systems (NeurIPS \\@neuripsyear). Workshop: \\@workshoptitle.}
}
\\DeclareOption{dblblindworkshop}{
  \\@workshoptrue
  \\newcommand{\\@trackname}{\\@neuripsordinal\\ Conference on Neural Information Processing Systems (NeurIPS \\@neuripsyear). Workshop: \\@workshoptitle.}
}
\\DeclareOption{nonanonymous}{
  \\@anonymousfalse
}

\\ProcessOptions\\relax

% fonts
\\renewcommand{\\rmdefault}{ptm}
\\renewcommand{\\sfdefault}{phv}

% change this every year for notice string at bottom
\\newcommand{\\@neuripsordinal}{40th}
\\newcommand{\\@neuripsyear}{2026}
\\newcommand{\\@neuripslocation}{Sydney}

% acknowledgments
\\usepackage{environ}
\\newcommand{\\acksection}{\\section*{Acknowledgments and Disclosure of Funding}}
\\NewEnviron{ack}{%
  \\acksection
  \\BODY
}


% load natbib unless told otherwise
\\if@natbib
  \\RequirePackage{natbib}
\\fi





% set page geometry
\\usepackage[verbose=true,letterpaper]{geometry}
\\AtBeginDocument{
  \\newgeometry{
    textheight=9in,
    textwidth=5.5in,
    top=1in,
    headheight=12pt,
    headsep=25pt,
    footskip=30pt
  }
  \\@ifpackageloaded{fullpage}
    {\\PackageWarning{neurips_2026}{fullpage package not allowed! Overwriting formatting.}}
    {}
}

\\widowpenalty=10000
\\clubpenalty=10000
\\flushbottom
\\sloppy


% font sizes with reduced leading
\\renewcommand{\\normalsize}{%
  \\@setfontsize\\normalsize\\@xpt\\@xipt
  \\abovedisplayskip      7\\p@ \\@plus 2\\p@ \\@minus 5\\p@
  \\abovedisplayshortskip \\z@ \\@plus 3\\p@
  \\belowdisplayskip      \\abovedisplayskip
  \\belowdisplayshortskip 4\\p@ \\@plus 3\\p@ \\@minus 3\\p@
}
\\normalsize
\\renewcommand{\\small}{%
  \\@setfontsize\\small\\@ixpt\\@xpt
  \\abovedisplayskip      6\\p@ \\@plus 1.5\\p@ \\@minus 4\\p@
  \\abovedisplayshortskip \\z@  \\@plus 2\\p@
  \\belowdisplayskip      \\abovedisplayskip
  \\belowdisplayshortskip 3\\p@ \\@plus 2\\p@   \\@minus 2\\p@
}
\\renewcommand{\\footnotesize}{\\@setfontsize\\footnotesize\\@ixpt\\@xpt}
\\renewcommand{\\scriptsize}{\\@setfontsize\\scriptsize\\@viipt\\@viiipt}
\\renewcommand{\\tiny}{\\@setfontsize\\tiny\\@vipt\\@viipt}
\\renewcommand{\\large}{\\@setfontsize\\large\\@xiipt{14}}
\\renewcommand{\\Large}{\\@setfontsize\\Large\\@xivpt{16}}
\\renewcommand{\\LARGE}{\\@setfontsize\\LARGE\\@xviipt{20}}
\\renewcommand{\\huge}{\\@setfontsize\\huge\\@xxpt{23}}
\\renewcommand{\\Huge}{\\@setfontsize\\Huge\\@xxvpt{28}}


% Force \\tiny to be no smaller than 6pt
\\renewcommand{\\tiny}{\\fontsize{6pt}{7pt}\\selectfont}

% Force \\scriptsize to be no smaller than 7pt
\\renewcommand{\\scriptsize}{\\fontsize{7pt}{8pt}\\selectfont}

% Force \\footnotesize to be no smaller than 8pt
\\renewcommand{\\footnotesize}{\\fontsize{8pt}{9.5pt}\\selectfont}

% sections with less space
\\providecommand{\\section}{}
\\renewcommand{\\section}{%
  \\@startsection{section}{1}{\\z@}%
                {-2.0ex \\@plus -0.5ex \\@minus -0.2ex}%
                { 1.5ex \\@plus  0.3ex \\@minus  0.2ex}%
                {\\large\\bf\\raggedright}%
}
\\providecommand{\\subsection}{}
\\renewcommand{\\subsection}{%
  \\@startsection{subsection}{2}{\\z@}%
                {-1.8ex \\@plus -0.5ex \\@minus -0.2ex}%
                { 0.8ex \\@plus  0.2ex}%
                {\\normalsize\\bf\\raggedright}%
}
\\providecommand{\\subsubsection}{}
\\renewcommand{\\subsubsection}{%
  \\@startsection{subsubsection}{3}{\\z@}%
                {-1.5ex \\@plus -0.5ex \\@minus -0.2ex}%
                { 0.5ex \\@plus  0.2ex}%
                {\\normalsize\\bf\\raggedright}%
}
\\providecommand{\\paragraph}{}
\\renewcommand{\\paragraph}{%
  \\@startsection{paragraph}{4}{\\z@}%
                {1.5ex \\@plus 0.5ex \\@minus 0.2ex}%
                {-1em}%
                {\\normalsize\\bf}%
}
\\providecommand{\\subparagraph}{}
\\renewcommand{\\subparagraph}{%
  \\@startsection{subparagraph}{5}{\\z@}%
                {1.5ex \\@plus 0.5ex \\@minus 0.2ex}%
                {-1em}%
                {\\normalsize\\bf}%
}
\\providecommand{\\subsubsubsection}{}
\\renewcommand{\\subsubsubsection}{%
  \\vskip5pt{\\noindent\\normalsize\\rm\\raggedright}%
}

% float placement
\\renewcommand{\\topfraction      }{0.85}
\\renewcommand{\\bottomfraction   }{0.4}
\\renewcommand{\\textfraction     }{0.1}
\\renewcommand{\\floatpagefraction}{0.7}

\\newlength{\\@neuripsabovecaptionskip}\\setlength{\\@neuripsabovecaptionskip}{7\\p@}
\\newlength{\\@neuripsbelowcaptionskip}\\setlength{\\@neuripsbelowcaptionskip}{\\z@}

\\setlength{\\abovecaptionskip}{\\@neuripsabovecaptionskip}
\\setlength{\\belowcaptionskip}{\\@neuripsbelowcaptionskip}

% swap above/belowcaptionskip lengths for tables
\\renewenvironment{table}
  {\\setlength{\\abovecaptionskip}{\\@neuripsbelowcaptionskip}%
   \\setlength{\\belowcaptionskip}{\\@neuripsabovecaptionskip}%
   \\@float{table}}
  {\\end@float}

% footnote formatting
\\setlength{\\footnotesep }{6.65\\p@}
\\setlength{\\skip\\footins}{9\\p@ \\@plus 4\\p@ \\@minus 2\\p@}
\\renewcommand{\\footnoterule}{\\kern-3\\p@ \\hrule width 12pc \\kern 2.6\\p@}
\\setcounter{footnote}{0}

% paragraph formatting
\\setlength{\\parindent}{\\z@}
\\setlength{\\parskip  }{5.5\\p@}

% list formatting
\\setlength{\\topsep       }{4\\p@ \\@plus 1\\p@   \\@minus 2\\p@}
\\setlength{\\partopsep    }{1\\p@ \\@plus 0.5\\p@ \\@minus 0.5\\p@}
\\setlength{\\itemsep      }{2\\p@ \\@plus 1\\p@   \\@minus 0.5\\p@}
\\setlength{\\parsep       }{2\\p@ \\@plus 1\\p@   \\@minus 0.5\\p@}
\\setlength{\\leftmargin   }{3pc}
\\setlength{\\leftmargini  }{\\leftmargin}
\\setlength{\\leftmarginii }{2em}
\\setlength{\\leftmarginiii}{1.5em}
\\setlength{\\leftmarginiv }{1.0em}
\\setlength{\\leftmarginv  }{0.5em}
\\def\\@listi  {\\leftmargin\\leftmargini}
\\def\\@listii {\\leftmargin\\leftmarginii
              \\labelwidth\\leftmarginii
              \\advance\\labelwidth-\\labelsep
              \\topsep  2\\p@ \\@plus 1\\p@    \\@minus 0.5\\p@
              \\parsep  1\\p@ \\@plus 0.5\\p@ \\@minus 0.5\\p@
              \\itemsep \\parsep}
\\def\\@listiii{\\leftmargin\\leftmarginiii
              \\labelwidth\\leftmarginiii
              \\advance\\labelwidth-\\labelsep
              \\topsep    1\\p@ \\@plus 0.5\\p@ \\@minus 0.5\\p@
              \\parsep    \\z@
              \\partopsep 0.5\\p@ \\@plus 0\\p@ \\@minus 0.5\\p@
              \\itemsep \\topsep}
\\def\\@listiv {\\leftmargin\\leftmarginiv
              \\labelwidth\\leftmarginiv
              \\advance\\labelwidth-\\labelsep}
\\def\\@listv  {\\leftmargin\\leftmarginv
              \\labelwidth\\leftmarginv
              \\advance\\labelwidth-\\labelsep}
\\def\\@listvi {\\leftmargin\\leftmarginvi
              \\labelwidth\\leftmarginvi
              \\advance\\labelwidth-\\labelsep}

% create title
\\providecommand{\\maketitle}{}
\\renewcommand{\\maketitle}{%
  \\par
  \\begingroup
    \\renewcommand{\\thefootnote}{\\fnsymbol{footnote}}
    % for perfect author name centering
    \\renewcommand{\\@makefnmark}{\\hbox to \\z@{$^{\\@thefnmark}$\\hss}}
    % The footnote-mark was overlapping the footnote-text,
    % added the following to fix this problem               (MK)
    \\long\\def\\@makefntext##1{%
      \\parindent 1em\\noindent
      \\hbox to 1.8em{\\hss $\\m@th ^{\\@thefnmark}$}##1
    }
    \\thispagestyle{empty}
    \\@maketitle
    \\@thanks
    \\@notice
  \\endgroup
  \\let\\maketitle\\relax
  \\let\\thanks\\relax
}

% rules for title box at top of first page
\\newcommand{\\@toptitlebar}{
  \\hrule height 4\\p@
  \\vskip 0.25in
  \\vskip -\\parskip%
}
\\newcommand{\\@bottomtitlebar}{
  \\vskip 0.29in
  \\vskip -\\parskip
  \\hrule height 1\\p@
  \\vskip 0.09in%
}

% create title (includes both anonymized and non-anonymized versions)
\\providecommand{\\@maketitle}{}
\\renewcommand{\\@maketitle}{%
  \\vbox{%
    \\hsize\\textwidth
    \\linewidth\\hsize
    \\vskip 0.1in
    \\@toptitlebar
    \\centering
    {\\LARGE\\bf \\@title\\par}
    \\@bottomtitlebar
    \\if@anonymous
      \\begin{tabular}[t]{c}\\bf\\rule{\\z@}{24\\p@}
        Anonymous Author(s) \\\\
        Affiliation \\\\
        Address \\\\
        \\texttt{email} \\\\
      \\end{tabular}%
    \\else
      \\def\\And{%
        \\end{tabular}\\hfil\\linebreak[0]\\hfil%
        \\begin{tabular}[t]{c}\\bf\\rule{\\z@}{24\\p@}\\ignorespaces%
      }
      \\def\\AND{%
        \\end{tabular}\\hfil\\linebreak[4]\\hfil%
        \\begin{tabular}[t]{c}\\bf\\rule{\\z@}{24\\p@}\\ignorespaces%
      }
      \\begin{tabular}[t]{c}\\bf\\rule{\\z@}{24\\p@}\\@author\\end{tabular}%
    \\fi
    \\vskip 0.3in \\@minus 0.1in
  }
}

% add conference notice to bottom of first page
\\newcommand{\\ftype@noticebox}{8}
\\newcommand{\\@notice}{%
  % give a bit of extra room back to authors on first page
  \\enlargethispage{2\\baselineskip}%
  \\@float{noticebox}[b]%
    \\footnotesize\\@noticestring%
  \\end@float%
}

% abstract styling
\\renewenvironment{abstract}%
{%
  \\vskip 0.075in%
  \\centerline%
  {\\large\\bf Abstract}%
  \\vspace{0.5ex}%
  \\begin{quote}%
}
{
  \\par%
  \\end{quote}%
  \\vskip 1ex%
}

% For the paper checklist
\\newcommand{\\answerYes}[1][]{\\textcolor{blue}{[Yes]#1}}
\\newcommand{\\answerNo}[1][]{\\textcolor{orange}{[No]#1}}
\\newcommand{\\answerNA}[1][]{\\textcolor{gray}{[N/A]#1}}
\\newcommand{\\answerTODO}[1][]{\\textcolor{red}{\\bf [TODO]}}
\\newcommand{\\justificationTODO}[1][]{\\textcolor{red}{\\bf [TODO]}}

% handle tweaks for camera-ready copy vs. submission copy
\\if@preprint
  \\newcommand{\\@noticestring}{%
    Preprint.%
  }
\\else
  \\if@neuripsfinal
    \\newcommand{\\@noticestring}{
      \\@trackname
    }
  \\else
    \\newcommand{\\@noticestring}{%
      Submitted to \\@neuripsordinal\\/ Conference on Neural Information Processing Systems (NeurIPS \\@neuripsyear). Do not distribute.%
    }

    % hide the acknowledgements
    \\NewEnviron{hide}{}
    \\let\\ack\\hide
    \\let\\endack\\endhide

    % line numbers for submission
    \\RequirePackage{lineno}
    \\linenumbers

    % fix incompatibilities between lineno and amsmath, if required, by
    % transparently wrapping linenomath environments around amsmath
    % environments
    \\AtBeginDocument{%
      \\@ifpackageloaded{amsmath}{%
        \\newcommand*\\patchAmsMathEnvironmentForLineno[1]{%
          \\expandafter\\let\\csname old#1\\expandafter\\endcsname\\csname #1\\endcsname
          \\expandafter\\let\\csname oldend#1\\expandafter\\endcsname\\csname end#1\\endcsname
          \\renewenvironment{#1}%
                          {\\linenomath\\csname old#1\\endcsname}%
                          {\\csname oldend#1\\endcsname\\endlinenomath}%
        }%
        \\newcommand*\\patchBothAmsMathEnvironmentsForLineno[1]{%
          \\patchAmsMathEnvironmentForLineno{#1}%
          \\patchAmsMathEnvironmentForLineno{#1*}%
        }%
        \\patchBothAmsMathEnvironmentsForLineno{equation}%
        \\patchBothAmsMathEnvironmentsForLineno{align}%
        \\patchBothAmsMathEnvironmentsForLineno{flalign}%
        \\patchBothAmsMathEnvironmentsForLineno{alignat}%
        \\patchBothAmsMathEnvironmentsForLineno{gather}%
        \\patchBothAmsMathEnvironmentsForLineno{multline}%
      }
      {}
    }
  \\fi
\\fi


\\endinput
`})))()}var M;function N(){return(N=e((()=>{M=`# Figure attribution

\`scaled-dot-product-attention.png\`, \`multi-head-attention.png\` and \`attention-figure-2.pdf\` are Lattice's own drawings of scaled dot-product attention and multi-head attention, made for this demo after the operations described in:

Ashish Vaswani, Noam Shazeer, Niki Parmar, Jakob Uszkoreit, Llion Jones, Aidan N. Gomez, Łukasz Kaiser, and Illia Polosukhin.
“Attention Is All You Need.”
Advances in Neural Information Processing Systems 30, 2017.
https://arxiv.org/abs/1706.03762

They are drawn in TikZ (\`tools/web-demo/content/figures/attention-figures.tex\` in Lattice's repository) and licensed under Apache-2.0 with the rest of Lattice.
`})))()}var P;function F(){return(F=e((()=>{P=``+new URL(`scaled-dot-product-attention-DVVicHlq.png`,import.meta.url).href})))()}var I;function L(){return(L=e((()=>{I=``+new URL(`multi-head-attention-BLPwlDZZ.png`,import.meta.url).href})))()}var R;function z(){return(z=e((()=>{R=``+new URL(`attention-figure-2-B_ukZmgG.pdf`,import.meta.url).href})))()}async function B(){let e=new Map(t(`tutorial`,V));for(let{file:t,find:n,replace:r}of O.edits){let i=String(e.get(t)??``);if(i.split(n).length!==2)throw Error(`The demo's ${t} no longer holds the text content/overrides.json edits.`);e.set(t,i.replace(n,()=>r))}return e.set(`figures/ATTRIBUTION.md`,M),await Promise.all(H.map(async([t,n])=>{e.set(t,new Uint8Array(await(await fetch(n)).arrayBuffer()))})),e.set(`neurips.sty`,A.replace(`\\ProvidesPackage{neurips_2026}`,`\\ProvidesPackage{neurips}`)),e}var V,H;function U(){return(U=e((()=>{i(),o(),c(),u(),f(),m(),g(),v(),b(),S(),w(),E(),n(),k(),j(),N(),F(),L(),z(),V=Object.assign({"../../src-tauri/templates/tutorial/attention-demo.html":r,"../../src-tauri/templates/tutorial/attention-map.tldr":a,"../../src-tauri/templates/tutorial/attention-results.lattice-sheet":s,"../../src-tauri/templates/tutorial/figures/ATTRIBUTION.md":l,"../../src-tauri/templates/tutorial/figures/attention-figure-2.pdf":d,"../../src-tauri/templates/tutorial/figures/multi-head-attention.png":p,"../../src-tauri/templates/tutorial/figures/scaled-dot-product-attention.png":h,"../../src-tauri/templates/tutorial/main.tex":_,"../../src-tauri/templates/tutorial/notes.md":y,"../../src-tauri/templates/tutorial/project.toml":x,"../../src-tauri/templates/tutorial/references.bib":C,"../../src-tauri/templates/tutorial/slides/understanding-attention/index.tsx":T}),H=[[`figures/scaled-dot-product-attention.png`,P],[`figures/multi-head-attention.png`,I],[`figures/attention-figure-2.pdf`,R]]})))()}U();export{B as demoTutorialFiles};