"""Task families: each module lists its operators and the agent's instruction."""

from . import build_repair, reference_hygiene

FAMILIES = {
    build_repair.FAMILY: build_repair,
    reference_hygiene.FAMILY: reference_hygiene,
}
