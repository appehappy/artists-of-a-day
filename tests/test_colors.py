"""Colour naming and palette summaries. Run: python3 -m unittest"""
import unittest

from aotd.colors import bucket, summarize


class BucketTests(unittest.TestCase):
    def test_named_colours(self):
        cases = {
            (200, 40, 40): "red", (230, 130, 40): "orange", (235, 200, 50): "yellow",
            (60, 150, 70): "green", (40, 150, 150): "teal", (40, 80, 180): "blue",
            (120, 70, 180): "purple", (225, 110, 160): "pink", (110, 75, 45): "brown",
            (15, 15, 15): "black", (128, 128, 128): "grey", (245, 243, 238): "white",
        }
        for rgb, name in cases.items():
            self.assertEqual(bucket(*rgb), name, rgb)


class SummaryTests(unittest.TestCase):
    def test_main_hue_ignores_neutral_background(self):
        s = summarize([["#f4f2ee", 0.6], ["#2f5fb3", 0.3], ["#c8302c", 0.1]])
        self.assertEqual(s["hue"], "blue")
        self.assertEqual(s["buckets"], ["white", "blue"])

    def test_black_and_white_image_has_no_hue(self):
        s = summarize([["#111111", 0.5], ["#eeeeee", 0.45], ["#c8302c", 0.05]])
        self.assertIsNone(s["hue"])


if __name__ == "__main__":
    unittest.main()
