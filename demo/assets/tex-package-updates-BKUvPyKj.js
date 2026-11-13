import{n as e}from"./rolldown-runtime-C0FnF6B9.js";import{t}from"./dist-pVqL3IvH.js";import{n,t as r}from"./host-error-text-Bu2xrfYW.js";import{a as i}from"./i18n-Dw5Zm_PG.js";function a(e){let[n=``,...i]=e.split(`
`),a=s.get(n);if(a)return{summary:t._(a),detail:i.join(`
`).trim()};let[o=``,...c]=r(e).split(`
`);return{summary:o,detail:c.join(`
`).trim()}}var o,s;function c(){return(c=e((()=>{i(),n(),o=`sudo tlmgr update --self --all`,s=new Map([[`Administrator approval was cancelled, so nothing was updated.`,{id:`ciy0mO`}],[`TeX Live's package manager could not update the packages.`,{id:`eHeGly`}],[`BasicTeX is installed, but its LaTeX packages could not be updated. Update them later from Settings → TeX doctor.`,{id:`1ReCjr`}]])})))()}export{c as n,a as r,o as t};