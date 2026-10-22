"""Merging full and incremental feed snapshots. Run: python3 -m unittest"""
import unittest

from aotd.feed import merge_entries


def entry(pid, published, updated, title="t"):
    return {"id": {"$t": pid}, "published": {"$t": published}, "updated": {"$t": updated},
            "title": {"$t": title}}


class MergeTests(unittest.TestCase):
    def test_new_posts_added_and_edits_win(self):
        base = [entry("a", "2026-10-17", "2026-10-17", "old"), entry("b", "2026-10-16", "2026-10-16")]
        inc = [entry("c", "2026-10-18", "2026-10-18"), entry("a", "2026-10-17", "2026-10-19", "edited")]
        merged = merge_entries([base, inc])
        self.assertEqual([e["id"]["$t"] for e in merged], ["c", "a", "b"])
        self.assertEqual(merged[1]["title"]["$t"], "edited")

    def test_stale_copy_does_not_overwrite(self):
        base = [entry("a", "2026-10-17", "2026-10-20", "newer")]
        inc = [entry("a", "2026-10-17", "2026-10-18", "older")]
        self.assertEqual(merge_entries([base, inc])[0]["title"]["$t"], "newer")


if __name__ == "__main__":
    unittest.main()
