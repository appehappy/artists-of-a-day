"""Parser cases taken from real post titles and captions. Run: python3 -m unittest"""
import unittest

from aotd.parse import (classify_image, classify_post, filename_caption, original_image_url,
                        parse_caption, parse_descriptor, parse_life_dates, parse_title)


class TitleTests(unittest.TestCase):
    def t(self, title, published="2026-10-15T03:00:00.000-04:00"):
        return parse_title(title, published)

    def test_modern(self):
        r = self.t("Artist of the Day, October 15, 2026 : Bari Ziperstein, an American ceramist (#2658)")
        self.assertEqual(r["post_number"], 2658)
        self.assertEqual(r["feature_date"], "2026-10-15")
        self.assertEqual(r["subject"], "Bari Ziperstein")
        self.assertEqual(r["descriptor"], "American ceramist")

    def test_early_no_year_no_number(self):
        r = self.t("Artist of the day, July 24: Edvard Munch, Norwegian expressionist painter",
                   "2017-07-23T17:20:00.002-04:00")
        self.assertEqual(r["feature_date"], "2017-07-24")
        self.assertEqual(r["subject"], "Edvard Munch")
        self.assertIsNone(r["post_number"])

    def test_year_boundary(self):
        r = self.t("Artist of the day, January 7: Gerald Leslie Brockhurst, British-born American painter",
                   "2018-12-31T20:00:00.000-05:00")
        self.assertEqual(r["feature_date"], "2019-01-07")

    def test_typos_and_number_forms(self):
        self.assertEqual(self.t("rtist of the Day, October 1, 2025 : Hélio Oiticica, a Brazilian Painter (#2380)")["subject"], "Hélio Oiticica")
        self.assertEqual(self.t("Artist of the August 25, 2026 : Melinda Beck, an American illustrator (#2614)")["post_number"], 2614)
        self.assertEqual(self.t("Artists of the Day, July 8, 2023: States Welcome signs (East of Mississippi) [#1848]")["post_number"], 1848)
        self.assertEqual(self.t("Artists of the Day, August 19, 2023: Art Deco movement (Part 1)  #1883")["post_number"], 1883)
        self.assertEqual(self.t("Artist the Day, June 14, 2022: Brandrenew, a South African Branding and design agency (# 1595)")["post_number"], 1595)
        r = self.t("Artist of the Day, September 11, 2024: Armand Vaillancourt, a Québec sculptor (2108)")
        self.assertEqual(r["post_number"], 2108)
        self.assertIn("post_number_without_hash", r["flags"])

    def test_is_a(self):
        r = self.t("Artist of the Day, November 18, 2022: Louise Howard is a British emerging fine art painter (#1703)")
        self.assertEqual(r["subject"], "Louise Howard")
        self.assertEqual(r["descriptor"], "British emerging fine art painter")

    def test_bracket_note(self):
        r = self.t("Artist of the Day, July 3, 2026 : Xavier de Vilmorin, a French painter  [New artist to watch in 2026] (#2563)")
        self.assertEqual(r["title_note"], "New artist to watch in 2026")
        self.assertEqual(r["descriptor"], "French painter")

    def test_themed_week_prefixes(self):
        r = self.t("Artist of the day, May 28: (India week): Paresh Maity, Indian painter, sculptor")
        self.assertEqual((r["subject"], r["title_note"]), ("Paresh Maity", "India week"))
        r = self.t("Artist of the day, April 9: Marian Bantjes (Women in the arts week): Canadian graphic designer, typographer")
        self.assertEqual((r["subject"], r["descriptor"]), ("Marian Bantjes", "Canadian graphic designer, typographer"))
        r = self.t("Artist of the day, December 2, 2020: Women in arts week: Mona Hatoum, Palestinian installation artist")
        self.assertEqual((r["subject"], r["title_note"]), ("Mona Hatoum", "Women in arts week"))

    def test_missing_comma_and_aliases(self):
        r = self.t("Artist of the Day, June 5, 2026 : Flavien Couche a French painter (#2545)")
        self.assertEqual((r["subject"], r["descriptor"]), ("Flavien Couche", "French painter"))
        r = self.t("Artist of the Day, March 26, 2021: Nikolator (Nikolai Muth) a German photographer (#1241)")
        self.assertEqual(r["subject"], "Nikolator (Nikolai Muth)")
        r = self.t('Artist of the Day, March 7, 2022: Ljubica "Cuca" Sokić, a Serbian painter (#1531)')
        self.assertEqual(classify_post(r["subject"], r["descriptor"], r["plural"]), "artist")

    def test_more_separators(self):
        r = self.t("Artist of the Day, May 1, 2024: Wang Guangyi. A Chinese painter (#2001)")
        self.assertEqual((r["subject"], r["descriptor"]), ("Wang Guangyi", "Chinese painter"))
        r = self.t("Artist of the Day, May 1, 2024: Joost Schmidt was a German typographer (#2001)")
        self.assertEqual((r["subject"], r["descriptor"]), ("Joost Schmidt", "German typographer"))
        r = self.t("Artist of the Day, December 4, 2021: Victor A. Lundy, an American architect (#1438)")
        self.assertEqual(r["subject"], "Victor A. Lundy")
        r = self.t("Artist of the day, July 1: (Happy birthday Canada): Alan Caswell Collier, Canadian painter")
        self.assertEqual((r["subject"], r["title_note"]), ("Alan Caswell Collier", "Happy birthday Canada"))
        for name in ("Lucas Cranach the Elder", "Philip-Lorca diCorcia", "Danny J. Martinez a.k.a. Van Dam One"):
            r = self.t(f"Artist of the Day, May 1, 2024: {name} (#2001)")
            self.assertEqual(classify_post(r["subject"], r["descriptor"], r["plural"]), "artist", name)

    def test_bilingual(self):
        r = self.t("Artista do dia, (semana do Brasil) 9 de janeiro: Fred Gelli (Tatil), designer gráfico "
                   "brasileiro/Artist of the day, (Brazil week) January 9: Fred Gelli (Tatil), Brazilian graphic designer",
                   "2018-01-08T20:00:00.000-05:00")
        self.assertEqual(r["subject"], "Fred Gelli (Tatil)")
        self.assertEqual(r["title_note"], "Brazil week")
        self.assertEqual(r["feature_date"], "2018-01-09")


class ClassifyPostTests(unittest.TestCase):
    def kind(self, title):
        r = parse_title(title, "2023-01-01T00:00:00.000-05:00")
        return classify_post(r["subject"], r["descriptor"], r["plural"])

    def test_kinds(self):
        self.assertEqual(self.kind("Artist of the Day, March 9, 2023: Walker Evans, an American photographer (#1798)"), "artist")
        self.assertEqual(self.kind("Artists of the Day, August 19, 2023: Art Deco movement (Part 1)  #1883"), "theme")
        self.assertEqual(self.kind("Artists of the Day, January 7, 2023: Ice sculptors around the world (#1746)"), "theme")
        self.assertEqual(self.kind("Artists of the Day, November 12, 2022: Nayan and Vaishali, Indian artists (#1698)"), "group")
        self.assertEqual(self.kind("Artist of the Day, June 2, 2026 : Studio Practica, a Spanish design studio. (#2542)"), "group")
        self.assertEqual(self.kind("Artist of the Day, October 17, 2026 :  The evolution of women’s headwear (#2660)"), "theme")
        self.assertEqual(self.kind("Artists of the Day, February 11, 2023: What Happened in 1923: Major News and Events, History (#1776)"), "theme")
        self.assertEqual(self.kind("Artist of the Day, May 18, 2022: Claude & François-Xavier Lalanne, French sculptor and installation artists (#1572)"), "group")
        self.assertEqual(self.kind("Artist of the Day, October 3, 2024: Elizabeth Fritsch, a British studio potter, and ceramist (#2127)"), "artist")
        self.assertEqual(self.kind("Artist of the day, May 1, 2020: Lawren Stewart Harris, a Canadian painter (member of Group of Seven)"), "artist")
        self.assertEqual(self.kind("Artist of the Day, May 1, 2022: Clark Orr (CODC Studio), an American graphic designer (#1561)"), "artist")


class DescriptorTests(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(parse_descriptor("American ceramist"), ("American", ["ceramist"]))
        self.assertEqual(parse_descriptor("British-born American painter and etcher"),
                         ("British-born American", ["painter", "etcher"]))
        self.assertEqual(parse_descriptor("Brazilian Painter, sculptor, installation artist"),
                         ("Brazilian", ["painter", "sculptor", "installation artist"]))
        self.assertEqual(parse_descriptor("England-born, Australian sculptor"),
                         ("England-born Australian", ["sculptor"]))
        self.assertEqual(parse_descriptor("Canadian/South African designer, letterer & illustrator"),
                         ("Canadian/South African", ["designer", "letterer", "illustrator"]))
        self.assertEqual(parse_descriptor("Iranian born artist and designer"),
                         ("Iranian born", ["artist", "designer"]))


class LifeDateTests(unittest.TestCase):
    def test_forms(self):
        self.assertEqual(parse_life_dates("Edvard Munch (1863 – 1944) was a Norwegian painter", "Edvard Munch")[:2], (1863, 1944))
        self.assertEqual(parse_life_dates("Christa David ( 1979 ) is an American visual artist", "Christa David")[:2], (1979, None))
        self.assertEqual(parse_life_dates("Fan Ho (何藩 1931– 2016) was a celebrated photographer", "Fan Ho")[:2], (1931, 2016))
        self.assertEqual(parse_life_dates("Charles Eames (1907–78) and Ray Eames", "Charles Eames")[:2], (1907, 1978))
        self.assertEqual(parse_life_dates("Born in Wichita, Kansas, W. Eugene Smith (1918 – 1978) became", "W. Eugene Smith")[:2], (1918, 1978))


class CaptionTests(unittest.TestCase):
    def test_forms(self):
        self.assertEqual(parse_caption("1962, L'Incompris (Misunderstood)"), ("L'Incompris (Misunderstood)", 1962, None, False))
        self.assertEqual(parse_caption("Force, 1964"), ("Force", 1964, None, False))
        self.assertEqual(parse_caption("Aloe, c.1914-15"), ("Aloe", 1914, 1915, True))
        self.assertEqual(parse_caption("Crucifixion, circa 1531"), ("Crucifixion", 1531, None, True))
        self.assertEqual(parse_caption("1970-71, Grand Théatre de Québec 2"), ("Grand Théatre de Québec 2", 1970, 1971, False))
        self.assertEqual(parse_caption("The Indefinite Article 1990"), ("The Indefinite Article", 1990, None, False))
        self.assertEqual(parse_caption("2017  Yep, I'm Ready"), ("Yep, I'm Ready", 2017, None, False))
        self.assertEqual(parse_caption("Untitled"), ("Untitled", None, None, False))
        self.assertEqual(parse_caption("©2017 Duffy & Partners. All Rights Reserved"), (None, None, None, False))
        self.assertEqual(parse_caption("Seaweed, 1927 © Georgia O'Keeffe Museum 2017"), ("Seaweed", 1927, None, False))
        self.assertEqual(parse_caption("Balancing Act. Photo: © Félix Morlá"), ("Balancing Act", None, None, False))

    def test_filename_fallback(self):
        self.assertEqual(filename_caption("0 1893 The Scream, 1893.jpg"), "1893 The Scream, 1893")
        self.assertEqual(parse_caption(filename_caption("0 1893 The Scream, 1893.jpg"))[:2], ("The Scream", 1893))
        self.assertIsNone(filename_caption("IMG_1234.jpg"))
        self.assertIsNone(filename_caption("f00bddf29ee31fc71b9b8a32ec4e5acf--monster.jpg"))
        self.assertIsNone(filename_caption("a2191503-0.jpg"))
        self.assertEqual(filename_caption("A-typical-Pakistani-truck-art-1.jpg"), "A typical Pakistani truck art 1")
        self.assertEqual(filename_caption("34 Beach egg.jpg"), "Beach egg")


class ImageTests(unittest.TestCase):
    def test_original_url(self):
        base = "https://blogger.googleusercontent.com/img/b/R29vZ2xl/AVvX"
        self.assertEqual(original_image_url(base + "/s1600/a.jpg"), base + "/s0/a.jpg")
        self.assertEqual(original_image_url(base + "/w644-h918/a.jpg"), base + "/s0/a.jpg")
        self.assertEqual(original_image_url(base + "/d/a.jpg"), base + "/s0/a.jpg")
        self.assertEqual(original_image_url("https://blogger.googleusercontent.com/img/a/AVvXsE=s16000"),
                         "https://blogger.googleusercontent.com/img/a/AVvXsE=s0")
        self.assertIsNone(original_image_url("data:image/png;base64,xx"))

    def test_classify(self):
        self.assertEqual(classify_image(0, "00 David intro.jpg", None, "Christa David"), "intro")
        self.assertEqual(classify_image(1, "02 not smiling portrait of artist chroma david.jpg", None, "Christa David"), "portrait")
        self.assertEqual(classify_image(2, "0 1895 Self-Portrait with Cigarette, 1895.jpg", "Self-Portrait with Cigarette, 1895", "Edvard Munch"), "artwork")
        self.assertEqual(classify_image(1, None, "Edvard Munch", "Edvard Munch"), "portrait")
        self.assertEqual(classify_image(1, None, "Ms. Elizabeth Fritsch", "Elizabeth Fritsch"), "portrait")
        self.assertEqual(classify_image(3, None, "The Artist", "Elizabeth Fritsch"), "artwork")
        self.assertEqual(classify_image(5, "2017 Yep, I'm Ready, 2017.jpg", "2017 Yep, I'm Ready", "Christa David"), "artwork")


if __name__ == "__main__":
    unittest.main()
