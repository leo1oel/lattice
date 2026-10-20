import random
import unittest

from lattice_env.verifier.diffing import added_lines, edit_distance, lcs_length, text_edit_chars


def reference_distance(a, b):
    """Insert/delete distance from the textbook LCS table."""
    table = [[0] * (len(b) + 1) for _ in range(len(a) + 1)]
    for i in range(1, len(a) + 1):
        for j in range(1, len(b) + 1):
            table[i][j] = table[i - 1][j - 1] + 1 if a[i - 1] == b[j - 1] else max(table[i - 1][j], table[i][j - 1])
    return len(a) + len(b) - 2 * table[len(a)][len(b)]


class EditDistance(unittest.TestCase):
    def test_matches_the_lcs_table_on_random_strings(self):
        rng = random.Random(7)
        for _ in range(300):
            a = "".join(rng.choice("abc") for _ in range(rng.randrange(0, 14)))
            b = "".join(rng.choice("abc") for _ in range(rng.randrange(0, 14)))
            self.assertEqual(edit_distance(a, b), reference_distance(a, b), (a, b))

    def test_limit_cuts_off_large_differences(self):
        self.assertIsNone(edit_distance("a" * 50, "b" * 50, limit=10))
        self.assertEqual(edit_distance("abcdef", "abXdef", limit=2), 2)
        self.assertEqual(lcs_length(["x", "y", "z"], ["x", "z"]), 2)


class TextEdits(unittest.TestCase):
    def test_counts_characters_inside_changed_lines_only(self):
        before = "line one\n\\citpe{x} here\nline three\n" * 50
        after = before.replace("\\citpe{x}", "\\citep{x}", 1)
        self.assertEqual(text_edit_chars(before, after), 2)

    def test_a_deleted_section_exceeds_a_small_limit(self):
        before = "keep\n" + "a long sentence of the paper\n" * 40 + "keep\n"
        self.assertIsNone(text_edit_chars(before, "keep\nkeep\n", limit=64))

    def test_added_lines(self):
        self.assertEqual(added_lines("a\nb\nc", "a\nB\nc\nd"), ["B", "d"])


if __name__ == "__main__":
    unittest.main()
