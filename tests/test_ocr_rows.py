"""Rebuilding printed rows from OCR words, and tidying the usual OCR slips."""
import os, sys, unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import ocr  # noqa: E402


class Rows(unittest.TestCase):
    def test_words_become_rows_left_to_right(self):
        words = [{"t": "1.09", "x": 400, "y": 99, "w": 40, "h": 20}, {"t": "B", "x": 450, "y": 100, "w": 12, "h": 20},
                 {"t": "545023", "x": 10, "y": 100, "w": 60, "h": 20}, {"t": "FRUIT", "x": 90, "y": 101, "w": 50, "h": 20},
                 {"t": "648395", "x": 10, "y": 140, "w": 60, "h": 20}, {"t": "YOG", "x": 90, "y": 141, "w": 30, "h": 20},
                 {"t": "2.99", "x": 400, "y": 141, "w": 40, "h": 20}, {"t": "A", "x": 450, "y": 140, "w": 12, "h": 20}]
        self.assertEqual(ocr.rows_from_words(words), ["545023 FRUIT 1.09 B", "648395 YOG 2.99 A"])

    def test_usual_slips_are_tidied(self):
        self.assertEqual(ocr._clean("417009 EGGS 289A"), "417009 EGGS 2.89 A")
        self.assertEqual(ocr._clean("545023 FRUIT 1.09B"), "545023 FRUIT 1.09 B")
        self.assertEqual(ocr._clean("496011 CREPES ~ 1.35 A"), "496011 CREPES 1.35 A")


if __name__ == "__main__":
    unittest.main()
