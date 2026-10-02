"""Receipt products counted as a list item show under it on the Prices page."""
import os, sys, tempfile, unittest, threading, json, urllib.request
from http.server import ThreadingHTTPServer

os.environ["MEALPLAN_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import server  # noqa: E402


class Variants(unittest.TestCase):
    def test_pricing_items_lists_counted_as_products(self):
        server.init_db()
        c = server.db()
        server.receipt_tables(c)
        c.execute("INSERT INTO extra(item) VALUES ('Sliced Bread')")
        c.execute("INSERT INTO week(start_date) VALUES ('2026-01-03')")
        rid = c.execute("INSERT INTO receipt(week_id,total) VALUES (1,5)").lastrowid
        for code, text, amt in (("111111", "SEEDED LOAF", 1.89), ("222222", "WHITE LOAF", 0.95), ("222222", "WHITE LOAF", 0.95)):
            c.execute("INSERT INTO receipt_line VALUES (?,?,?,?,?,?,?)", (rid, code, text, 1, amt, "Sliced Bread", "extra"))
        c.commit(); c.close()
        # call the handler's logic through a real request with a stubbed sign-in
        srv = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        server.Handler.signed_in = lambda self, conn: {"id": 1, "role": "parent", "pw_must_change": 0}
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        r = json.load(urllib.request.urlopen(f"http://127.0.0.1:{srv.server_port}/api/pricing/items"))
        srv.shutdown()
        it = next(i for i in r["items"] if i["key"] == "Sliced Bread")
        self.assertEqual([(v["name"], v["times"]) for v in it["variants"]], [("Seeded Loaf", 1), ("White Loaf", 2)])
        self.assertEqual((it["low"], it["high"]), (0.95, 1.89))


if __name__ == "__main__":
    unittest.main()


class LinkedVariant(unittest.TestCase):
    def test_linking_a_variant_keeps_it_listed_and_priced(self):
        server.init_db()
        c = server.db()
        server.receipt_tables(c)
        c.execute("INSERT INTO extra(item) VALUES ('Baked Beans')")
        c.execute("INSERT INTO week(start_date) VALUES ('2026-02-07')")
        rid = c.execute("INSERT INTO receipt(week_id,total) VALUES (2,1)").lastrowid
        c.execute("INSERT INTO receipt_line VALUES (?,?,?,?,?,?,?)", (rid, "333333", "BEANS", 1, 0.39, "Baked Beans", "extra"))
        c.execute("""INSERT INTO price_product(item_key,sku,name,price,variant_code,checked_at)
                     VALUES ('Baked Beans','000000000333333001','Beans',0.27,'333333',datetime('now'))""")
        c.commit(); c.close()
        srv = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        server.Handler.signed_in = lambda self, conn: {"id": 1, "role": "parent", "pw_must_change": 0}
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        r = json.load(urllib.request.urlopen(f"http://127.0.0.1:{srv.server_port}/api/pricing/items"))
        srv.shutdown()
        it = next(i for i in r["items"] if i["key"] == "Baked Beans")
        self.assertEqual(len(it["variants"]), 1)
        self.assertEqual(it["variants"][0]["products"][0]["price"], 0.27)
        self.assertEqual((it["low"], it["high"]), (0.27, 0.27))
