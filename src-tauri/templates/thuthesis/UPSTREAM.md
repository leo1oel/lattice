# Upstream

The class, bibliography styles and cover logos are copied unchanged from the ThuThesis 7.7.1 release (2026-05-26), the version on CTAN as `thuthesis`:

https://github.com/tuna/thuthesis/releases/download/v7.7.1/thuthesis-v7.7.1.zip

Fetched 2026-11-01. Archive SHA-256: `ca8b0de4f7e770d8ab8d50870f7d3a800b5f8c0c5d049c83cf9cafc70142a26d`
`thuthesis.cls` SHA-256: `4cbb87b799e24dce8b2e089893eafcd2f94c0ca50caa4f4f36fa9ebbb1872021`
`thuthesis-numeric.bst` SHA-256: `cc5bc236aecad4404250c6646d338ad0eaa989abbc1e11716eeef0d66751c5f9`
`thuthesis-author-year.bst` SHA-256: `a1c512f3c22bf89485c2eaaca6738fc70882952de41c2ceb7833f0b796f4c771`
`thu-fig-logo.pdf` SHA-256: `a49220ee5b4ecd6afcdc694e0cc75a2bb84d42d19e3facee4b88f70268dbbb4d`
`thu-text-logo.pdf` SHA-256: `5db987a65995a590fed4b8430a55795097c5be58980dfe6116daa28be32953c8`
License: LaTeX Project Public License 1.3c or later (the release's `LICENSE`; each file's header).
`thuthesis.cls` is Copyright (C) 2005-2026 by Tsinghua University TUNA Association; the `.bst` files, generated from `gbt7714.dtx`, are Copyright (C) 2016--2024 by Zeping Lee.
The two logo PDFs carry Tsinghua University's emblem and name, which the README says are the university's registered trademarks, for use only with this template; the class draws them on undergraduate covers.
Every file ships unmodified: the LPPL requires a modified file to be renamed, so do not edit them in place.
Lattice's `main.tex` is a short skeleton built from `thuthesis-example.tex` and `thusetup.tex`, using the class's documented interface; it is not the example thesis.
The class requires XeLaTeX and, beyond Lattice's base packages, `ctex`, `xecjk`, `zhnumber`, `bibunits` and `xits`, which `tex_setup/basictex.sh` installs.
