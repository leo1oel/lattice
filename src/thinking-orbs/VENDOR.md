# thinking-orbs (vendored)

Canvas 2D "thinking" animations for the agent status row.

- Source: https://github.com/Jakubantalik/thinking-orbs
- Version: 0.1.1
- Commit: eda2d708b99ab871993bbea5a5f08d23a14da436
- License: MIT (see `LICENSE`)

Vendored verbatim rather than added as an npm dependency: it is an early
single-maintainer package, and copying the ~1k lines of self-contained
TypeScript keeps us independent of upstream churn and free to tune the
palette/timing locally. No runtime dependencies beyond React.

To pull upstream fixes, re-clone the repo at the desired tag and re-copy
`src/` over this folder, then re-run the app's typecheck and tests.
