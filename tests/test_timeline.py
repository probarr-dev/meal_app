"""Replays the weekly cycle (vote -> plan -> shop -> eat) across the awkward
boundaries and checks cycle() puts every screen on the right week.
Run: python3 -m unittest discover tests"""
import os, sys, tempfile, unittest
from datetime import date, timedelta

os.environ["MEALPLAN_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import server  # noqa: E402


class Timeline(unittest.TestCase):
    def setUp(self):
        if os.path.exists(server.DB_PATH):
            os.remove(server.DB_PATH)
        server.init_db()
        self.c = server.db()

    def tearDown(self):
        self.c.close()

    def set(self, wid, **kw):
        for k, v in kw.items():
            self.c.execute(f"UPDATE week SET {k}=? WHERE id=?", (v, wid))
        self.c.commit()

    def start(self, wid):
        return self.c.execute("SELECT start_date FROM week WHERE id=?", (wid,)).fetchone()[0]

    def test_replay_a_week(self):
        sat = date(2026, 9, 26)  # a Saturday; weeks start Saturday
        self.assertEqual(server.get_week_start_dow(self.c), sat.weekday())
        # Saturday: this week not planned yet -> vote and shop are both this week
        c = server.cycle(self.c, sat)
        self.assertEqual(self.start(c["thisWeekId"]), "2026-09-26")
        self.assertEqual(c["voteWeekId"], c["thisWeekId"])
        self.assertEqual(c["shopWeekId"], c["thisWeekId"])
        # Planned, but not shopped: voting is closed on this week, extras still go here
        self.set(c["thisWeekId"], confirmed=1)
        c = server.cycle(self.c, sat + timedelta(days=2))
        self.assertEqual(c["voteWeekId"], c["thisWeekId"])
        self.assertEqual(c["shopWeekId"], c["thisWeekId"])
        # Shopped: voting moves to next week, extras to next week, Shopping stays on next week
        self.set(c["thisWeekId"], shop_closed=1)
        c = server.cycle(self.c, sat + timedelta(days=3))
        self.assertEqual(c["voteWeekId"], c["nextWeekId"])
        self.assertEqual(c["shopWeekId"], c["nextWeekId"])
        self.assertEqual(c["shopViewWeekId"], c["nextWeekId"])
        # Next week planned and shopped early (Friday): extras go on the week after,
        # Shopping stays put (never past next week), vote skips the decided week
        self.set(c["nextWeekId"], confirmed=1, shop_closed=1)
        c = server.cycle(self.c, sat + timedelta(days=6))
        self.assertEqual(self.start(c["shopWeekId"]), "2026-10-10")
        self.assertEqual(c["shopViewWeekId"], c["nextWeekId"])
        self.assertEqual(self.start(c["voteWeekId"]), "2026-10-10")
        # Saturday rollover: the old next week is now this week
        c = server.cycle(self.c, date(2026, 10, 3))
        self.assertEqual(self.start(c["thisWeekId"]), "2026-10-03")
        self.assertEqual(self.start(c["shopWeekId"]), "2026-10-10")
        self.assertEqual(self.start(c["voteWeekId"]), "2026-10-10")
        self.assertEqual(self.start(c["shopViewWeekId"]), "2026-10-10")

    def test_forgotten_shop_does_not_strand_the_cycle(self):
        # Last week's shop never marked done: a new calendar week still moves on
        c = server.cycle(self.c, date(2026, 9, 26))
        c2 = server.cycle(self.c, date(2026, 10, 3))
        self.assertNotEqual(c["thisWeekId"], c2["thisWeekId"])
        self.assertEqual(c2["voteWeekId"], c2["thisWeekId"])


if __name__ == "__main__":
    unittest.main()
