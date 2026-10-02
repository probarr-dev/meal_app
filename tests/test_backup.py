"""A full backup restores everything, including what a JSON export leaves out."""
import os, sys, tempfile, unittest, glob

os.environ["MEALPLAN_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import server  # noqa: E402


class Backup(unittest.TestCase):
    def test_round_trip(self):
        server.init_db()
        with server.db() as c:
            c.execute("INSERT INTO extra(item) VALUES ('Before')")
            c.execute("INSERT INTO config(key,value) VALUES ('vapid_private','secret-key')")
            c.commit()
        data = server.make_backup_bytes()
        with server.db() as c:
            c.execute("DELETE FROM extra"); c.execute("INSERT INTO extra(item) VALUES ('After')")
            c.execute("DELETE FROM config WHERE key='vapid_private'"); c.commit()
        kept = server.restore_from_bytes(data)
        with server.db() as c:
            self.assertEqual([r[0] for r in c.execute("SELECT item FROM extra")], ["Before"])
            self.assertEqual(c.execute("SELECT value FROM config WHERE key='vapid_private'").fetchone()[0], "secret-key")
        self.assertTrue(os.path.exists(kept))  # what was replaced is kept
        self.assertEqual(len(glob.glob(os.path.join(os.path.dirname(server.DB_PATH), "before-restore-*.db"))), 1)

    def test_rejects_junk(self):
        server.init_db()
        with self.assertRaises(ValueError):
            server.restore_from_bytes(b"not a database")


if __name__ == "__main__":
    unittest.main()
