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


def _deskew(g):
    """Scanned pages are often a little crooked: straighten them using the table's ruled lines."""
    ink = cv2.adaptiveThreshold(g, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 31, 15)
    hor = cv2.morphologyEx(ink, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (60, 1)))
    segs = cv2.HoughLinesP(hor, 1, np.pi / 1800, threshold=100, minLineLength=g.shape[1] // 6, maxLineGap=8)
    if segs is None:
        return g
    angles = [np.degrees(np.arctan2(y2 - y1, x2 - x1)) for x1, y1, x2, y2 in segs.reshape(-1, 4)]
    angles = [a for a in angles if abs(a) < 5]
    if not angles:
        return g
    a = float(np.median(angles))
    if abs(a) < 0.08:
        return g
    h, w = g.shape
    M = cv2.getRotationMatrix2D((w / 2, h / 2), a, 1.0)
    return cv2.warpAffine(g, M, (w, h), flags=cv2.INTER_LINEAR, borderValue=255)


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


def _norm(v):
    v = v.reshape(-1).astype(np.float32)
    v = v - v.mean()
    n = np.linalg.norm(v)
    return v / n if n else v


def _label(glyphs, templates):
    """A digit (or "?") for each glyph."""
    if not glyphs:
        return []
    names = sorted(templates)
    T = np.stack([_norm(templates[d]) for d in names])
    X = np.stack([_norm(g) for g in glyphs])
    direct = X @ T.T                       # correlation of each glyph with each template
    k = min(len(glyphs), 8)
    crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 50, 1e-4)
    cv2.setRNGSeed(7)
    _, lab, centres = cv2.kmeans(X, k, None, crit, 5, cv2.KMEANS_PP_CENTERS)
    lab = lab.reshape(-1)
    cname = []
    for c in range(k):
        members = X[lab == c]
        if not len(members):
            cname.append("?")
            continue
        mean = _norm(members.mean(axis=0))
        sc = T @ mean
        order = np.argsort(-sc)
        best = sc[order[0]]
        second = sc[order[1]] if len(order) > 1 else -1
        # the members on their own must mostly agree with the group's name
        votes = np.argmax(direct[lab == c], axis=1)
        agree = (votes == order[0]).mean()
        cname.append(names[order[0]] if best >= 0.45 and best - second >= 0.03 and agree >= 0.6 else "?")
    out = []
    for i in range(len(glyphs)):
        d = cname[lab[i]]
        fit = float(X[i] @ _norm(centres[lab[i]]))
        if d != "?" and fit >= 0.55:
            out.append(d)
            continue
        sc = direct[i]
        order = np.argsort(-sc)
        ok = sc[order[0]] >= 0.55 and (len(order) < 2 or sc[order[0]] - sc[order[1]] >= 0.04)
        out.append(names[order[0]] if ok else "?")
    return out


def read_key_page(image, nsets=4):
    """Returns {"rows": {q: [answer per set]}, "unsure": [q, ...]} or raises KeyReadError."""
    g = _deskew(_gray(image))
    ink = cv2.adaptiveThreshold(g, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 31, 15)
    boxes, hor, ver = _tables(ink)
    if not boxes:
        raise KeyReadError("No answer table found on this page.")
    lines = cv2.dilate(cv2.bitwise_or(hor, ver), np.ones((5, 5), np.uint8))
    # Digits: a gentler threshold than for the rules, so faint or thin print stays joined up.
    soft = cv2.adaptiveThreshold(cv2.GaussianBlur(g, (3, 3), 0), 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 41, 8)
    soft = cv2.morphologyEx(soft, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    ink = cv2.bitwise_and(soft, cv2.bitwise_not(lines))   # keep the digits, drop the table rules
    tables = []
    for x, y, w, h in boxes:
        rows = _lines(hor[y:y + h, x:x + w], 1, 0.3)
        cols = _lines(ver[y:y + h, x:x + w], 0, 0.3)
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
    # Digit pictures from the Q No column: the row number is known (1, 2, 3, … down the
    # tables), so every digit of every question number is a labelled example in the same print.
    samples = {}
    q = 0
    for t in tables:
        for row in t:
            q += 1
            gl = _glyphs(row[0])
            if len(gl) == len(str(q)):
                for d, g in zip(str(q), gl):
                    samples.setdefault(d, []).append(_norm(g))
    templates = {d: np.mean(v, axis=0).reshape(GLYPH[1], GLYPH[0]) for d, v in samples.items() if len(v) >= 1}
    if sum(1 for d in "1234" if d in templates) < 4:
        raise KeyReadError("Could not read the question numbers on this page.")
    # Every answer digit on the page, then group alike digits together (k-means) and name each
    # group by its closest question-number digit. A group's average is much cleaner than one
    # digit, so this copes with print that differs a little from the Q No column.
    cells, glyphs = [], []
    q = 0
    for t in tables:
        for row in t:
            q += 1
            for si, cell in enumerate(row[1:]):
                gl = _glyphs(cell)
                cells.append((q, si, len(glyphs), len(gl)))
                glyphs.extend(gl)
    labels = _label(glyphs, templates)
    rows, unsure = {}, []
    for q, si, start, n in cells:
        val = "".join(labels[start:start + n]) or "?"
        rows.setdefault(q, [""] * (len(tables[0][0]) - 1))[si] = val
        if "?" in val:
            unsure.append(q)
    return {"rows": rows, "unsure": sorted(set(unsure))}


def key_text(rows, set_codes):
    lines = ["Q " + " ".join(set_codes)]
    for q in sorted(rows):
        lines.append(" ".join([str(q)] + [a if a else "?" for a in rows[q]]))
    return "\n".join(lines)
