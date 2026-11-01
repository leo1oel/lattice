# Upstream

`aaai2027.sty` and `aaai2027.bst` are copied unchanged from the official AAAI-27 author kit:

https://aaai.org/authorkit27/ (a ZIP, `AuthorKit27/`)

Fetched 2026-11-01. Archive SHA-256: `9406a545d5d213757245eb37118fe652b2fccf64f555aff28b49ebe2a780c960`
`aaai2027.sty` SHA-256: `01990f8d3716f8e39c5b28a7478f3ac6e28630d1161de6105a7217f5e7f60e43`
`aaai2027.bst` SHA-256: `5db7765ba99de5c1e4686f9b3940a0add9c5e702f2164514462bec130ccb6e3c`
The kit has no license file.
The `.bst` file carries its own license grant in its header: it is generated from Patrick W. Daly's `merlin.mbs` and "can be redistributed and/or modified under the terms of the LaTeX Project Public License", version 1 or later (https://www.latex-project.org/lppl/).
The `.sty` file carries no license grant, and warns that a paper for an AAAI publication may not modify it.
Both files ship unmodified, so every notice and credit in them reaches users intact; do not edit or strip their header comments.
The style loads `newtxtext`, so BasicTeX needs the `newtx` package (and `kastrup` for its `binhex.tex`); `tex_setup/basictex.sh` installs both.
Lattice's `main.tex` is a short project skeleton that uses the official package API and keeps the kit's fixed preamble lines; it is not the conference example paper.
