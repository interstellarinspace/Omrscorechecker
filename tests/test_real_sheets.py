"""Check the scanner against two real phone photos whose answers were read by hand.

Also re-tests each photo rotated, tilted, rescaled, darker, recompressed and
seen at an angle.  Run:  python tests/test_real_sheets.py
"""
import os
import random
import sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
from omr import scanner as S  # noqa: E402

# Hand-read answers (5 = "not attempted" bubble)
TRUTH = {
    "general_knowledge_C1.jpg": dict(version="C1", register="338401003", serial="268619", answers=(
        "4 4 2 5 5 5 5 4 3 4 1 2 5 3 1 4 4 3 2 5 1 3 3 4 4 "
        "5 2 4 3 3 1 3 2 2 2 4 5 2 1 3 2 2 2 5 1 4 2 1 2 2 "
        "3 5 2 1 1 5 2 1 2 3 2 1 1 3 4 3 3 3 2 1 5 4 4 1 1 "
        "5 5 5 5 2 2 3 1 2 2 1 5 5 5 2 2 1 1 4 2 4 3 1 2 3").split()),
    "science_C1.jpg": dict(version="C1", register="338401003", serial="408283", answers=(
        "5 4 2 5 2 3 2 4 1 5 2 1 5 5 1 5 5 4 5 2 5 2 2 5 1 "
        "2 1 4 1 5 3 5 5 5 3 2 4 1 5 4 5 1 5 5 2 3 3 1 4 2 "
        "5 3 2 3 2 2 3 1 1 3 3 5 5 3 2 5 2 4 3 1 1 5 2 4 1 "
        "5 2 5 5 5 4 4 5 5 5 5 5 5 5 2 5 5 5 5 1 3 2 5 5 4").split()),
}
BG = (90, 95, 100)


def variants(img, rng):
    h, w = img.shape[:2]

    def rot(deg):
        M = cv2.getRotationMatrix2D((w / 2, h / 2), deg, 1.0)
        return cv2.warpAffine(img, M, (w, h), borderValue=BG)

    def persp():
        pad = int(0.08 * w)
        big = cv2.copyMakeBorder(img, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=BG)
        H, W = big.shape[:2]
        src = np.float32([[0, 0], [W, 0], [W, H], [0, H]])
        dst = np.float32([[x + rng.uniform(-.05, .05) * W, y + rng.uniform(-.05, .05) * H] for x, y in src])
        return cv2.warpPerspective(big, cv2.getPerspectiveTransform(src, dst), (W, H), borderValue=BG)

    yield "as taken", img
    yield "upside down", cv2.rotate(img, cv2.ROTATE_180)
    yield "sideways", cv2.rotate(img, cv2.ROTATE_90_COUNTERCLOCKWISE)
    yield "tilted 4 deg", rot(4)
    yield "tilted -6 deg", rot(-6)
    yield "higher resolution", cv2.resize(img, None, fx=2.5, fy=2.5, interpolation=cv2.INTER_CUBIC)
    yield "lower resolution", cv2.resize(img, None, fx=0.75, fy=0.75, interpolation=cv2.INTER_AREA)
    yield "darker", np.clip(img * 0.6, 0, 255).astype(np.uint8)
    yield "low JPEG quality", cv2.imdecode(cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 40])[1], 1)
    for i in range(3):
        yield f"at an angle {i + 1}", persp()


def main():
    rng = random.Random(3)
    worst = 0
    for fname, t in TRUTH.items():
        img = cv2.imread(os.path.join(HERE, "photos", fname))
        for name, v in variants(img, rng):
            data = cv2.imencode(".jpg", v, [cv2.IMWRITE_JPEG_QUALITY, 92])[1].tobytes()
            try:
                r = S.scan(data)
            except S.ScanError as e:
                print(f"FAIL {fname} {name}: {e}")
                worst = 100
                continue
            bad = [a["q"] for a in r["answers"] if a["answer"] != t["answers"][a["q"] - 1]]
            hdr = (r["version"], r["register_number"], r["booklet_serial"]) == (t["version"], t["register"], t["serial"])
            worst = max(worst, len(bad) + (0 if hdr else 1))
            print(f"{'OK  ' if not bad and hdr else 'FAIL'} {fname:28s} {name:18s} "
                  f"wrong answers: {len(bad)} {bad[:6]}  header ok: {hdr}")
    return worst


if __name__ == "__main__":
    sys.exit(1 if main() else 0)
