"""Artwork date rules (aotd/dates.py) and Wikidata inception qualifiers. Run: python3 -m unittest"""
import sqlite3
import sys
import unittest
from pathlib import Path
from unittest import mock

from aotd import dates

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from match_artwork_years import work_years  # noqa: E402

SCHEMA = (Path(__file__).resolve().parent.parent / "aotd" / "schema.sql").read_text()


class YearTextTests(unittest.TestCase):
    def test_round_trip(self):
        for y in [(1965, None, False), (1914, 1915, True), (1950, 1959, False),
                  (-1887, -1813, False), (-330, None, True)]:
            self.assertEqual(dates.parse_year(dates.format_year(*y)), y)

    def test_forms(self):
        self.assertEqual(dates.parse_year("1960-65"), (1960, 1965, False))
        self.assertEqual(dates.parse_year("1950s"), (1950, 1959, False))
        self.assertIsNone(dates.parse_year(""))
        self.assertIsNone(dates.parse_year("unknown"))

    def test_span(self):
        self.assertEqual(dates.span(1965, None, False, 2020), (1965, 1965))
        self.assertEqual(dates.span(1965, 1970, True, 2020), (1960, 1975))
        self.assertEqual(dates.span(2015, 2019, True, 2018), (2010, 2018))   # never after the post

    def test_generic_titles(self):
        for t in ["Untitled", "Untitled 3", "Composition No. 4", "Self-portrait", "Sans titre", "Study II"]:
            self.assertTrue(dates.is_generic(dates.title_key(t)), t)
        for t in ["Composition with Red, Blue and Yellow", "Les Coulisses de l'Opéra", "Force"]:
            self.assertFalse(dates.is_generic(dates.title_key(t)), t)


class WikidataQualifierTests(unittest.TestCase):
    def test_plain_and_decade(self):
        self.assertEqual(work_years("1889-01-01T00:00:00Z", 9), (1889, None, False))
        self.assertEqual(work_years("1887-01-01T00:00:00Z", 8), (1880, 1889, False))
        self.assertIsNone(work_years("1800-01-01T00:00:00Z", 7))   # century
        self.assertEqual(work_years("-0330-01-01T00:00:00Z", 9), (-330, None, False))

    def test_bounds_alone_are_not_dates(self):
        # Jean Béraud's works "by 1935", the year he died
        self.assertIsNone(work_years("1935-01-01T00:00:00Z", 9, latest="1935-01-01T00:00:00Z"))
        self.assertIsNone(work_years("1880-01-01T00:00:00Z", 9, earliest="1880-01-01T00:00:00Z"))

    def test_range_and_circa(self):
        self.assertEqual(work_years("1882-01-01T00:00:00Z", 9, "1880-01-01T00:00:00Z",
                                    "1884-01-01T00:00:00Z"), (1880, 1884, False))
        self.assertIsNone(work_years("1700-01-01T00:00:00Z", 9, "1600-01-01T00:00:00Z",
                                     "1700-01-01T00:00:00Z"))   # too wide to place
        self.assertEqual(work_years("1885-01-01T00:00:00Z", 9, sourcing="Q5727902"), (1885, None, True))


class GuessTests(unittest.TestCase):
    """Estimated spans for undated works: dates.guess(siblings, artist, neighbours, life, ceiling)."""

    def test_siblings_first(self):
        self.assertEqual(dates.guess([(1950, 1950), (1956, 1956)], [(1900, 1990)], [], None, 2020),
                         (1948, 1958, 1953, "siblings"))

    def test_artist_then_likeness(self):
        self.assertEqual(dates.guess([], [(1960, 1960), (1970, 1980)], [], None, 2020),
                         (1955, 1985, 1968, "artist"))
        near = [(y, y) for y in (1930, 1940, 1950, 1960, 1970)]
        self.assertEqual(dates.guess([], [], near, None, 2020), (1922, 1978, 1950, "likeness"))
        # kept inside the artist's adult life
        self.assertEqual(dates.guess([], [], near, (1935, 1990, "person"), 2020),
                         (1950, 1978, 1950, "likeness"))

    def test_life_and_post(self):
        near = [(1880, 1880)] * 3                  # look-alikes from before the artist was born
        self.assertEqual(dates.guess([], [], near, (1940, None, "person"), 2020),
                         (1955, 2020, 1975, "life"))
        self.assertEqual(dates.guess([], [], [], None, 2020), (None, 2020, None, "post"))
        # An estimate stays inside the artist's working life, whatever the works around it say.
        self.assertEqual(dates.guess([(1995, 1995), (2001, 2001)], [], [], (1900, 1998, "person"), 2020),
                         (1993, 1998, 1998, "siblings"))
        self.assertEqual(dates.guess([(2005, 2005)], [], [], (1900, 1998, "person"), 2020),
                         (1915, 1998, 1935, "life"))

    def test_never_after_the_post(self):
        self.assertEqual(dates.guess([(2019, 2019)], [], [], None, 2018), (2017, 2018, 2018, "siblings"))


class ApplyTests(unittest.TestCase):
    """dates.apply on a tiny database: after-post years, manual overrides, propagation."""

    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.executescript(SCHEMA)
        self.db.executemany(
            "INSERT INTO posts (id, published, feature_date, url, title, kind, labels, content_html, "
            "content_text, flags) VALUES (?, ?, ?, '', '', 'artist', '[]', '', '', '[]')",
            [("p1", "2021-02-26T03:00:00", "2021-02-26"), ("p2", "2023-07-20T03:00:00", "2023-07-20")])
        rows = [("p1", 0, "a", "Terminal, completion by 2028", 2028),
                ("p1", 1, "b", "Lamp, 1965", 1965),
                ("p2", 0, "c", "Lamp again", None),
                ("p2", 1, "d", "Chair", None)]
        self.db.executemany(
            "INSERT INTO images (post_id, position, url_hash, src_url, caption_raw, title, year_start, "
            "year_source, kind, kind_source) VALUES (?, ?, ?, '', ?, ?, ?, ?, 'artwork', 'heuristic')",
            [(p, pos, h, cap, cap, y, "caption" if y else None) for p, pos, h, cap, y in rows])
        self.db.execute("INSERT INTO image_similar VALUES ('p2', 'c', '[[\"p1\", \"b\", 0.98]]')")
        self.overrides = {"image_year": {"p2/d": "c.1958"}}

    def year(self, h):
        return self.db.execute("SELECT year_start, circa, year_source, year_lo, year_hi, year_note "
                               "FROM images WHERE url_hash = ?", (h,)).fetchone()

    def test_apply(self):
        with mock.patch.object(dates, "ARTWORK_YEARS", Path("/nonexistent/artwork_years.csv")):
            dates.apply(self.db, self.overrides)
        # undated after dropping 2028, so estimated from the dated work beside it
        self.assertEqual(self.year("a"), (None, 0, None, 1963, 1967, "after_post:2028"))
        self.assertEqual(self.db.execute("SELECT year_est, year_basis FROM images WHERE url_hash = 'a'")
                         .fetchone(), (1965, "siblings"))
        self.assertEqual(self.year("b"), (1965, 0, "caption", 1965, 1965, None))
        self.assertEqual(self.year("c")[:3], (1965, 0, "propagated"))
        self.assertEqual(self.year("d"), (1958, 1, "manual", 1953, 1963, None))


if __name__ == "__main__":
    unittest.main()
