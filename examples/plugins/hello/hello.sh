#!/bin/sh
# Lattice sends the invocation context as one JSON line on stdin.
IFS= read -r context
printf 'Hello from %s!\nContext: %s\n' "$LATTICE_PLUGIN_ID" "$context"
