"""Read a phone photo of the KEA-style OMR answer sheet.

How it works
------------
The sheet has a column of short blue timing dashes down the left and right
edges, one dash per printed row. We find both columns of dashes, number
them, and use them to build a map from sheet coordinates to photo pixels:

    t = 0 at the left dash, 1 at the right dash (across the sheet)
    u = row number, with u = 0 at answer row 1 (Q1, Q26, Q51, Q76)

Every bubble on the sheet has a fixed (t, u) position (see TEMPLATE). Because
each row has its own pair of dashes, the map follows paper that is bent or
photographed at an angle. Each bubble grid is then fine-tuned against the
circles actually found in the photo, and finally each bubble is scored by
how much darker its inside is than the paper around it.
"""
import random

import cv2
import numpy as np


class ScanError(Exception):
    pass


# ---------------------------------------------------------------- template
# Grids: (first column t, column step, first row u, row step, columns, rows)
ANSWER_BLOCKS = [0.0809, 0.3148, 0.5425, 0.7744]   # t of option 1 in each block of 25
ANSWER_DT, ANSWER_U0, ANSWER_DU = 0.0402, 0.08, 0.983
REGISTER = dict(t0=0.058, dt=0.0283, u0=-10.70, du=0.977, nx=9, ny=10)
SERIAL = dict(t0=0.654, dt=0.0284, u0=-10.75, du=0.985, nx=6, ny=10)
VERSION = dict(t0=0.355, dt=0.066, u0=-7.65, du=0.965, nx=2, ny=4)  # col 0 = A-D, col 1 = 1-4
OPTIONS = ["1", "2", "3", "4", "5"]
VERSION_LETTERS = ["A", "B", "C", "D"]
VERSION_DIGITS = ["1", "2", "3", "4"]


# ---------------------------------------------------------------- timing marks
def _dash_candidates(img):
    r = img[:, :, 2]
    k = max(31, int(img.shape[1] / 30) | 1)
    bg = cv2.medianBlur(r, k).astype(np.float32) + 1
    dark = 1 - r.astype(np.float32) / bg
    mask = (dark > 0.22).astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    n, _, st, cen = cv2.connectedComponentsWithStats(mask)
    w = img.shape[1]
    lo, hi = w * 0.009, w * 0.045
    out = []
    for i in range(1, n):
        x, y, bw, bh, a = st[i]
        if lo <= bw <= hi and 3 <= bh <= bw / 1.5 and a > 0.6 * bw * bh:
            out.append((cen[i][0], cen[i][1], bw, bh))
    return np.array(out, np.float32).reshape(-1, 4)


def _ransac_vertical(pts, tol, rng):
    best = None
    n = len(pts)
    if n < 2:
        return None
    for _ in range(600):
        i, j = rng.sample(range(n), 2)
        (x1, y1), (x2, y2) = pts[i, :2], pts[j, :2]
        if abs(y2 - y1) < 20 or abs(y2 - y1) < 5 * abs(x2 - x1):
            continue
        a = (x2 - x1) / (y2 - y1)
        d = np.abs(pts[:, 0] - (a * pts[:, 1] + x1 - a * y1))
        inl = np.where(d < tol)[0]
        if best is None or len(inl) > len(best):
            best = inl
    return best


def _number_track(s):
    s = s[np.argsort(s[:, 1])]
    p = np.median(np.diff(s[:, 1]))
    keep = [0]
    for i in range(1, len(s)):
        if s[i, 1] - s[keep[-1], 1] >= 0.5 * p:
            keep.append(i)
    s = s[keep]
    idx, pl = [0], p
    for i in range(1, len(s)):
        g = s[i, 1] - s[i - 1, 1]
        k = max(1, int(round(g / pl)))
        if k == 1:
            pl = 0.7 * pl + 0.3 * g
        idx.append(idx[-1] + k)
    idx = np.array(idx)
    if len(idx) > 1 and np.max(np.diff(idx)) >= 4:
        idx, s = _renumber_scan(s, p)
    return idx, s[:, :2].astype(np.float64)


def _renumber_scan(s, p):
    """Many dashes hidden (e.g. KEA's scans, with text printed over the edges). A scan is flat,
    so the dashes are evenly spaced: number them from a straight-line fit and drop marks that
    are not on the spacing (letters of the overprinted text)."""
    y = s[:, 1].astype(np.float64)
    small = np.diff(y)
    small = small[small < 1.5 * p]
    pitch = float(np.median(small)) if len(small) else p
    best = None
    for ref in range(len(y)):                 # try each mark as the reference, keep the best fit
        idx = np.round((y - y[ref]) / pitch)
        res = np.abs(y - y[ref] - idx * pitch)
        inl = res < 0.25 * pitch
        if best is None or inl.sum() > best[0]:
            best = (inl.sum(), ref)
    idx = np.round((y - y[best[1]]) / pitch)
    for _ in range(3):                        # refine the spacing on the marks that fit
        inl = np.abs(y - y[best[1]] - idx * pitch) < 0.25 * pitch
        b, a = np.polyfit(idx[inl], y[inl], 1)
        pitch = b
        idx = np.round((y - a) / pitch)
    inl = np.abs(y - a - idx * pitch) < 0.25 * pitch
    idx, s = idx[inl], s[inl]
    keep = np.r_[True, np.diff(idx) > 0]
    idx, s = idx[keep], s[keep]
    return (idx - idx[0]).astype(int), s


def find_tracks(img):
    pts = _dash_candidates(img)
    w = img.shape[1]
    rng = random.Random(7)
    found, rest = [], pts.copy()
    for _ in range(2):
        inl = _ransac_vertical(rest, 0.02 * w, rng)
        if inl is None or len(inl) < 12:
            break
        sel = rest[inl]
        p = np.polyfit(sel[:, 1], sel[:, 0], 2)
        d = np.abs(rest[:, 0] - np.polyval(p, rest[:, 1]))
        inl2 = np.where(d < max(4, 0.006 * w))[0]
        sel = rest[inl2]
        mw, mh = np.median(sel[:, 2]), np.median(sel[:, 3])
        ok = (sel[:, 2] > 0.6 * mw) & (sel[:, 2] < 1.5 * mw) & (sel[:, 3] < 2 * mh + 2)
        found.append(sel[ok])
        keep = np.ones(len(rest), bool)
        keep[inl2] = False
        rest = rest[keep]
    if len(found) < 2 or min(len(f) for f in found) < 12:
        raise ScanError("Could not find the rows of small blue dashes along both side edges of the sheet. "
                        "Make sure both left and right edges are fully in the photo.")
    found.sort(key=lambda s: s[:, 0].mean())
    if found[1][:, 0].mean() - found[0][:, 0].mean() < 0.4 * w:
        raise ScanError("Only one edge of the sheet was found. Make sure the whole sheet width is in the photo.")
    return [_number_track(s) for s in found]


# ---------------------------------------------------------------- mapping
class SheetMap:
    """Sheet (t, u) -> photo pixel (x, y)."""

    def __init__(self, tracks, aL, aR):
        (iL, PL), (iR, PR) = tracks
        uL, uR = (iL - aL).astype(np.float64), (iR - aR).astype(np.float64)
        src = np.float32([(0, u) for u in uL] + [(1, u) for u in uR])
        dst = np.float32(list(PL) + list(PR))
        self.H, _ = cv2.findHomography(src, dst, 0)
        self.Hi = np.linalg.inv(self.H)
        self.uL, self.uR = uL, uR
        self.rL = PL - self._h(np.c_[np.zeros(len(uL)), uL])
        self.rR = PR - self._h(np.c_[np.ones(len(uR)), uR])

    def _h(self, pts, H=None):
        return cv2.perspectiveTransform(np.float32(pts).reshape(-1, 1, 2),
                                        self.H if H is None else H).reshape(-1, 2).astype(np.float64)

    def _resid(self, t, u):
        rl = np.c_[np.interp(u, self.uL, self.rL[:, 0]), np.interp(u, self.uL, self.rL[:, 1])]
        rr = np.c_[np.interp(u, self.uR, self.rR[:, 0]), np.interp(u, self.uR, self.rR[:, 1])]
        return (1 - t)[:, None] * rl + t[:, None] * rr

    def to_px(self, t, u):
        t, u = np.broadcast_arrays(np.asarray(t, np.float64), np.asarray(u, np.float64))
        shape = t.shape
        t, u = t.ravel(), u.ravel()
        return (self._h(np.c_[t, u]) + self._resid(t, u)).reshape(shape + (2,))

    def to_tu(self, pts):
        pts = np.asarray(pts, np.float64).reshape(-1, 2)
        tu = self._h(pts, self.Hi)
        for _ in range(3):
            tu = self._h(pts - self._resid(tu[:, 0], tu[:, 1]), self.Hi)
        return tu


# ---------------------------------------------------------------- grids
def _grid_nodes(g):
    i, j = np.meshgrid(np.arange(g["nx"]), np.arange(g["ny"]))
    return g["t0"] + i * g["dt"], g["u0"] + j * g["du"]


def _template_grids():
    grids = {"register": dict(REGISTER), "serial": dict(SERIAL), "version": dict(VERSION)}
    for k, t0 in enumerate(ANSWER_BLOCKS):
        grids[f"answers{k}"] = dict(t0=t0, dt=ANSWER_DT, u0=ANSWER_U0, du=ANSWER_DU, nx=5, ny=25)
    return grids


def _match(tu, g, tol=0.3):
    """Assign circle centres (in t,u) to grid nodes; returns (i, j, mask)."""
    i = np.round((tu[:, 0] - g["t0"]) / g["dt"])
    j = np.round((tu[:, 1] - g["u0"]) / g["du"])
    ok = ((i >= 0) & (i < g["nx"]) & (j >= 0) & (j < g["ny"])
          & (np.abs(tu[:, 0] - (g["t0"] + i * g["dt"])) < g["dt"] * tol)
          & (np.abs(tu[:, 1] - (g["u0"] + j * g["du"])) < g["du"] * tol))
    return i, j, ok


def _refine(tu, g, fit_steps=True):
    g = dict(g)
    for _ in range(5):
        i, j, ok = _match(tu, g)
        if ok.sum() < max(4, 0.25 * g["nx"] * g["ny"]):
            return g, int(ok.sum())
        if fit_steps and len(set(i[ok])) > 1:
            g["t0"], g["dt"] = np.linalg.lstsq(np.c_[np.ones(ok.sum()), i[ok]], tu[ok, 0], rcond=None)[0]
        else:
            g["t0"] = float(np.mean(tu[ok, 0] - i[ok] * g["dt"]))
        if fit_steps and len(set(j[ok])) > 1:
            g["u0"], g["du"] = np.linalg.lstsq(np.c_[np.ones(ok.sum()), j[ok]], tu[ok, 1], rcond=None)[0]
        else:
            g["u0"] = float(np.mean(tu[ok, 1] - j[ok] * g["du"]))
    return g, int(_match(tu, g)[2].sum())


def _circles(gray, radius):
    g = cv2.GaussianBlur(gray, (3, 3), 0)
    c = cv2.HoughCircles(g, cv2.HOUGH_GRADIENT, 1, radius * 1.8, param1=80, param2=14,
                         minRadius=int(radius * 0.8), maxRadius=int(radius * 1.35) + 1)
    return np.zeros((0, 3)) if c is None else c[0]


# ---------------------------------------------------------------- main
def _prepare(image):
    if isinstance(image, (bytes, bytearray)):
        img = cv2.imdecode(np.frombuffer(image, np.uint8), cv2.IMREAD_COLOR)
    else:
        img = cv2.imread(str(image), cv2.IMREAD_COLOR)
    if img is None:
        raise ScanError("Could not read the image. Please upload a JPG or PNG photo.")
    h, w = img.shape[:2]
    if w > h:  # landscape photo: turn the sheet upright (we try both directions below)
        img = cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
        h, w = w, h
    scale = 1280.0 / h
    img = cv2.resize(img, (int(round(w * scale)), 1280),
                     interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC)
    return img


def _edge_rows(tu, g):
    """Circles found in the row just before and just after a grid."""
    n = 0
    for du in (-1, g["ny"]):
        e = dict(g, u0=g["u0"] + du * g["du"], ny=1)
        n += int(_match(tu, e, 0.25)[2].sum())
    return n


def _locate(img):
    """Find timing tracks, choose the row numbering, and fit every bubble grid."""
    tracks = find_tracks(img)
    (iL, PL), (iR, PR) = tracks
    row_len = float(np.median(PR[:, 0]) - np.median(PL[:, 0]))
    radius = ANSWER_DT * row_len * 0.27
    circ = _circles(img.min(axis=2), radius)   # min of colours: works for blue and orange print
    if len(circ) < 100:
        raise ScanError("Could not see the answer bubbles clearly. Retake the photo in better light, in focus.")
    grids0 = _template_grids()
    fill = _fill_map(_ink_map(img), radius)
    best = None
    for aL in range(0, iL[-1] + 1):
        for d in range(-3, 4):
            aR = aL + d
            # require the answer rows to be covered by both tracks
            if not (iL[0] - aL <= 1 and iL[-1] - aL >= 23 and iR[0] - aR <= 1 and iR[-1] - aR >= 23):
                continue
            try:
                m = SheetMap(tracks, aL, aR)
            except cv2.error:
                continue
            tu = m.to_tu(circ[:, :2])
            # circles on the grids, minus circles just outside them (a grid one row off still
            # lands on circles, but then also on the row before or after, where there are none)
            sa = sum(_match(tu, grids0[f"answers{k}"], 0.25)[2].sum() - 2 * _edge_rows(tu, grids0[f"answers{k}"])
                     for k in range(4))
            sh = sum(_match(tu, grids0[h], 0.25)[2].sum() - 2 * _edge_rows(tu, grids0[h]) for h in ("register", "serial"))
            score = sa + sh - 25 * _marks_past_ends(fill, m, grids0)
            if sa + sh >= 120 and (best is None or score > best[0]):   # the bubbles must fit well
                best = (score, aL, aR, m, tu, sa + sh)
    if best is None or best[5] < 120:   # how well the bubbles fit, whatever the pen marks
        raise ScanError("Could not line up the answer grid. Make sure the whole sheet is in the photo, flat and in focus.")
    score, aL, aR, m, tu, _ = best
    grids = {}
    for name, g in grids0.items():
        fit_steps = name.startswith("answers") or name in ("register", "serial")
        g2, n = _refine(tu, g, fit_steps)
        # Guard against a bad fit: keep the step close to the template
        if abs(g2["dt"] - g["dt"]) > 0.15 * g["dt"] or abs(g2["du"] - g["du"]) > 0.08 * g["du"] \
                or abs(g2["t0"] - g["t0"]) > 0.6 * g["dt"] or abs(g2["u0"] - g["u0"]) > 0.6:
            g2 = g
        grids[name] = g2
    # Version code sits in a fixed place relative to the register grid
    rg, r0 = grids["register"], grids0["register"]
    v = dict(grids0["version"])
    v["t0"] += rg["t0"] - r0["t0"]
    v["u0"] += rg["u0"] - r0["u0"]
    grids["version"], _ = _refine(tu, v, fit_steps=False)
    return m, grids, radius


def _ink_map(img):
    """How much each pixel looks like pen ink: darker and more saturated than the paper around it."""
    k = max(41, int(img.shape[1] / 20) | 1)
    r = img[:, :, 2]
    rbg = cv2.medianBlur(r, k).astype(np.float32) + 1
    dark = np.clip(1 - r.astype(np.float32) / rbg, 0, 1)
    s = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)[:, :, 1]
    sbg = cv2.medianBlur(s, k).astype(np.float32)
    sat = np.clip((s.astype(np.float32) - sbg) / 255, 0, 1)
    # Pen and pencil are blue, black or grey. Red and orange (KEA's watermark and print) are
    # strongly saturated too, so they do not count as ink.
    reddish = (r.astype(np.int16) - img[:, :, 0].astype(np.int16)) > 60
    sat[reddish] = 0
    return 0.5 * dark + sat


def _fill_map(ink, radius):
    """Average ink inside a bubble-sized disk, allowing the mark to sit a little off-centre."""
    rr = max(2, int(radius * 0.6))
    yy, xx = np.mgrid[-rr:rr + 1, -rr:rr + 1]
    disk = ((xx * xx + yy * yy) <= rr * rr).astype(np.float32)
    sm = cv2.filter2D(ink, -1, disk / disk.sum())
    s = max(1, int(radius * 0.5))
    return cv2.dilate(sm, np.ones((2 * s + 1, 2 * s + 1), np.uint8))


def _scores(fill, m, g):
    t, u = _grid_nodes(g)
    centers = m.to_px(t, u)  # (ny, nx, 2)
    vals = cv2.remap(fill, centers[..., 0].astype(np.float32), centers[..., 1].astype(np.float32),
                     cv2.INTER_LINEAR, borderValue=0)
    return vals.astype(np.float64), centers


def _pick(row, thr, gap, light=None):
    """Decide which bubble in a group is filled.

    thr:   score above which a bubble counts as filled
    gap:   a second filled bubble within this distance of the first = multiple
    light: a lighter mark still counts when it stands out this much from the
           rest of its row (and is at least half the threshold)
    """
    order = np.argsort(row)[::-1]
    b = row[order[0]]
    s = row[order[1]] if len(row) > 1 else 0.0
    if b < thr:
        rest = np.median(row[order[1:]]) if len(row) > 1 else 0.0
        if light is not None and b >= 0.5 * thr and b - rest >= light and b - s >= 0.6 * light:
            return "ok", int(order[0])
        return "blank", None
    if s >= thr and ((b - s) < gap or s >= 0.75 * b):
        return "multiple", [int(i) for i in order if row[i] >= thr]
    return "ok", int(order[0])


def _marks_past_ends(fill, m, grids0):
    """How many answer blocks have pen marks in the row just before or just after them.

    On a sheet read on the right rows there are none: the row before is the heading and the
    row after is the footer. When the watermark hides timing marks, a row numbering one off
    still lands on bubbles, but then the first or last answer row shows up past an end.
    """
    n = 0
    for k in range(4):
        g = grids0[f"answers{k}"]
        s, _ = _scores(fill, m, g)
        inside = float(np.median(s.max(1) - np.median(s, 1)))
        if inside <= 0:
            continue
        for u0 in (g["u0"] - g["du"], g["u0"] + g["ny"] * g["du"]):
            e, _ = _scores(fill, m, dict(g, u0=u0, ny=1))
            n += (e.max(1) - np.median(e, 1))[0] > 0.25 * inside
    return n


def scan(image, num_questions=100):
    img = _prepare(image)
    errors = []
    loc = None
    flipped = False
    for attempt in (img, cv2.rotate(img, cv2.ROTATE_180)):
        try:
            loc = _locate(attempt)
            img = attempt
            break
        except ScanError as e:
            errors.append(e)
            flipped = True
    if loc is None:
        raise errors[0]
    m, grids, radius = loc
    fill = _fill_map(_ink_map(img), radius)

    ans_scores, ans_centers = [], []
    for k in range(4):
        s, c = _scores(fill, m, grids[f"answers{k}"])
        ans_scores.append(s)
        ans_centers.append(c)
    raw = np.concatenate(ans_scores, 0)[:num_questions]            # (questions, 5)
    # Each printed digit leaves its own amount of "ink"; measure it from the
    # mostly-empty bubbles of each option column and subtract it.
    base = np.percentile(raw, 20, axis=0)
    norm = raw - base
    ans_scores = [norm[k * 25:(k + 1) * 25] for k in range((num_questions + 24) // 25)]
    allv = norm.ravel()
    empty_level = float(np.median(allv))                 # most bubbles are empty
    filled_level = float(np.median(norm.max(axis=1)))    # most questions have one filled bubble
    if filled_level - empty_level < 0.12:                # (nearly) blank sheet
        filled_level = empty_level + 0.3
    thr = empty_level + 0.45 * (filled_level - empty_level)
    gap = 0.2 * (filled_level - empty_level)
    light = 0.22 * (filled_level - empty_level)

    answers, marks = [], []
    for q in range(num_questions):
        k, j = divmod(q, 25)
        row = ans_scores[k][j]
        st, idx = _pick(row, thr, gap, light)
        ans = OPTIONS[idx] if st == "ok" else ("*" if st == "multiple" else "")
        answers.append({"q": q + 1, "answer": ans, "status": st,
                        "fills": [round(float(x), 2) for x in row],
                        "marked": [i for i in range(5) if row[i] >= thr]})
        marks.append(ans_centers[k][j])

    def grid_scores(name):
        s, c = _scores(fill, m, grids[name])
        return s - np.percentile(s, 30), c

    def read_digits(name):
        s, c = grid_scores(name)
        digits, ok = "", True
        for i in range(s.shape[1]):
            st, idx = _pick(s[:, i], thr, gap)
            digits += str(idx) if st == "ok" else "?"
            ok &= st == "ok"
        return digits, ok, s, c

    # KEA's sets are A1 to D1: the version number is always 1. When it reads 2, 3 or 4 the
    # header was placed rows too low (the watermark hid the middle edge marks), so move the
    # register, booklet and version grids up until the number reads 1.
    vs, _ = grid_scores("version")
    st_d, idg = _pick(vs[:, 1], thr, gap)
    if st_d == "ok" and idg:
        moved = {n: dict(grids[n], u0=grids[n]["u0"] - idg * grids[n]["du"]) for n in ("register", "serial", "version")}
        s2, _ = _scores(fill, m, moved["version"])
        s2 = s2 - np.percentile(s2, 30)
        if _pick(s2[:, 1], thr, gap) == ("ok", 0):
            grids.update(moved)

    reg, reg_ok, reg_s, reg_c = read_digits("register")
    ser, ser_ok, ser_s, ser_c = read_digits("serial")
    vs, vc = grid_scores("version")
    st_l, il = _pick(vs[:, 0], thr, gap)
    st_d, idg = _pick(vs[:, 1], thr, gap)
    version = None
    if st_l == "ok" and st_d == "ok":
        version = VERSION_LETTERS[il] + VERSION_DIGITS[idg]
    version_note = None
    if st_l != "ok":
        version_note = "letter " + ("not filled" if st_l == "blank" else "filled more than once")
    elif st_d != "ok":
        version_note = "number " + ("not filled" if st_d == "blank" else "filled more than once")

    name = {"name": "", "sure": False}
    try:
        from . import names as N
        big, scale = img, 1.0
        if isinstance(image, (bytes, bytearray)):   # the handwriting reads better at full size
            big = cv2.imdecode(np.frombuffer(image, np.uint8), cv2.IMREAD_COLOR)
            if big.shape[1] > big.shape[0]:
                big = cv2.rotate(big, cv2.ROTATE_90_CLOCKWISE)
            if flipped:
                big = cv2.rotate(big, cv2.ROTATE_180)
            scale = big.shape[0] / float(img.shape[0])
        name = N.read_name(big, m, grids["register"]["u0"], scale)
    except Exception:   # the name is a help for the admin; never let it stop the scoring
        pass

    return {
        "candidate_name": name["name"],
        "name_sure": name["sure"],
        "version": version,
        "version_note": version_note,
        "register_number": reg,
        "register_complete": reg_ok,
        "booklet_serial": ser,
        "serial_complete": ser_ok,
        "answers": answers,
        "threshold": round(float(thr), 3),
        "_img": img,
        "_radius": radius,
        "_centers": {"answers": ans_centers, "register": (reg_s, reg_c), "serial": (ser_s, ser_c),
                     "version": (vs, vc, il if st_l == "ok" else None, idg if st_d == "ok" else None)},
        "_thr": thr,
    }


def annotate(res, grading=None):
    img = res["_img"].copy()
    r = int(res["_radius"]) + 3
    GREEN, RED, BLUE, ORANGE = (40, 170, 40), (40, 40, 220), (200, 90, 0), (0, 140, 255)
    C = res["_centers"]
    pt = lambda p: (int(round(p[0])), int(round(p[1])))
    per_q = {g["q"]: g for g in grading["questions"]} if grading else {}
    for a in res["answers"]:
        k, j = divmod(a["q"] - 1, 25)
        row = C["answers"][k][j]
        g = per_q.get(a["q"])
        if a["status"] == "multiple":
            for i in a["marked"]:
                cv2.circle(img, pt(row[i]), r, ORANGE, 2)
        elif a["status"] == "ok":
            i = OPTIONS.index(a["answer"])
            color = BLUE
            if g and g["result"] == "correct":
                color = GREEN
            elif g and g["result"] == "wrong":
                color = RED
            cv2.circle(img, pt(row[i]), r, color, 2)
        if g and g["result"] in ("wrong", "blank", "multiple", "skipped") and g["key"]:
            for ch in g["key"]:
                if ch in OPTIONS:
                    cv2.circle(img, pt(row[OPTIONS.index(ch)]), r - 3, GREEN, 1)
    for name in ("register", "serial"):
        s, c = C[name]
        for i in range(s.shape[1]):
            j = int(np.argmax(s[:, i]))
            if s[j, i] >= res["_thr"]:
                cv2.circle(img, pt(c[j, i]), r, BLUE, 2)
    vs, vc, il, idg = C["version"]
    if il is not None:
        cv2.circle(img, pt(vc[il, 0]), r, BLUE, 2)
    if idg is not None:
        cv2.circle(img, pt(vc[idg, 1]), r, BLUE, 2)
    return img
