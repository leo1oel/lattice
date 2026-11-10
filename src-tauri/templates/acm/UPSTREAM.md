# Upstream

The ACM template builds on acmart, the class every ACM publication uses, which is not bundled: a project loads `acmart.cls` and `ACM-Reference-Format.bst` from TeX Live's `acmart` package, and `tex_setup/basictex.sh` installs it with the fonts the class typesets in (`libertine` with `mweights`, `inconsolata` and `newtx`).

https://ctan.org/pkg/acmart — written against acmart 2.21 (2026-11-01), TeX Live revision 80934:
https://mirror.ctan.org/systems/texlive/tlnet/archive/acmart.tar.xz (SHA-256 `5dbdef436bc7700d64d4df3a2d52a3f0be2b6ec094a92f7193f0ab24514676c7`), fetched 2026-11-10.
License: acmart is Copyright 2016-2026, Association for Computing Machinery, under the LaTeX Project Public License 1.3 or later (`acmart.dtx`).
Lattice's `main.tex` is a short skeleton adapted from the package's `sigconf` sample (`samples/sigconf.tex`, from `acmart.doc.tar.xz`, SHA-256 `508a0b9981f4912012553a5be20a0bbd71a735dd1fdecb529713008810554862`), using the class's documented interface; it is not the sample paper.
It starts in the `sigconf` proceedings format; its header comments name the `review`, `anonymous` and `manuscript` options for submissions and the journal formats.
The sample's `\DocumentMetadata` block (a tagged PDF) is left out: a document with one builds without Lattice's precompiled preamble (`latex/preamble_format.rs`), so every build is slower. Authors whose venue asks for a tagged PDF can add it back above `\documentclass`.
`references.bib` is Lattice's own sample, typeset with `ACM-Reference-Format.bst`.
