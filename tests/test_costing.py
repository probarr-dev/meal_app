"""Per-meal cost is the share of a pack a recipe uses."""
import os, sys, tempfile, unittest

os.environ["MEALPLAN_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import server  # noqa: E402


class Costing(unittest.TestCase):
    def test_line_cost(self):
        self.assertAlmostEqual(server.line_cost(400, "g", "1 kg", 4.25), 1.70)
        self.assertAlmostEqual(server.line_cost(30, "ml", "150 ml", 0.55), 0.11)
        self.assertAlmostEqual(server.line_cost(4, "unit", "6 Each", 0.99), 0.66)
        self.assertAlmostEqual(server.line_cost(2, "unit", "253 g", 2.25), 4.50)  # whole kits
        self.assertAlmostEqual(server.line_cost(1, "unit", None, 6.95), 6.95)


if __name__ == "__main__":
    unittest.main()
