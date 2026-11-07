# Upstream

Every file here is copied unchanged from the official CVPR author kit:

https://github.com/cvpr-org/author-kit

Release `CVPR2027-v1` (2026-10-28, commit `a2369342011145be8c85e5ad21a9b61f9fa53473`), fetched 2026-11-07.

| File here | Upstream file | SHA-256 |
| --- | --- | --- |
| `main.tex` | `rebuttal.tex` | `ef185377321633a2511716a66533cb968eb75856e8f6b6dead61a4419ffcedac` |
| `preamble.tex` | `preamble.tex` | `080e0bae5ff30626292192ee2b4d1afca432ed2d2c939486c1bb37856166f8c1` |
| `cvpr.sty` | `cvpr.sty` | `ae8e51adc7270b118833b2092310ca1151a19fab0c09b1ab35a485ac4004ac0f` |
| `ieeenat_fullname.bst` | `ieeenat_fullname.bst` | `e38e6166bd7b1e6d23a1b79dcdb55c656e4fcdbe91bdf6b50d827e6b5d1aacfc` |

`main.tex` is the kit's author-response template, renamed only because Lattice opens every new project at `main.tex`; its contents are byte-for-byte `rebuttal.tex`, including the kit's placeholder title.
It inputs `preamble.tex` and reads `\bibliography{main}`, so a new project gets an empty `main.bib` as its bibliography; the kit's example `main.bib` and paper sections are not bundled.
`cvpr.sty` and `ieeenat_fullname.bst` are the same bytes as `../cvpr-2027/`, and a test keeps the two copies identical.
The repository has no license file.
The `.bst` file carries its own license grant in its header: it is a modification of `abbrvnat.bst` (Copyright 1993-2007 Patrick W Daly) and "can be redistributed and/or modified under the terms of the LaTeX Project Public License", version 1 or later (https://www.latex-project.org/lppl/).
`cvpr.sty`, `rebuttal.tex` and `preamble.tex` carry no license grant.
Every file ships unmodified, so every notice and credit in them reaches users intact; do not edit or strip their header comments.
