# Upstream

`IEEEtran.cls` and `IEEEtran.bst` are copied unchanged from IEEEtran 1.8b (2015-08-26), the class IEEE's LaTeX author templates use, as TeX Live distributes it (CTAN `ieeetran`):

https://mirror.ctan.org/systems/texlive/tlnet/archive/ieeetran.tar.xz (TeX Live revision 79618)

Fetched 2026-11-10. Archive SHA-256: `112b81e841a71978ebf0b98f68d6a20542c66e16aa9f8c0fe7fb073b91f8c529`
`IEEEtran.cls` SHA-256: `da751920a317ed318b7b5cd7fa585a6cc7d28502d457856382e9be24b10a3bd7`
`IEEEtran.bst` SHA-256: `314f0ece704568faf827011bac498650691b2b5ee06320720830e782416d5a5f`
License: LaTeX Project Public License 1.3 (each file's header; https://www.latex-project.org/lppl/).
`IEEEtran.cls` is Copyright (c) 1993-2000 by Gerry Murray, Silvano Balemi, Jon Dixon, Peter Nüchter and Juergen von Hagen, and Copyright (c) 2001-2015 by Michael Shell; `IEEEtran.bst` is Copyright (c) 2003-2015 Michael Shell.
Both files ship unmodified: the LPPL requires a modified file to be renamed, so do not edit them in place.
Lattice's `main.tex` is a short skeleton adapted from the package's `bare_conf.tex` (V1.4b, LPPL 1.3, from `ieeetran.doc.tar.xz`, SHA-256 `7236c15287cade22e1af1f0608645339f3f97a4b47d28f4dd132b9fbad76fa37`), using the class's documented interface; it is renamed and names its source in its header, as the LPPL asks of a modified file.
`references.bib` is Lattice's own sample, typeset with `IEEEtran.bst`.
The two IEEE directories hold the same class, bibliography style and sample, and a test keeps them identical.
