"""Read a photographed receipt on the server, with no cloud service.

Needs the `tesseract` program (Debian: tesseract-ocr) and Pillow (python3-pil). Without them the app
works as before and photo reading is simply reported as unavailable (pasted text still works).

Why not just the phone's own text recognition? It returns the receipt in columns (all names, then
all prices), which is hard to pair up again. Here every word comes back with its position, so the
rows are rebuilt by height and each line reads "code name price", which the parser handles directly.
"""
import csv
import io
import re
import shutil
import subprocess
import tempfile

try:
    from PIL import Image, ImageFilter, ImageOps
    HAVE_PIL = True
except ImportError:
    HAVE_PIL = False


def available():
    return HAVE_PIL and shutil.which("tesseract") is not None


def _prepare(data):
    """Greyscale, upright, enlarged and contrast-stretched: thermal paper photographed on a phone."""
    img = Image.open(io.BytesIO(data))
    img = ImageOps.exif_transpose(img).convert("L")
    if img.width < 1600:  # tesseract reads small print poorly
        scale = 1600 / img.width
        img = img.resize((1600, int(img.height * scale)), Image.LANCZOS)
    img = ImageOps.autocontrast(img, cutoff=1)
    return img.filter(ImageFilter.SHARPEN)


def _words(img):
    with tempfile.NamedTemporaryFile(suffix=".png") as f:
        img.save(f.name)
        out = subprocess.run(["tesseract", f.name, "stdout", "--psm", "6", "-l", "eng", "tsv"],
                             capture_output=True, text=True, timeout=90).stdout
    words = []
    for r in csv.DictReader(io.StringIO(out), delimiter="\t", quoting=csv.QUOTE_NONE):
        t = (r.get("text") or "").strip()
        if t and r.get("conf") not in (None, "-1") and float(r["conf"]) >= 0:
            words.append({"t": t, "x": int(r["left"]), "y": int(r["top"]), "w": int(r["width"]), "h": int(r["height"])})
    return words


def rows_from_words(words):
    """Group words into printed rows by vertical position, then read each row left to right."""
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
    return [_clean(" ".join(w["t"] for w in sorted(r["words"], key=lambda w: w["x"]))) for r in rows]


def _clean(row):
    """Tidy what OCR commonly gets wrong at the end of a printed row: a lone symbol from a speck of dust, a
    price that lost its point ("289A" -> "2.89 A"), or a price stuck to its VAT letter ("1.09B")."""
    row = re.sub(r"\s+", " ", re.sub(r"(?:^|\s)[^\w\s]{1,2}(?=\s|$)", " ", row)).strip()
    row = re.sub(r"(?<![\d.,])(\d{1,3})(\d{2})\s*([AB])$", r"\1.\2 \3", row)
    row = re.sub(r"(\d[.,]\d{2})([AB])$", r"\1 \2", row)
    return row


def read_receipt(data):
    """Image bytes -> the receipt as plain text, one printed row per line."""
    return "\n".join(rows_from_words(_words(_prepare(data))))
