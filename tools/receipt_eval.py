"""Score the photo reader against a hand-typed copy of the same receipt.
Run on the server:  python3 tools/receipt_eval.py photo.jpg truth.txt [--no-history]
Compares (code, price) pairs as a multiset, then the parsed total against the truth."""
import os, sys, re, time
from collections import Counter
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import ocr, server


def pairs(text):
    return Counter((m.group(1), m.group(2)) for l in text.splitlines()
                   for m in [re.match(r"^(\d{5,8})\s.*?(\d+\.\d{2})\s*[AB]?\s*$", l.strip())] if m)


def main(photo, truth, history=True):
    t = time.time()
    with server.db() as conn:
        kp, kn = server.receipt_history(conn) if history else ({}, {})
    text = ocr.read_receipt(open(photo, "rb").read(), kp, kn)
    want, got = pairs(open(truth).read()), pairs(text)
    lines, total, _ = server.parse_receipt(text)
    print(f"{'with' if history else 'WITHOUT'} history, read in {time.time() - t:.0f}s: {sum(got.values())} of {sum(want.values())} lines, "
          f"{sum((got & want).values())} exactly right; parsed total {total}, lines add to {sum(l['amount'] for l in lines):.2f}")
    for k in sorted((want - got).elements()):
        print("  missing/wrong:", k)
    for k in sorted((got - want).elements()):
        print("  extra/wrong:  ", k)
    if "--debug" in sys.argv:  # what each reader said about the lines that came out wrong
        rows, tot = ocr.read_rows(open(photo, "rb").read())
        items, _ = ocr.combine(rows, tot, kp, kn)
        for r in rows:
            wrong = [i for i in items if (i["code"], i["price"]) in (got - want)]
            if any(i["name"] == r["name"] for i in wrong):
                print("   readings:", r["readings"])


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], "--no-history" not in sys.argv)
