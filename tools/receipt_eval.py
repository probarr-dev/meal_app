"""Score the photo reader against a hand-typed copy of the same receipt.
Run on the server:  python3 tools/receipt_eval.py photo.jpg truth.txt
Compares (code, price) pairs as a multiset, then the parsed total against the truth."""
import os, sys, re, time
from collections import Counter
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import ocr, server


def pairs(text):
    return Counter((m.group(1), m.group(2)) for l in text.splitlines()
                   for m in [re.match(r"^(\d{5,8})\s.*?(\d+\.\d{2})\s*[AB]?\s*$", l.strip())] if m)


def main(photo, truth):
    t = time.time()
    with server.db() as conn:
        kp, kn = server.receipt_history(conn)
    text = ocr.read_receipt(open(photo, "rb").read(), kp, kn)
    want, got = pairs(open(truth).read()), pairs(text)
    lines, total, _ = server.parse_receipt(text)
    print(f"read in {time.time() - t:.0f}s: {sum(got.values())} of {sum(want.values())} lines, "
          f"{sum((got & want).values())} exactly right; parsed total {total}, lines add to {sum(l['amount'] for l in lines):.2f}")
    for k in sorted((want - got).elements()):
        print("  missing/wrong:", k)
    for k in sorted((got - want).elements()):
        print("  extra/wrong:  ", k)


if __name__ == "__main__":
    main(*sys.argv[1:3])
