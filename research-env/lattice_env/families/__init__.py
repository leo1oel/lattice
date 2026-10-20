"""Task families: each module lists its operators and the agent's instruction."""

from . import build_repair

FAMILIES = {
    build_repair.FAMILY: build_repair,
}
