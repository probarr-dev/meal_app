"""'4 soups' is a quantity of 4 (not a pack of 4 times a quantity of 4)."""
import os, sys, tempfile, unittest, json, threading, urllib.request
from http.server import ThreadingHTTPServer

os.environ["MEALPLAN_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import server  # noqa: E402


class ExtraQty(unittest.TestCase):
    def test_four_soups_is_four_not_sixteen(self):
        server.init_db()
        c = server.db()
        par = c.execute("INSERT INTO person(name,role,is_admin) VALUES ('QtyParent','parent',1)").lastrowid
        wid = server.cycle(c)["thisWeekId"]
        c.commit(); c.close()
        srv = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        server.Handler.signed_in = lambda self, conn: {"id": par, "role": "parent", "pw_must_change": 0, "is_admin": 1, "name": "x"}
        r = urllib.request.Request(f"http://127.0.0.1:{srv.server_port}/api/extra",
                                   data=json.dumps({"item": "QtyTomatoSoup", "amount": 4, "unit": "unit", "week_id": wid, "by": par}).encode(),
                                   headers={"Content-Type": "application/json"})
        json.load(urllib.request.urlopen(r))
        srv.shutdown()
        with server.db() as c2:
            self.assertEqual(c2.execute("SELECT amount FROM extra WHERE item='QtyTomatoSoup'").fetchone()[0], 1)
            self.assertEqual(c2.execute("""SELECT we.qty FROM week_extra we JOIN extra e ON e.id=we.extra_id
                                           WHERE e.item='QtyTomatoSoup' AND we.week_id=?""", (wid,)).fetchone()[0], 4)
            items = [i for g in server.build_shopping(c2, wid) for i in g["items"] if i["item"] == "Qtytomatosoup" or i["key"].lower() == "qtytomatosoup"]
            self.assertEqual(items[0]["amount"], 4)


if __name__ == "__main__":
    unittest.main()
