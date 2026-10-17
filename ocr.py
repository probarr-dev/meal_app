"""Read a photographed receipt on the server, with no cloud service.

Needs the `tesseract` program (Debian: tesseract-ocr) and Pillow (python3-pil). Without them the app
works as before and photo reading is simply reported as unavailable (pasted text still works).

Why not just the phone's own text recognition? It returns the receipt in columns (all names, then
all prices), which is hard to pair up again. Here every word comes back with its position, so the
rows are rebuilt by height and each line reads "code name price", which the parser handles directly.
"""
import csv
import difflib
import io
import re
import shutil
from collections import Counter
import subprocess
import os
import tempfile

try:
    from PIL import Image, ImageFilter, ImageOps
    HAVE_PIL = True
except ImportError:
    HAVE_PIL = False


def available():
    return HAVE_PIL and shutil.which("tesseract") is not None


def _crop_to_paper(img):
    """Find the receipt strip (the bright paper) in the photo and cut everything else away: a dark table,
    a hob or a kitchen worktop all confuse the text finder."""
    small = img.resize((max(1, img.width // 4), max(1, img.height // 4)))
    px = small.load()
    w, h = small.size
    bright = [sum(1 for y in range(h) if px[x, y] > 165) / h for x in range(w)]
    cols = [x for x in range(w) if bright[x] > 0.35]
    if not cols:
        return img
    # the widest unbroken run of paper-coloured columns
    best, run = (cols[0], cols[0]), [cols[0], cols[0]]
    for x in cols[1:]:
        if x - run[1] <= 2:
            run[1] = x
        else:
            run = [x, x]
        if run[1] - run[0] > best[1] - best[0]:
            best = (run[0], run[1])
    if best[1] - best[0] < w * 0.08:  # nothing paper-like: leave the photo alone
        return img
    rows = [y for y in range(h) if sum(1 for x in range(best[0], best[1]) if px[x, y] > 165) > (best[1] - best[0]) * 0.35]
    top, bottom = (rows[0], rows[-1]) if rows else (0, h - 1)
    pad = 3
    return img.crop((max(0, (best[0] - pad) * 4), max(0, (top - pad) * 4),
                     min(img.width, (best[1] + pad) * 4), min(img.height, (bottom + pad) * 4)))


def _prepare(data):
    """Greyscale, upright, cropped to the paper, enlarged and contrast-stretched."""
    img = Image.open(io.BytesIO(data))
    img = ImageOps.exif_transpose(img).convert("L")
    img = _crop_to_paper(img)
    target = 1500  # a receipt is narrow: make its text big enough to read
    if img.width < target:
        img = img.resize((target, int(img.height * target / img.width)), Image.LANCZOS)
    img = ImageOps.autocontrast(img, cutoff=1)
    return img.filter(ImageFilter.SHARPEN)


def row_bands(img, min_h=14, max_h=120):
    """Find the printed rows by where the ink is, no text reading needed: each row is a band of dark pixels
    between two clear gaps. Returns [(y0, y1)]."""
    g = img.point(lambda p: 255 if p < 120 else 0)  # ink = 255
    w, h = g.size
    inner = (int(w * 0.04), 0, int(w * 0.96), h)  # the paper's own dark edges are not text
    g = g.crop(inner)
    gw = g.size[0]
    ink = [sum(1 for v in g.crop((0, y, gw, y + 1)).getdata() if v) for y in range(h)]
    base = sorted(ink)[len(ink) // 2]  # what an empty row looks like on this photo
    thresh = base + max(3, gw * 0.006)
    bands, start = [], None
    for y, n in enumerate(ink + [0]):
        if n >= thresh and start is None:
            start = y
        elif n < thresh and start is not None:
            bands.append([start, y])
            start = None
    merged = []
    for b in bands:  # a gap of a pixel or two inside a letter is not a gap between rows
        if merged and b[0] - merged[-1][1] <= 3:
            merged[-1][1] = b[1]
        else:
            merged.append(b)
    return [(a, b) for a, b in merged if min_h <= b - a <= max_h]


def _words(img):
    with tempfile.NamedTemporaryFile(suffix=".png") as f:
        img.save(f.name)
        out = subprocess.run(["tesseract", f.name, "stdout", "--psm", "6", "-l", "eng", "tsv"],
                             capture_output=True, text=True, timeout=90, env=dict(os.environ, OMP_THREAD_LIMIT="1")).stdout
    words = []
    for r in csv.DictReader(io.StringIO(out), delimiter="\t", quoting=csv.QUOTE_NONE):
        t = (r.get("text") or "").strip()
        if t and r.get("conf") not in (None, "-1") and float(r["conf"]) >= 0:
            words.append({"t": t, "x": int(r["left"]), "y": int(r["top"]), "w": int(r["width"]), "h": int(r["height"])})
    return words


def grouped_rows(words):
    """Group words into printed rows by vertical position. Each row keeps its words and its top and bottom."""
    if not words:
        return []
    heights = sorted(w["h"] for w in words)
    tol = max(6, heights[len(heights) // 2] * 0.6)  # words within 60% of a typical text height share a row
    rows = []
    for w in sorted(words, key=lambda w: w["y"] + w["h"] / 2):
        mid = w["y"] + w["h"] / 2
        if rows and abs(mid - rows[-1]["mid"]) <= tol:
            rows[-1]["words"].append(w)
            rows[-1]["mid"] = (rows[-1]["mid"] * (len(rows[-1]["words"]) - 1) + mid) / len(rows[-1]["words"])
        else:
            rows.append({"mid": mid, "words": [w]})
    for r in rows:
        r["words"].sort(key=lambda w: w["x"])
        r["text"] = _clean(" ".join(w["t"] for w in r["words"]))
        r["y0"] = min(w["y"] for w in r["words"])
        r["y1"] = max(w["y"] + w["h"] for w in r["words"])
    return rows


def rows_from_words(words):
    return [r["text"] for r in grouped_rows(words)]


def _clean(row):
    """Tidy what OCR commonly gets wrong at the end of a printed row: a lone symbol from a speck of dust, a
    price that lost its point ("289A" -> "2.89 A"), or a price stuck to its VAT letter ("1.09B")."""
    row = re.sub(r"\s+", " ", re.sub(r"(?:^|\s)[^\w\s]{1,2}(?=\s|$)", " ", row)).strip()
    row = re.sub(r"(?<![\d.,])(\d{1,3})(\d{2})\s*([AB])$", r"\1.\2 \3", row)
    row = re.sub(r"(\d[.,]\d{2})([AB])$", r"\1 \2", row)
    return row


# --------------------------------------------------------------------------- reading and reconciling
# A receipt repeats itself (a product bought twice prints twice), earlier receipts printed the same codes
# and prices, and the bottom line states the total. Several independent readings of each row are
# combined, repeated products must agree, and the result must add up to the printed total.

CODE_FIX = str.maketrans({"§": "5", "S": "5", "O": "0", "o": "0", "I": "1", "l": "1", "|": "1", "B": "8"})
PRICE_WORD = re.compile(r"^\d{1,3}[.,:]?\d{2}[AB]?$")
PRICE_RE = re.compile(r"(\d{1,3})[.,](\d{2})")


def _is_product_row(r):
    t = r["text"]
    return bool(re.search(r"\b[0-9§SOolI|]{5,8}\b", t)) and bool(re.search(r"\d[.,]?\d{2}", t)) \
        and not re.search(r"(?i)total|goods|card|terminal|merchant|eft|debit|account", t)


def _stack_ocr(img, boxes, whitelist):
    """Read many small fields in one go: stack each crop in its own white slot and OCR the lot as lines."""
    slot, pad = 90, 10
    sheet = Image.new("L", (max(b[2] - b[0] for b in boxes) * 2 + 2 * pad, slot * len(boxes)), 255)
    for i, (x0, y0, x1, y1) in enumerate(boxes):
        crop = img.crop((x0, y0, x1, y1))
        k = min(2.0, (slot - 2 * pad) / max(1, crop.height))
        crop = crop.resize((max(1, int(crop.width * k)), max(1, int(crop.height * k))), Image.LANCZOS)
        sheet.paste(crop, (pad, i * slot + pad))
    with tempfile.NamedTemporaryFile(suffix=".png") as f:
        sheet.save(f.name)
        out = subprocess.run(["tesseract", f.name, "stdout", "--psm", "6", "-l", "eng",
                              "-c", f"tessedit_char_whitelist={whitelist}", "tsv"], capture_output=True, text=True, timeout=120,
                             env=dict(os.environ, OMP_THREAD_LIMIT="1")).stdout
    slots = [[] for _ in boxes]  # words go back to the slot they sit in, so a missing read can't shift the rest
    for r in csv.DictReader(io.StringIO(out), delimiter="\t", quoting=csv.QUOTE_NONE):
        t = (r.get("text") or "").strip()
        if t and r.get("conf") not in (None, "-1"):
            i = int((int(r["top"]) + int(r["height"]) / 2) // slot)
            if 0 <= i < len(slots):
                slots[i].append((int(r["left"]), t))
    return [" ".join(t for _, t in sorted(sl)) for sl in slots]


HERE = os.path.dirname(os.path.abspath(__file__))
RAPID_PY = os.path.join(HERE, "venv", "bin", "python")


def rapid_available():
    return os.path.exists(RAPID_PY) and os.path.exists(os.path.join(HERE, "ocr_rapid.py"))


def _rapid_lines(img, boxes, workers=3):
    """One-line crops through RapidOCR, in a few processes at once (each is single-threaded, so this is the
    quick way to use several cores). [] if it isn't installed or fails."""
    if not rapid_available():
        return []
    import json
    n = max(1, min(workers, len(boxes)))
    chunks = [boxes[i::n] for i in range(n)]  # interleaved, so each process gets a fair mix
    with tempfile.NamedTemporaryFile(suffix=".png") as f:
        img.save(f.name)
        env = dict(os.environ, OMP_NUM_THREADS="1", OPENBLAS_NUM_THREADS="1")
        procs = [subprocess.Popen([RAPID_PY, os.path.join(HERE, "ocr_rapid.py"), f.name], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=env) for _ in chunks]
        outs = []
        for p, chunk in zip(procs, chunks):
            try:
                out, _ = p.communicate(json.dumps(chunk), timeout=240)
                outs.append([t for t, _ in json.loads(out)] if p.returncode == 0 else None)
            except Exception:
                p.kill()
                outs.append(None)
    if any(o is None for o in outs):
        return []
    merged = [None] * len(boxes)
    for k, res in enumerate(outs):
        merged[k::n] = res
    return merged


def _fields(text):
    """(code, price, vat) as one reader saw them in a line of text; each None if not found."""
    t = text.strip()
    m = re.match(r"^\W*([0-9§SOolI|]{5,8})", t)
    code = m.group(1).translate(CODE_FIX) if m else None
    nums = PRICE_RE.findall(t.replace("O", "0"))
    price = f"{nums[-1][0]}.{nums[-1][1]}" if nums else None
    vat = "B" if re.search(r"\d[.,]\d{2}\s*[A-Z0-9]?B", t) or re.search(r"\d[.,]\d{2}\s*8", t) else "A"
    return code, price, vat


def _near(a, b):
    """True if the codes differ by one wrong, missing or extra character."""
    if a == b:
        return True
    if abs(len(a) - len(b)) > 1:
        return False
    return difflib.SequenceMatcher(None, a, b, autojunk=False).ratio() >= 1 - 1.01 / max(len(a), len(b))


def _pick(cands, support, priority):
    """Choose between readings: two readers agreeing wins; otherwise the best supported; otherwise reader order."""
    cands = [c for c in cands if c]
    if not cands:
        return None
    counts = Counter(cands)
    top = counts.most_common(1)[0]
    if top[1] >= 2:
        return top[0]
    return max(cands, key=lambda c: (support.get(c, 0), -priority(cands, c)))


def combine(rows, total, known_prices=None, known_names=None):
    """rows: [{"readings": [text, ...] (best reader first), "name": str}] -> [{"code","name","price","vat"}], notes."""
    known_prices, known_names = known_prices or {}, known_names or {}
    parsed = [[_fields(t) for t in r["readings"]] for r in rows]
    # how often each code and each (code, price) is read anywhere on the receipt, and in earlier receipts
    code_support = Counter()
    for fields in parsed:
        for c, _, _ in fields:
            if c and len(c) == 6:
                code_support[c] += 1
    for c in known_prices:
        code_support[c] += 3
    first = lambda cands, c: cands.index(c)  # earlier reader = more trusted
    out = []
    for r, fields in zip(rows, parsed):
        codes = [c for c, _, _ in fields]
        # a 7- or 5-digit reading is a 6-digit code with one character added or lost: repair it if a 6-digit reading says how
        fixed = []
        for c in codes:
            if c and len(c) != 6:
                near = [x for x in code_support if len(x) == 6 and _near(c, x)]
                c = max(near, key=lambda x: code_support[x]) if near else c
            fixed.append(c)
        code = _pick(fixed, code_support, first)
        if code and len(code) == 6 and code not in known_prices:
            near = [x for x in code_support if x != code and _near(code, x) and code_support[x] - 1 > code_support[code]]
            if len(near) == 1:  # almost a code that is read much more often: a misread of it
                code = near[0]
        out.append({"code": code, "prices": [p for _, p, _ in fields], "vat": next((v for _, p, v in fields if p), "A"), "name": r["name"]})
    # prices: repeated products must agree, and earlier receipts say what it cost before
    price_support = Counter()
    for o in out:
        for p in o["prices"]:
            if p and o["code"]:
                price_support[(o["code"], p)] += 1
    for o in out:
        for p in known_prices.get(o["code"], []):
            price_support[(o["code"], p)] += 2
        o["price"] = _pick([p for p in o["prices"] if p], {p: price_support[(o["code"], p)] for p in o["prices"] if p}, first)
    by_code = {}
    for o in out:
        by_code.setdefault(o["code"], []).append(o)
    for code, group in by_code.items():
        known = Counter(known_prices.get(code, []))
        # a price read near a price this code always cost before is that price misread (1.99 for 1.09)
        for o in group:
            if o["price"] and known and o["price"] not in known:
                close = [p for p in known if len(p) == len(o["price"]) and sum(a != b for a, b in zip(p, o["price"])) == 1]
                if len(close) == 1:
                    o["price"] = close[0]
        if len(group) >= 2:
            votes = Counter()
            for o in group:
                votes.update(p for p in o["prices"] if p)
            for p, n in known.items():
                votes[p] += 2 * n
            best = votes.most_common(1)
            if best and best[0][1] >= 2:
                for o in group:
                    o["price"] = best[0][0]
        names = Counter(o["name"] for o in group if o["name"])
        prior = known_names.get(code)
        for o in group:
            nm = names.most_common(1)[0][0] if len(group) > 1 and names else o["name"]
            if prior and difflib.SequenceMatcher(None, (nm or "").upper(), prior.upper()).ratio() >= 0.6:
                nm = prior.upper()
            o["name"] = nm
    # the printed total is the last check: if it's off, try the other readings of the rows that disagreed
    notes = []
    items = [o for o in out if o["code"] and o["price"]]
    if total is not None:
        diff = round(total - sum(float(o["price"]) for o in items), 2)
        unpriced = [o for o in out if o["code"] and not o["price"]]
        if len(unpriced) == 1 and diff > 0:  # one line whose price was too faint to read: the total says what it must be
            unpriced[0]["price"] = f"{diff:.2f}"
            items = [o for o in out if o["code"] and o["price"]]  # back in printed order
            notes.append(f"{unpriced[0]['name'] or unpriced[0]['code']}: price worked out from the total")
            diff = 0.0
        if abs(diff) > 0.004:
            alts = [(o, [p for p in set(o["prices"]) if p and p != o["price"]]) for o in items]
            alts = [(o, a) for o, a in alts if a]
            fixed_ = False
            for k in (1, 2):
                if fixed_ or len(alts) < k:
                    continue
                import itertools
                hits = []
                for combo in itertools.combinations(alts, k):
                    for choice in itertools.product(*[a for _, a in combo]):
                        delta = sum(float(c) - float(o["price"]) for (o, _), c in zip(combo, choice))
                        if abs(delta - diff) < 0.004:
                            hits.append((combo, choice))
                if len(hits) == 1:
                    for (o, _), c in zip(*hits[0]):
                        o["price"] = c
                    fixed_ = True
            diff = round(total - sum(float(o["price"]) for o in items), 2)
            if abs(diff) > 0.004:
                notes.append(f"lines add to {total - diff:.2f}, receipt says {total:.2f}")
                if diff > 0:  # a printed row we never found: keep the money in the list so it still adds up
                    items.append({"code": "000000", "name": "UNREADABLE LINE", "price": f"{diff:.2f}", "vat": "A", "missing": True})
    return items, notes


def read_rows(data):
    """Image bytes -> (product rows with several readings each, the printed total or None)."""
    img = _prepare(data)
    rows = grouped_rows(_words(img))
    prod = [r for r in rows if _is_product_row(r)]
    total = None
    for r in rows:
        m = re.search(r"(?i)(?:total|goods)\D*(\d+[.,]\d{2})", r["text"])
        if m:
            total = float(m.group(1).replace(",", "."))
    if len(prod) < 3:
        return [{"readings": [r["text"]], "name": r["text"]} for r in prod], total
    # The printer sets lines at an even pitch. A gap about two pitches wide between two product rows is a row
    # the text finder skipped: add an empty row there so the other readers still get to look at it.
    ys = sorted((r["y0"] + r["y1"]) / 2 for r in prod)
    pitch = sorted(b - a for a, b in zip(ys, ys[1:]))[len(ys) // 2] if len(ys) > 3 else 0
    if pitch:
        height = sorted(r["y1"] - r["y0"] for r in prod)[len(prod) // 2]
        filled = []
        for a, b in zip(prod, prod[1:]):
            filled.append(a)
            gap = (b["y0"] + b["y1"]) / 2 - (a["y0"] + a["y1"]) / 2
            for k in range(1, int(round(gap / pitch))):
                mid = (a["y0"] + a["y1"]) / 2 + gap * k / round(gap / pitch)
                filled.append({"text": "", "words": [], "y0": int(mid - height / 2), "y1": int(mid + height / 2)})
        filled.append(prod[-1])
        prod = filled
    pad = 6
    # a row we had to place by the spacing may be a few pixels out, so it is read at three heights
    variants = [(i, dy) for i, r in enumerate(prod) for dy in ((0,) if r["words"] else (-10, 0, 10))]
    boxes = [[0, max(0, prod[i]["y0"] - pad + dy), img.width, min(img.height, prod[i]["y1"] + pad + dy)] for i, dy in variants]
    real = [r for r in prod if r["words"]]
    cx1 = max(r["words"][0]["x"] + r["words"][0]["w"] for r in real) + 14
    px0 = min((([w for w in r["words"] if PRICE_WORD.match(w["t"].replace(" ", ""))] or [r["words"][-1]])[-1]["x"]) for r in real) - 14
    from concurrent.futures import ThreadPoolExecutor  # the three readers don't wait for each other
    with ThreadPoolExecutor(3) as pool:
        f_rapid = pool.submit(_rapid_lines, img, boxes)
        f_codes = pool.submit(_stack_ocr, img, [(0, b[1] + 2, cx1, b[3] - 2) for b in boxes], "0123456789")
        f_prices = pool.submit(_stack_ocr, img, [(max(0, px0), b[1] + 2, img.width, b[3] - 2) for b in boxes], "0123456789.AB")
        rapid, codes, prices = f_rapid.result(), f_codes.result(), f_prices.result()
    out = []
    for i, r in enumerate(prod):
        readings = [r["text"]] if r["words"] else []
        for k, (j, _) in enumerate(variants):
            if j != i:
                continue
            if rapid and k < len(rapid):
                readings.append(rapid[k])
            readings.append(f"{re.sub(r'[^0-9]', '', codes[k])} {prices[k]}")
        name = re.sub(r"^\W*[0-9§SOolI|]{4,8}\b", "", r["text"])
        name = re.sub(r"\s+\d{1,3}[.,:]?\d{2}\s*[A-Z0-9]{0,3}\b.*$", "", name).strip(" .,:;_~-")
        out.append({"readings": readings, "name": name})
    return out, total


def read_receipt(data, known_prices=None, known_names=None):
    """Image bytes -> the receipt as plain text, one product per line, repaired and ready to parse."""
    rows, total = read_rows(data)
    items, notes = combine(rows, total, known_prices, known_names)
    lines = ["%s %s %s %s" % (i["code"], i["name"], i["price"], i["vat"]) for i in items]
    if total is not None:
        lines.append(f"Total: GBP{total:.2f}")
    return "\n".join(lines)
