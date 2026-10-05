"""Healthy-vote points: every vote counts (default), or only chosen meals; re-counted on switching."""
import os, sys, tempfile, unittest

os.environ["MEALPLAN_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import server  # noqa: E402


class Points(unittest.TestCase):
    def test_modes(self):
        server.init_db()
        c = server.db()
        kid = c.execute("INSERT INTO person(name,role) VALUES ('PointsKid','child')").lastrowid
        wk = c.execute("INSERT INTO week(start_date,confirmed) VALUES ('2026-04-04',1)").lastrowid
        open_wk = c.execute("INSERT INTO week(start_date,confirmed) VALUES ('2026-04-11',0)").lastrowid
        salad = c.execute("INSERT INTO meal(name,tags) VALUES ('PtsSalad','Healthy')").lastrowid
        roast = c.execute("INSERT INTO meal(name,tags) VALUES ('PtsRoast','Healthy')").lastrowid
        pizza = c.execute("INSERT INTO meal(name,tags) VALUES ('PtsPizza','Treat')").lastrowid
        for w, m in ((wk, salad), (wk, roast), (wk, pizza), (open_wk, salad)):
            c.execute("INSERT INTO meal_vote(week_id,meal_id,person_id) VALUES (?,?,?)", (w, m, kid))
        c.execute("INSERT INTO week_meal(week_id,meal_id) VALUES (?,?)", (wk, salad))  # only the salad was chosen
        c.commit()
        bal = lambda: c.execute("SELECT COALESCE(SUM(delta),0) FROM points_ledger WHERE person_id=?", (kid,)).fetchone()[0]
        server.sync_healthy_points(c)
        self.assertEqual(bal(), 3)  # default: salad + roast + this week's open vote
        c.execute("DELETE FROM meal_vote WHERE week_id=?", (open_wk,)); c.commit()
        server.sync_healthy_points(c)
        self.assertEqual(bal(), 2)  # an open week's vote taken back loses its point
        c.execute("INSERT INTO config(key,value) VALUES ('points_mode','chosen')"); c.commit()
        server.sync_healthy_points(c)
        self.assertEqual(bal(), 2)  # decided weeks keep points already earned
        c.execute("DELETE FROM points_ledger"); c.commit()
        server.sync_healthy_points(c)
        self.assertEqual(bal(), 1)  # chosen-only: just the salad


if __name__ == "__main__":
    unittest.main()
