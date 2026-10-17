"""Optional second reader, run in its own process (so its memory is returned straight afterwards).

Reads a list of one-line crops with RapidOCR (a small neural text reader, ONNX). Needs `rapidocr-onnxruntime`
and `opencv-python-headless`, installed in a virtualenv at ./venv (see the README). Usage:
    venv/bin/python ocr_rapid.py image.png < '[[x0,y0,x1,y1], ...]'     ->  JSON [[text, confidence], ...]
"""
import json
import sys

import numpy as np
from PIL import Image
from rapidocr_onnxruntime import RapidOCR


def main():
    img = Image.open(sys.argv[1]).convert("RGB")
    boxes = json.load(sys.stdin)
    engine = RapidOCR()
    out = []
    for x0, y0, x1, y1 in boxes:
        crop = np.array(img.crop((x0, y0, x1, y1)))
        res, _ = engine(crop, use_det=False, use_cls=False, use_rec=True)
        # result: [[box, text, confidence-as-text]] (or None for a blank crop)
        text, conf = (res[0][1], float(res[0][2])) if res else ("", 0.0)
        out.append([text, conf])
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
