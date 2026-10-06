"""Redeem limits: one per N days, with the next-available date."""
import os, sys, tempfile, unittest

os.environ["MEALPLAN_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import server  # noqa: E402


class Redeem(unittest.TestCase):
    def test_limit(self):
        server.init_db()
        c = server.db()
        kid = c.execute("INSERT INTO person(name,role) VALUES ('RedeemKid','child')").lastrowid
        rid = c.execute("INSERT INTO reward(name,points_cost,limit_days) VALUES ('RTakeaway',12,30)").lastrowid
        r = dict(c.execute("SELECT * FROM reward WHERE id=?", (rid,)).fetchone())
        self.assertIsNone(server.reward_next_available(c, kid, r))
        c.execute("INSERT INTO redemption(person_id,reward_id,status,resolved_at) VALUES (?,?,'approved',datetime('now','-10 days'))", (kid, rid))
        self.assertIsNotNone(server.reward_next_available(c, kid, r))  # 10 days ago, limit 30
        c.execute("UPDATE redemption SET resolved_at=datetime('now','-40 days')")
        self.assertIsNone(server.reward_next_available(c, kid, r))  # long enough ago
        r["limit_days"] = 0
        c.execute("UPDATE redemption SET resolved_at=datetime('now','-1 days')")
        self.assertIsNone(server.reward_next_available(c, kid, r))  # no limit set


if __name__ == "__main__":
    unittest.main()
