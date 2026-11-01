# Upstream

The class, bibliography styles and cover artwork are copied unchanged from the ustcthesis 5.0.2 release (2026-09-27):

https://github.com/ustctug/ustcthesis/releases/download/v5.0.2/ustcthesis-v5.0.2.zip

Fetched 2026-11-01. Archive SHA-256: `d42361ff02d1501589ae8285d9e07ea431042f6dd031e1ab7b4ea4906c5ac17e`
`ustcthesis.cls` SHA-256: `403bf1c446a5f11c7d885be7c59448a76559b7c8315b4ff8003b0a5cbf4b7358`
`ustcthesis-numeric.bst` SHA-256: `c8361709afbfefd560b358a06c9fb9488e28bb2fecbe6db7af3d0cf3a9336cc2`
`ustcthesis-authoryear.bst` SHA-256: `911aebe69ae1cf1d165f60d6f907ac6ff0f48081c877590198450771791aadb3`
`figures/ustc-logo.pdf` SHA-256: `e5f1ed9c7548805162ea54cbf919db8c104da7a582b6e06694bfa2d94e72edfa`
`figures/ustc-name.pdf` SHA-256: `e082e113eb2c6b1c9b1fba508e0d4a19694a1409a55015d880cfdc90bddfb9b0`
`figures/ustc-name-stxingkai.pdf` SHA-256: `67ac9b8c730d23835995c0b26e5a621db29c225908fa79f1cd91c6211802a1a9`
`figures/ustc-title-page-heading.pdf` SHA-256: `54c48ee2c46da8caf28599cfabdead7bc8a436d9f264ab25b575b798db01dcf0`
License: LaTeX Project Public License 1.3c or later (the repository's `LICENSE`; each file's header).
`ustcthesis.cls` is Copyright (C) 2015-2026 by USTC TeX Users Group; the `.bst` files, generated from `gbt7714-bst.dtx`, are Copyright (C) 2016-2026 by Zeping Lee.
The class draws the four PDFs, which carry the emblem and name of the University of Science and Technology of China, on its covers from these fixed `figures/` paths.
Every file ships unmodified: the LPPL requires a modified file to be renamed, so do not edit them in place.
Lattice's `main.tex` is a short skeleton built from the release's `main.tex` and `ustcsetup.tex`, using the class's documented interface; it is not the example thesis.
The class requires XeLaTeX and, beyond Lattice's base packages, `ctex`, `xecjk`, `zhnumber`, `bibunits`, `xits` and `stix2-otf` (it loads STIX Two Math beside XITS), which `tex_setup/basictex.sh` installs.
