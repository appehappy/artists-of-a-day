"""Medium classification rules (aotd/media.py). Run: python3 -m unittest"""
import unittest

from aotd import media

CLASSES = media.KEYS + [media.EXCLUDE]


def scores(**top):
    """Probabilities with the given values and the rest shared out evenly."""
    rest = (1 - sum(top.values())) / (len(CLASSES) - len(top))
    return {m: top.get(m, rest) for m in CLASSES}


class PriorTests(unittest.TestCase):
    def test_unknown_artist_is_neutral(self):
        self.assertEqual(set(media.prior([]).values()), {1.0})
        self.assertEqual(set(media.prior(["other"]).values()), {1.0})

    def test_tiers(self):
        w = media.prior(["painting"])
        self.assertEqual(w["painting"], 1.0)
        self.assertEqual(w["drawing"], media.SECONDARY)
        self.assertEqual(w["sculpture"], media.UNEXPECTED)
        self.assertEqual(w[media.EXCLUDE], media.EXCLUDE_WEIGHT)

    def test_disciplines_combine(self):
        w = media.prior(["sculpture", "photography"])
        self.assertEqual(w["sculpture"], 1.0)
        self.assertEqual(w["photography"], 1.0)

    def test_every_discipline_maps_to_known_media(self):
        for primary, secondary in media.DISCIPLINE_MEDIA.values():
            self.assertTrue(primary)
            self.assertLessEqual(set(primary) | set(secondary), set(media.KEYS))


class DecideTests(unittest.TestCase):
    def test_prior_keeps_a_sculptors_photo_a_sculpture(self):
        # To CLIP a photographed sculpture is often "a photograph".
        ranked = media.decide(scores(photography=0.5, sculpture=0.3), media.prior(["sculpture"]))
        self.assertEqual(ranked[0][0], "sculpture")

    def test_a_confident_image_overrides_the_prior(self):
        ranked = media.decide(scores(print=0.97), media.prior(["painting"]))
        self.assertEqual(ranked[0][0], "print")

    def test_the_post_breaks_a_close_call(self):
        image = scores(painting=0.4, drawing=0.4)
        post = scores(painting=0.7, drawing=0.1)
        self.assertEqual(media.decide(image, media.prior(["illustration"]), post)[0][0], "painting")

    def test_normalised(self):
        ranked = media.decide(scores(graphic=0.6), media.prior(["graphic"]), scores(graphic=0.5))
        self.assertAlmostEqual(sum(p for _, p in ranked), 1.0)
        self.assertEqual([m for m, _ in ranked][:1], ["graphic"])


if __name__ == "__main__":
    unittest.main()
