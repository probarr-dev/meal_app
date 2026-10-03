"""Draft meal ideas stay out of the library until added."""
import os, sys, tempfile, unittest

os.environ["MEALPLAN_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import server  # noqa: E402


class Ideas(unittest.TestCase):
    def test_seeded_once_and_apart_from_meals(self):
        server.init_db()
        c = server.db()
        n = c.execute("SELECT COUNT(*) FROM meal_idea").fetchone()[0]
        self.assertGreaterEqual(n, 20)
        self.assertEqual(c.execute("SELECT COUNT(*) FROM meal WHERE name='Lasagne'").fetchone()[0], 0)
        c.execute("DELETE FROM meal_idea WHERE name='Lasagne'"); c.commit(); c.close()
        server.init_db()  # a dismissed idea doesn't come back
        c = server.db()
        self.assertEqual(c.execute("SELECT COUNT(*) FROM meal_idea").fetchone()[0], n - 1)


if __name__ == "__main__":
    unittest.main()
