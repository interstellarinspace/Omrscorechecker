"""Read KEA's scanned answer-key PDFs and compare every answer with the keys on the site."""
import os
import sys

import fitz  # PyMuPDF

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
from omr import keyread as KR  # noqa: E402

CASES = [("kreis_2026.pdf", {2: "general_knowledge", 3: "kannada", 4: "science"}),
         ("warder_2026.pdf", {2: "warder_p1"})]
SETS = ["A1", "B1", "C1", "D1"]


def saved(subject, s):
    k = {}
    for ln in open(os.path.join(ROOT, "keys", subject, s + ".txt")):
        a = ln.split()
        if len(a) == 2:
            k[int(a[0])] = a[1]
    return k


def main():
    bad = 0
    for name, pages in CASES:
        doc = fitz.open(os.path.join(HERE, "key_pdfs", name))
        for zoom in (2.0, 2200 / 842, 3.0):          # the website renders pages about 2200 px tall
            for no, page in enumerate(doc, 1):
                png = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom)).tobytes("jpg")
                try:
                    r = KR.read_key_page(png)
                except KR.KeyReadError:
                    assert no not in pages, f"{name} page {no}: no key found"
                    continue
                subject = pages[no]
                wrong = [(q, s) for i, s in enumerate(SETS) for q, a in saved(subject, s).items() if r["rows"][q][i] != a]
                print(f"{'OK ' if not wrong else 'BAD'} {name} page {no} zoom {zoom:.2f} {subject}: {len(wrong)} wrong, unsure {r['unsure']}")
                bad += len(wrong) + len(r["unsure"])
    assert bad == 0, f"{bad} answers read wrong or unsure"
    print("all key PDFs read exactly")


if __name__ == "__main__":
    main()
