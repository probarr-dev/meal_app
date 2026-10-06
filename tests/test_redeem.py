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


class RequestFlow(unittest.TestCase):
    def test_request_then_approve_applies_swap(self):
        import json, threading, urllib.request
        from http.server import ThreadingHTTPServer
        server.init_db()
        c = server.db()
        kid = c.execute("INSERT INTO person(name,role) VALUES ('ReqKid','child')").lastrowid
        par = c.execute("INSERT INTO person(name,role,is_admin) VALUES ('ReqParent','parent',1)").lastrowid
        rid = c.execute("INSERT INTO reward(name,points_cost,limit_days) VALUES ('ReqTakeaway',3,30)").lastrowid
        meal = c.execute("INSERT INTO meal(name) VALUES ('Takeaway Req')").lastrowid
        for i in range(3):
            c.execute("INSERT INTO points_ledger(person_id,delta,reason) VALUES (?,1,'t')", (kid,))
        c.commit()
        ids = server.cycle(c)
        c.close()
        srv = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        who = {"id": kid}
        server.Handler.signed_in = lambda self, conn: {"id": who["id"], "role": "child" if who["id"] == kid else "parent",
                                                         "pw_must_change": 0, "is_admin": who["id"] == par, "name": "x"}
        def post(path, body):
            r = urllib.request.Request(f"http://127.0.0.1:{srv.server_port}{path}", data=json.dumps(body).encode(),
                                       headers={"Content-Type": "application/json"})
            try:
                return json.load(urllib.request.urlopen(r))
            except urllib.error.HTTPError as e:
                return json.load(e)
        ask = post("/api/redemption/request", {"person_id": kid, "reward_id": rid, "note": "Fri",
                                               "swap_week_id": ids["thisWeekId"], "swap_dow": 4, "swap_meal_id": meal})
        self.assertTrue(ask.get("ok"), ask)
        self.assertIn("already asked", post("/api/redemption/request", {"person_id": kid, "reward_id": rid})["error"])
        with server.db() as c2:
            pend = c2.execute("SELECT id FROM redemption WHERE person_id=?", (kid,)).fetchone()[0]
            self.assertEqual(c2.execute("SELECT COALESCE(SUM(delta),0) FROM points_ledger WHERE person_id=?", (kid,)).fetchone()[0], 3)  # nothing spent yet
        who["id"] = par
        self.assertTrue(post("/api/redemption/resolve", {"id": pend, "decision": "approve", "resolver_id": par}).get("ok"))
        with server.db() as c3:
            self.assertEqual(c3.execute("SELECT COALESCE(SUM(delta),0) FROM points_ledger WHERE person_id=?", (kid,)).fetchone()[0], 0)
            self.assertEqual(c3.execute("SELECT meal_id FROM week_day WHERE week_id=? AND dow=4", (ids["thisWeekId"],)).fetchone()[0], meal)
        srv.shutdown()
