#!/usr/bin/env python3
"""Generate the home-screen / PWA icons.

Pure stdlib (zlib + struct) — same rule as the rest of the app, nothing to rot
and no image library to install. Re-run after editing static/icon.svg to keep
the PNGs in step:  python3 make_icons.py
"""

import math
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "static")
MASTER = 1024          # rendered once at 2x the largest export, then downsampled
SIZES = [512, 192, 180]

# Matches the app's accent gradient (the vote button uses the same two colours).
C1 = (0x4f, 0x8c, 0xff)
C2 = (0x7c, 0x4d, 0xff)
WHITE = (255, 255, 255)


def rounded_rect(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def capsule(x, y, x0, y0, x1, y1):
    """A rectangle with fully rounded ends — a fork tine or a handle."""
    return rounded_rect(x, y, x0, y0, x1, y1, (x1 - x0) / 2.0)


def render(n):
    """Return an n x n RGBA bytearray of the icon."""
    s = n / 512.0          # design is authored in a 512 grid
    px = bytearray(n * n * 4)

    for py in range(n):
        yy = py / s
        row = py * n * 4
        for pxi in range(n):
            xx = pxi / s
            i = row + pxi * 4

            if not rounded_rect(xx, yy, 0, 0, 512, 512, 112):
                continue  # outside the squircle: leave fully transparent

            # diagonal gradient
            t = (xx + yy) / 1024.0
            r = int(C1[0] + (C2[0] - C1[0]) * t)
            g = int(C1[1] + (C2[1] - C1[1]) * t)
            b = int(C1[2] + (C2[2] - C1[2]) * t)

            ink = False
            # ---- fork: three tines, a neck, and a handle
            if capsule(xx, yy, 150, 96, 172, 200): ink = True
            elif capsule(xx, yy, 186, 96, 208, 200): ink = True
            elif capsule(xx, yy, 222, 96, 244, 200): ink = True
            elif rounded_rect(xx, yy, 150, 186, 244, 240, 26): ink = True
            elif capsule(xx, yy, 182, 230, 212, 424): ink = True
            # ---- knife: a tapered blade over a handle
            elif capsule(xx, yy, 316, 250, 346, 424): ink = True
            elif 96 <= yy <= 262 and 300 <= xx <= 366:
                # blade widens from the tip down to the bolster
                w = 6 + 28 * ((yy - 96) / 166.0)
                if abs(xx - 331) <= w:
                    ink = True

            if ink:
                r, g, b = WHITE

            px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255
    return px


def downsample(src, n, m):
    """Box-filter n x n RGBA down to m x m — this is what gives smooth edges."""
    out = bytearray(m * m * 4)
    k = n // m
    area = k * k
    for y in range(m):
        for x in range(m):
            r = g = b = a = 0
            for dy in range(k):
                base = ((y * k + dy) * n + x * k) * 4
                for dx in range(k):
                    i = base + dx * 4
                    al = src[i + 3]
                    r += src[i] * al; g += src[i + 1] * al; b += src[i + 2] * al
                    a += al
            o = (y * m + x) * 4
            if a:
                out[o] = r // a; out[o + 1] = g // a; out[o + 2] = b // a
            out[o + 3] = a // area
    return out


def write_png(path, px, n):
    raw = b"".join(b"\x00" + bytes(px[y * n * 4:(y + 1) * n * 4]) for y in range(n))

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", n, n, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)
    return len(png)


if __name__ == "__main__":
    print(f"rendering master at {MASTER}x{MASTER} ...")
    master = render(MASTER)
    for size in SIZES:
        px = downsample(master, MASTER, size) if size != MASTER else master
        path = os.path.join(OUT, f"icon-{size}.png")
        n = write_png(path, px, size)
        print(f"  static/icon-{size}.png  {n:,} bytes")
