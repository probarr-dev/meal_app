"""Last-had dates and the tidy-up list."""
import os, sys, tempfile, unittest

os.environ["MEALPLAN_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import server  # noqa: E402


class Bored(unittest.TestCase):
    def test_last_had_ignores_future_weeks(self):
        server.init_db()
        c = server.db()
        past = c.execute("INSERT INTO week(start_date,confirmed) VALUES ('2026-05-02',1)").lastrowid
        future = c.execute("INSERT INTO week(start_date,confirmed) VALUES ('2099-01-03',1)").lastrowid
        m = c.execute("INSERT INTO meal(name) VALUES ('BoredTestMeal')").lastrowid
        c.execute("INSERT INTO week_meal(week_id,meal_id) VALUES (?,?)", (past, m))
        c.execute("INSERT INTO week_meal(week_id,meal_id) VALUES (?,?)", (future, m))
        c.commit()
        self.assertEqual(server.last_had(c)[m], "2026-05-02")


if __name__ == "__main__":
    unittest.main()
