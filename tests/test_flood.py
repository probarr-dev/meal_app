"""Piling up extra requests: warnings, then a reset of that person's week and a short break."""
import os, sys, tempfile, unittest

os.environ["MEALPLAN_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import server  # noqa: E402


class Flood(unittest.TestCase):
    def test_warn_reset_timeout(self):
        server.init_db()
        c = server.db()
        pid = c.execute("INSERT INTO person(name,role) VALUES ('Kid','child')").lastrowid
        wid = c.execute("INSERT INTO week(start_date) VALUES ('2026-03-07')").lastrowid
        # an item a parent already approved earlier in the week must survive
        eid = c.execute("INSERT INTO extra(item) VALUES ('Approved Thing')").lastrowid
        c.execute("INSERT INTO week_extra(week_id,extra_id) VALUES (?,?)", (wid, eid))
        levels = []
        for i in range(12):
            c.execute("INSERT INTO extra_request(person_id,item,week_id) VALUES (?,?,?)", (pid, f"thing{i}", wid))
            server.log_extra(c, pid, f"thing{i}", wid, "asked for")
            n = server.flood_check(c, server.db, pid, wid)
            levels.append(n["level"] if n else 0)
        self.assertEqual(levels, [0, 0, 0, 0, 0, 1, 0, 0, 2, 0, 3, 4])  # limit 12: warns at 6, 9, 11, resets at 12
        self.assertEqual(c.execute("SELECT COUNT(*) FROM extra_request WHERE person_id=?", (pid,)).fetchone()[0], 0)
        self.assertEqual(c.execute("SELECT COUNT(*) FROM extra_log WHERE person_id=?", (pid,)).fetchone()[0], 0)
        self.assertEqual(c.execute("SELECT COUNT(*) FROM week_extra WHERE week_id=?", (wid,)).fetchone()[0], 1)
        self.assertGreaterEqual(server.extras_timeout_left(c, pid), 14)
        c.execute("UPDATE config SET value='0' WHERE key='extras_flood_limit'") if c.execute(
            "SELECT 1 FROM config WHERE key='extras_flood_limit'").fetchone() else c.execute(
            "INSERT INTO config(key,value) VALUES ('extras_flood_limit','0')")
        self.assertIsNone(server.flood_check(c, server.db, pid, wid))  # off means off


if __name__ == "__main__":
    unittest.main()
