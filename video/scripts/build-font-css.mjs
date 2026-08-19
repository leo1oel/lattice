// Regenerates src/inter.css and src/fraunces.css from the installed
// @fontsource-variable packages. Run after upgrading either:
//   node scripts/build-font-css.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { globSync } from "node:fs";

const writeFace = ({ glob, family, out }) => {
  const [file] = globSync(glob);
  if (!file) throw new Error(`${family} not found — is the fontsource package installed?`);
  const b64 = readFileSync(file).toString("base64");
  // NOTE: never put a glob (star followed by slash) in the generated comment —
  // it terminates the CSS comment early and silently corrupts the stylesheet.
  const css = `/* Generated file - do not edit by hand. Run scripts/build-font-css.mjs.

   ${family} (latin subset), inlined as a data URI so that loading it needs
   neither a fetch nor a delayRender().

   The descriptor is format("woff2"), not the legacy format("woff2-variations")
   fontsource emits: Tailwind v4's CSS parser fails outright on that one. */
@font-face {
  font-family: "${family}";
  font-style: normal;
  font-weight: 100 900;
  font-display: block;
  src: url("data:font/woff2;base64,${b64}") format("woff2");
}
`;
  writeFileSync(out, css);
  console.log(`${out} written (${(css.length / 1024).toFixed(1)} KB)`);
};

writeFace({
  glob: "node_modules/.pnpm/@fontsource-variable+inter@*/node_modules/@fontsource-variable/inter/files/inter-latin-opsz-normal.woff2",
  family: "Inter Variable",
  out: "src/inter.css",
});

writeFace({
  glob: "node_modules/.pnpm/@fontsource-variable+fraunces@*/node_modules/@fontsource-variable/fraunces/files/fraunces-latin-full-normal.woff2",
  family: "Fraunces Variable",
  out: "src/fraunces.css",
});
