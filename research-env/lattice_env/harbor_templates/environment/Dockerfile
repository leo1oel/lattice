# TeX Live 2025, frozen at its final release (pdfTeX 1.40.28, full scheme).
# Pinned by digest: the historic tags are rebuilt monthly on a moving Debian
# testing base, and a reference PDF is only reproducible on the same image.
# amd64 only; Apple Silicon runs it under emulation.
FROM texlive/texlive:TL2025-historic@sha256:7056390eac37715fd3e01875037ceb4016cb17d44c611f7bbbfa7a012007979f AS toolchain

# The image has python3 (the verifier's only dependency) but not pdftotext,
# which the verifier reads the PDF's text with.
RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils \
 && rm -rf /var/lib/apt/lists/*

# The task: the toolchain above (which CI builds on its own, with
# `--target toolchain`, to test the verifier) plus the broken paper.
FROM toolchain
WORKDIR /app
COPY workspace/ /app/
