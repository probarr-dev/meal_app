"""Breakfast (a pick-one extra) is priced from what receipts say a week of it cost."""
import os, sys, tempfile, unittest

os.environ["MEALPLAN_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import server  # noqa: E402


class Breakfast(unittest.TestCase):
    def test_average_of_weekly_spend(self):
        server.init_db()
        c = server.db()
        server.receipt_tables(c)
        c.execute("INSERT INTO extra(item,options) VALUES ('Breakfast','Crêpes,Pancakes')")
        for wk, amounts in ((1, (2.0, 1.0)), (2, (4.0,))):  # week 1: two lines (3.00), week 2: one (4.00)
            c.execute("INSERT INTO week(start_date) VALUES (?)", (f"2026-01-{wk:02d}",))
            rid = c.execute("INSERT INTO receipt(week_id,total) VALUES (?,10)", (wk,)).lastrowid
            for a in amounts:
                c.execute("INSERT INTO receipt_line VALUES (?,?,?,?,?,?,?)", (rid, "1", "x", 1, a, "Breakfast", "extra"))
        groups = [{"items": [{"key": "Breakfast", "item": "Breakfast", "amount": 1, "unit": "unit"}]}]
        est = server.add_estimate(c, groups)
        item = groups[0]["items"][0]
        self.assertEqual((item["priceLow"], item["priceHigh"]), (3.5, 3.5))
        self.assertEqual(est["low"], 3.5)
        self.assertEqual(server.pick_one_keys(c), {"Breakfast"})


if __name__ == "__main__":
    unittest.main()
