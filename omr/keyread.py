"""Read an answer key table from a scanned key page (for example KEA's key PDF, which is a
picture with no text in it).

The page has one or two ruled tables with columns: Q No, then one column per set
(A1 B1 C1 D1). The digits are printed, so they are read by comparing each one with the
digits 1 to 5 in the Q No column of the same page (rows 1 to 5), which are in the same font.
Anything that does not look clearly like a digit is returned as "?" for the admin to fix.
"""
import cv2
import numpy as np

GLYPH = (20, 28)  # width, height of a normalised digit


class KeyReadError(Exception):
    pass


def _gray(image):
    if isinstance(image, (bytes, bytearray, memoryview)):
        img = cv2.imdecode(np.frombuffer(bytes(image), np.uint8), cv2.IMREAD_GRAYSCALE)
    else:
        img = image if image.ndim == 2 else cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    if img is None:
        raise KeyReadError("Could not open this page as an image.")
    h, w = img.shape
    if w > h * 1.15:  # landscape: try upright
        img = cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
        h, w = w, h
    scale = 1700.0 / w
    return cv2.resize(img, (1700, int(round(h * scale))), interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC)


def _merge(pos, gap=6):
    out = []
    for p in pos:
        if out and p - out[-1][-1] <= gap:
            out[-1].append(p)
        else:
            out.append([p])
    return [int(round(sum(g) / len(g))) for g in out]


def _tables(ink):
    h, w = ink.shape
    hor = cv2.morphologyEx(ink, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (w // 25, 1)))
    ver = cv2.morphologyEx(ink, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, h // 40)))
    grid = cv2.dilate(cv2.bitwise_or(hor, ver), np.ones((3, 3), np.uint8))
    n, _, stats, _ = cv2.connectedComponentsWithStats(grid)
    boxes = [tuple(stats[i][:4]) for i in range(1, n) if stats[i][2] > w * 0.15 and stats[i][3] > h * 0.2]
    return sorted(boxes, key=lambda b: (b[0] // (w // 4), b[1])), hor, ver


def _lines(mask, axis, frac):
    prof = (mask > 0).sum(axis=axis)
    return _merge([i for i, v in enumerate(prof) if v > frac * prof.max()])


def _glyphs(cell):
    """Ink blobs in a cell, left to right, each normalised to GLYPH size."""
    n, lab, stats, _ = cv2.connectedComponentsWithStats(cell)
    ch, cw = cell.shape
    parts = [stats[i] for i in range(1, n) if stats[i][4] >= 12 and stats[i][3] >= ch * 0.25
             and stats[i][2] >= 3 and stats[i][3] <= ch * 0.95 and stats[i][2] <= cw * 0.8]
    if not parts:
        return []
    parts.sort(key=lambda s: s[0])
    groups = []  # pieces that overlap in x belong to one glyph
    for s in parts:
        if groups and s[0] <= groups[-1][2] + 1:
            g = groups[-1]
            g[0], g[1], g[2], g[3] = min(g[0], s[0]), min(g[1], s[1]), max(g[2], s[0] + s[2]), max(g[3], s[1] + s[3])
        else:
            groups.append([s[0], s[1], s[0] + s[2], s[1] + s[3]])
    tallest = max(g[3] - g[1] for g in groups)
    groups = [g for g in groups if g[3] - g[1] >= 0.6 * tallest]   # specks and smudges
    out = []
    for x0, y0, x1, y1 in groups:
        g = cell[y0:y1, x0:x1]
        hh, ww = g.shape
        side = max(hh, int(ww * GLYPH[1] / GLYPH[0]))
        pad = np.zeros((side, int(side * GLYPH[0] / GLYPH[1]) + 1), np.uint8)
        oy, ox = (side - hh) // 2, (pad.shape[1] - ww) // 2
        pad[oy:oy + hh, ox:ox + ww] = g
        out.append(cv2.resize(pad, GLYPH, interpolation=cv2.INTER_AREA).astype(np.float32))
    return out


def _corr(a, b):
    a = a - a.mean()
    b = b - b.mean()
    d = np.sqrt((a * a).sum() * (b * b).sum())
    return float((a * b).sum() / d) if d else 0.0


def read_key_page(image, nsets=4):
    """Returns {"rows": {q: [answer per set]}, "unsure": [q, ...]} or raises KeyReadError."""
    g = _gray(image)
    ink = cv2.adaptiveThreshold(g, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 31, 15)
    boxes, hor, ver = _tables(ink)
    if not boxes:
        raise KeyReadError("No answer table found on this page.")
    lines = cv2.dilate(cv2.bitwise_or(hor, ver), np.ones((5, 5), np.uint8))
    ink = cv2.bitwise_and(ink, cv2.bitwise_not(lines))   # keep the digits, drop the table rules
    tables = []
    for x, y, w, h in boxes:
        rows = _lines(hor[y:y + h, x:x + w], 1, 0.5)
        cols = _lines(ver[y:y + h, x:x + w], 0, 0.5)
        if len(cols) != nsets + 2 or len(rows) < 4:
            continue
        cells = []
        for r0, r1 in zip(rows[:-1], rows[1:]):
            row = []
            for c0, c1 in zip(cols[:-1], cols[1:]):
                m = 4
                row.append(ink[y + r0 + m:y + r1 - m + 1, x + c0 + m:x + c1 - m + 1])
            cells.append(row)
        tables.append(cells[1:])  # first row is the heading
    if not tables:
        raise KeyReadError(f"The table on this page does not have Q No plus {nsets} set columns.")
    # digit pictures 1..5 from the Q No column, rows 1..5 of the first table
    first = tables[0]
    templates = {}
    for d in range(1, 6):
        if len(first) >= d:
            gl = _glyphs(first[d - 1][0])
            if len(gl) == 1:
                templates[str(d)] = gl[0]
    if len(templates) < 4:
        raise KeyReadError("Could not find the question numbers 1 to 5 on this page.")
    rows, unsure, q = {}, [], 0
    for t in tables:
        for row in t:
            q += 1
            ans = []
            for cell in row[1:]:
                val = ""
                for gl in _glyphs(cell):
                    scores = sorted(((_corr(gl, tp), d) for d, tp in templates.items()), reverse=True)
                    best, d = scores[0]
                    if best < 0.55 or (len(scores) > 1 and best - scores[1][0] < 0.04):
                        val += "?"
                    else:
                        val += d
                ans.append(val or "?")
                if "?" in ans[-1]:
                    unsure.append(q)
            rows[q] = ans
    return {"rows": rows, "unsure": sorted(set(unsure))}


def key_text(rows, set_codes):
    lines = ["Q " + " ".join(set_codes)]
    for q in sorted(rows):
        lines.append(" ".join([str(q)] + [a if a else "?" for a in rows[q]]))
    return "\n".join(lines)
