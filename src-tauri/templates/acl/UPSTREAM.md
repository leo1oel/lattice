# Upstream

`acl.sty` and `acl_natbib.bst` are copied unchanged from the official *ACL style files, which ARR and every *ACL venue use:

https://github.com/acl-org/acl-style-files

Commit `d5adc823ff0f80f98c80405ca0ab66c68e684409` (2026-06-29), the head of `master` when fetched on 2026-11-01.
The repository is not versioned by year, so the directory carries no edition.
`acl.sty` SHA-256: `19dfeddc2c0e448f3926a0bef048a9db3f3611b46265b760caabd7ada4f361de`
`acl_natbib.bst` SHA-256: `6fbb306202290f4b68e74ac1460a8b27398500cb6dfeb4492e74c457eae7cd1e`
The repository has no license file.
The `.bst` file carries its own license grant in its header: it derives from Patrick W. Daly's `merlin.mbs` (Copyright 1994-2011 Patrick W Daly), with urlbst modifications Copyright 2002–23 Norman Gray, and "can be redistributed and/or modified under the terms of the LaTeX Project Public License", version 1 or later (https://www.latex-project.org/lppl/).
The `.sty` file carries no license grant.
Both files ship unmodified, so every notice and credit in them reaches users intact; do not edit or strip their header comments.
Lattice's `main.tex` is a short project skeleton that uses the official package API; it is not the conference example paper.
It leaves `\bibliography` commented out: `acl.sty` defines its own reference list, which stops the build while it has no entries.
