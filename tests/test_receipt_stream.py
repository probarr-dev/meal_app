"""A messy Live Text paste: pairs, name continuations, a product block then a price block,
OCR junk after codes and prices, and a multi-buy ("3 x / 1.39") that belongs to the next product."""
import os, sys, tempfile, unittest

os.environ["MEALPLAN_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import server  # noqa: E402

TEXT = """SHOP STORES
1 Example Road
GBP
111111 FRUIT
AND BARLEY
1.09 B

222222 MIXED JUICE 1L
1.09 B
333333 YOG DRINK 12PK
2.99 A
33333Řš
BAGGED MEAL
2.69 A
444444 NESTLE MULTIPACK
1.49 B
444444 NESTLE MULTIPACK
3 x
1.39
555555 RACER
666666
TUNA
IN BRINE 145G
777777 SAUCE
4 x
0.65
888888 EGGS
1.49 B
4.17 B
2.60 A
0.69 A
1.99 ęŘŚł
Subtotal
12:00:00
Card Number:
************0000
20.29
"""


class Stream(unittest.TestCase):
    def test_reads_everything_and_the_total_matches(self):
        lines, total, _ = server.parse_receipt(TEXT)
        self.assertEqual(round(sum(l["amount"] for l in lines), 2), 20.29)
        self.assertEqual(total, 20.29)
        by = {}
        for l in lines:
            by.setdefault(l["code"], []).append(l)
        self.assertEqual(by["111111"][0]["text"], "FRUIT AND BARLEY")   # a name over two lines
        self.assertEqual(by["33333"][0]["amount"], 2.69)                # junk after the code
        self.assertEqual(by["555555"][0]["qty"], 3)                     # "3 x" goes to the next product
        self.assertEqual(by["555555"][0]["amount"], 4.17)
        self.assertEqual(by["666666"][0]["text"], "TUNA IN BRINE 145G")
        self.assertEqual(by["888888"][0]["amount"], 1.99)               # junk where the VAT letter was


if __name__ == "__main__":
    unittest.main()
