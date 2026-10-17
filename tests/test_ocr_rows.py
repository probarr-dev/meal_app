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


class Combine(unittest.TestCase):
    def rows(self, *readings_per_row):
        return [{"readings": list(r), "name": "X"} for r in readings_per_row]

    def test_two_readers_agreeing_beat_a_third(self):
        items, _ = ocr.combine(self.rows(["278702 Z 0.75 A", "278727 Z 0.75 A", "278727 0.75"]), 0.75)
        self.assertEqual(items[0]["code"], "278727")

    def test_repeats_must_agree_and_earlier_receipts_settle_it(self):
        rows = self.rows(["556545 M 1.99 B", "556545 M 1.09 B", "556545 1.09"], ["556545 M 1.69 B", "", "556545 1.69"])
        items, _ = ocr.combine(rows, 2.18, known_prices={"556545": ["1.09"]})
        self.assertEqual([i["price"] for i in items], ["1.09", "1.09"])

    def test_total_picks_between_close_readings(self):
        rows = self.rows(["111111 A 1.10 A", "111111 A 1.19 A"], ["222222 B 2.00 A", "222222 B 2.00 A"])
        items, notes = ocr.combine(rows, 3.19)
        self.assertEqual(items[0]["price"], "1.19")  # the only combination that adds to the printed total

    def test_one_unreadable_price_is_worked_out_from_the_total(self):
        rows = self.rows(["111111 A 1.00 A", "111111 A 1.00 A"], ["339791 CARROT 1 A9 A", "339791 0"], ["222222 B 2.00 A", "222222 B 2.00 A"])
        items, notes = ocr.combine(rows, 3.49)
        self.assertEqual([(i["code"], i["price"]) for i in items], [("111111", "1.00"), ("339791", "0.49"), ("222222", "2.00")])

    def test_a_lost_row_keeps_the_sum_honest(self):
        rows = self.rows(["111111 A 1.00 A", "111111 A 1.00 A"])
        items, notes = ocr.combine(rows, 1.59)
        self.assertEqual(round(sum(float(i["price"]) for i in items), 2), 1.59)
        self.assertTrue(notes)
