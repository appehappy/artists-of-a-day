"""Wikidata matching rules. Run: python3 -m unittest"""
import unittest

from aotd.enrich import region_from_nationality
from aotd.wikidata import country_region, decide, describe, name_similarity, score, search_names


def cand(**kw):
    base = {"qid": "Q1", "label": "X", "description": None, "names": [], "human": True,
            "birth": None, "death": None, "gender": None, "countries": [], "demonyms": [],
            "region": None, "birthplace": None, "occupations": [], "movements": [], "enwiki": None}
    return {**base, **kw}


class NameTests(unittest.TestCase):
    def test_search_names(self):
        self.assertEqual(search_names('Ljubica "Cuca" Sokić'), ["Ljubica Sokić", "Cuca"])
        self.assertEqual(search_names("Nikolator (Nikolai Muth)"), ["Nikolator", "Nikolai Muth"])
        self.assertEqual(search_names("Sir Jonathan Ive"), ["Jonathan Ive"])
        self.assertEqual(search_names("Danny J. Martinez a.k.a. Van Dam One"),
                         ["Danny J. Martinez", "Van Dam One"])

    def test_similarity(self):
        self.assertEqual(name_similarity("Aïda Muluneh", ["Aida Muluneh"]), 1.0)
        self.assertEqual(name_similarity("Munch Edvard", ["Edvard Munch"]), 0.97)
        self.assertLess(name_similarity("Albert Edelfel", ["Albert Edelfelt"]), 0.5)


class ScoreTests(unittest.TestCase):
    artist = {"name": "Alan Fletcher", "birth": 1938, "nationality": "British"}

    def test_strong_match_despite_wrong_parsed_birth(self):
        c = cand(names=["Alan Fletcher"], occupations=["graphic designer"], birth=1931,
                 demonyms=["British"])
        best = (*score(self.artist, c, 0), c)
        self.assertIn("birth year differs (1931)", best[1])
        self.assertEqual(decide(best, None, self.artist), "auto")

    def test_namesake_without_art_occupation_needs_review(self):
        c = cand(names=["Alan Fletcher"], occupations=["footballer"], birth=1938, demonyms=["British"])
        best = (*score(self.artist, c, 0), c)
        self.assertEqual(decide(best, None, self.artist), "needs_review")

    def test_close_runner_up_needs_review(self):
        a = cand(names=["Alan Fletcher"], occupations=["painter"], demonyms=["British"])
        b = cand(names=["Alan Fletcher"], occupations=["illustrator"], demonyms=["British"])
        best, second = (*score(self.artist, a, 0), a), (*score(self.artist, b, 1), b)
        self.assertEqual(decide(best, second, self.artist), "needs_review")

    def test_not_human(self):
        self.assertEqual(score(self.artist, cand(human=False, names=["Alan Fletcher"]), 0)[0], 0.0)


class RegionTests(unittest.TestCase):
    def test_regions(self):
        self.assertEqual(country_region("Q30", {"continents": ["Q49"]}), "North America")
        self.assertEqual(country_region("Q96", {"continents": ["Q49"]}), "Latin America & Caribbean")
        self.assertEqual(country_region("Q159", {"continents": ["Q48", "Q46"]}), "Europe")
        self.assertEqual(country_region("Q408", {"continents": ["Q3960"]}), "Oceania")

    def test_describe_falls_back_to_birthplace_country(self):
        person = {"id": "Q1", "countries": [], "birthplace": "Q90"}
        refs = {"Q90": {"id": "Q90", "label": "Paris", "coord": [48.85, 2.35], "country": "Q142"},
                "Q142": {"id": "Q142", "continents": ["Q46"], "demonyms": ["French"]}}
        d = describe(person, refs)
        self.assertEqual(d["region"], "Europe")
        self.assertEqual(d["birthplace"], {"name": "Paris", "lat": 48.85, "lon": 2.35})


class NationalityRegionTests(unittest.TestCase):
    def test_last_demonym_wins(self):
        table = {"polish": "Europe", "american": "North America", "new zealander": "Oceania",
                 "south african": "Africa", "african": "Africa"}
        self.assertEqual(region_from_nationality("Polish-born American", table), "North America")
        self.assertEqual(region_from_nationality("New Zealander", table), "Oceania")
        self.assertEqual(region_from_nationality("Canadian/South African", table), "Africa")
        self.assertIsNone(region_from_nationality("Martian", table))


if __name__ == "__main__":
    unittest.main()
