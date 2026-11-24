"""Read the candidate's name from the boxes at the top of a KEA OMR sheet.

The name is handwritten in capital letters, one letter per box. The box row is found by its
orange lines just above the register number, each box is cut out, and each letter is read by a
small neural network trained on handwritten letters (EMNIST), run here with plain numpy so it
also works in the browser. Handwriting varies, so the result comes with a "sure" flag and the
admin can correct the name.
"""
import base64
import io
import os

import cv2
import numpy as np

LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
NBOX = 31
_W = None


def _weights():
    global _W
    if _W is None:
        p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "name_model.txt")
        with open(p, encoding="ascii") as f:
            z = np.load(io.BytesIO(base64.b64decode(f.read())))
        _W = {k: z[k].astype(np.float32) for k in z.files}
    return _W


# ------------------------------------------------------------------ the letter reader

def _conv(x, w, b):
    """3x3 convolution, padding 1. x: (n, c, h, w), w: (o, c, 3, 3)."""
    n, c, h, wd = x.shape
    xp = np.pad(x, ((0, 0), (0, 0), (1, 1), (1, 1)))
    cols = np.lib.stride_tricks.sliding_window_view(xp, (3, 3), axis=(2, 3))   # n c h w 3 3
    cols = cols.transpose(0, 2, 3, 1, 4, 5).reshape(n * h * wd, c * 9)
    out = cols @ w.reshape(w.shape[0], -1).T + b
    return out.reshape(n, h, wd, -1).transpose(0, 3, 1, 2)


def _pool(x):
    n, c, h, w = x.shape
    h2, w2 = h // 2, w // 2
    return x[:, :, :h2 * 2, :w2 * 2].reshape(n, c, h2, 2, w2, 2).max(axis=(3, 5))


def _predict(batch):
    """batch: (n, 28, 28) in 0..1 (ink bright). Returns probabilities (n, 26)."""
    W = _weights()
    x = batch[:, None].astype(np.float32)
    for i in range(3):
        x = _pool(np.maximum(_conv(x, W[f"c{i}w"], W[f"c{i}b"]), 0))
    x = x.reshape(len(x), -1)
    x = np.maximum(x @ W["f0w"].T + W["f0b"], 0)
    z = x @ W["f1w"].T + W["f1b"]
    z = z - z.max(axis=1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=1, keepdims=True)


def to28(g):
    """A letter's ink (any size) centred in 28x28 like the training pictures, strokes about 3 px."""
    h, w = g.shape
    side = max(h, w)
    pad = np.zeros((side, side), np.float32)
    pad[(side - h) // 2:(side - h) // 2 + h, (side - w) // 2:(side - w) // 2 + w] = g
    im = cv2.resize(pad, (24, 24), interpolation=cv2.INTER_AREA)
    im = im / max(float(im.max()), 1e-6)
    b = (im > 0.35).astype(np.uint8)
    area = float(b.sum())
    if area:
        cnts, _ = cv2.findContours(b, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)
        per = sum(cv2.arcLength(c, True) for c in cnts)
        if per and 2 * area / per < 2.2:   # thin pen: thicken to look like the training letters
            im = cv2.dilate(im, np.ones((2, 2), np.uint8))
    out = np.zeros((28, 28), np.float32)
    out[2:26, 2:26] = im
    out = cv2.GaussianBlur(out, (3, 3), 0.6)
    return np.clip(out / max(float(out.max()), 1e-6), 0, 1)


# ------------------------------------------------------------------ finding the boxes

def _orange(s, level=22):
    return (s[:, :, 2].astype(np.int16) - s[:, :, 0].astype(np.int16)) > level


def name_strip(img, m, register_u0, scale=1.0, W=1860):
    """Pictures (colour, straightened) that may be the row of name boxes, best guess first."""
    t0, t1 = 0.03, 0.97
    u0, u1 = register_u0 - 7.5, register_u0 - 1.0
    H = int(W * (u1 - u0) * 0.0305 / (t1 - t0))
    T, U = np.meshgrid(np.linspace(t0, t1, W), np.linspace(u0, u1, H))
    p = (m.to_px(T, U) * scale).astype(np.float32)
    s = cv2.remap(img, p[..., 0], p[..., 1], cv2.INTER_LINEAR, borderValue=(255, 255, 255))
    o = _orange(s)
    prof = o[:, int(W * 0.05):int(W * 0.95)].mean(1)
    lines = []
    for y in range(H):
        if prof[y] > 0.2:
            if lines and y - lines[-1][-1] <= 2:
                lines[-1].append(y)
            else:
                lines.append([y])
    lines = [int(np.mean(v)) for v in lines]
    rowh = H / (u1 - u0)

    def boxes_in(a, b):
        """How many evenly spaced upright box lines run right across the band from a to b."""
        if not 0.5 * rowh < b - a < 1.6 * rowh:
            return 0
        xs = np.flatnonzero(o[a + 6:b - 5].mean(0) > 0.6)
        if len(xs) == 0 or xs[0] > W * 0.03 or xs[-1] < W * 0.95:
            return 0
        groups = np.split(xs, np.flatnonzero(np.diff(xs) > 3) + 1)
        if len(groups) < 18:
            return 0
        if not 0.8 < np.median(np.diff([g.mean() for g in groups])) / (W / float(NBOX)) < 1.25:
            return 0
        return len(groups)

    pairs = [(a, b) for i, a in enumerate(lines) for b in lines[i + 1:] if 0.7 * rowh <= b - a <= 1.6 * rowh]
    bands = [(a, b, boxes_in(a, b)) for a, b in pairs]
    ink = _ink(s) > 60

    def inked(i):
        a, b, _ = bands[i]
        return ink[a + 4:b - 3, int(W * 0.01):int(W * 0.75)].mean()

    combs = sorted((i for i, x in enumerate(bands) if x[2]), key=lambda i: (bands[i][0], bands[i][1]))
    if os.environ.get("NAMES_DEBUG"):
        print("bands", rowh, bands, [(i, round(inked(i), 4)) for i in combs])
    if not combs:
        return []
    # Letters go in the upper band; the lower one stays empty, and letters can hide the upper
    # band's lines. Offer the box bands with handwriting (highest first) and the band just
    # above the highest box band; read_name keeps the one that reads most confidently.
    out = [i for i in combs if inked(i) > 0.004][:3]
    for c in combs[:2]:
        top = bands[c]
        out += [i for i, x in enumerate(bands) if x[1] == top[0] and 0.75 < (x[1] - x[0]) / float(top[1] - top[0]) < 1.3]
    return [s[max(0, bands[i][0] - 14):bands[i][1] + 4] for i in dict.fromkeys(out)]

def _ink(s):
    """Pen ink (blue or black), with the orange print taken out."""
    r = s[:, :, 2].astype(np.float32)
    bl = s[:, :, 0].astype(np.float32)
    bg = np.maximum(cv2.medianBlur(s[:, :, 2], 31).astype(np.float32), 200)
    light = r > 165                      # the orange print is light; ink crossing it is dark
    return np.clip((bg - r) - light * np.clip((r - bl) - 35, 0, None) * 1.5, 0, 255)


def _box_edges(s):
    o = _orange(s, 45).astype(np.float32)
    prof = np.convolve(o.sum(0), np.ones(3) / 3, "same")
    w = s.shape[1]
    step = w / (NBOX + 1.2)
    best = None
    for p in np.arange(step * 0.9, step * 1.1, 0.25):
        n = int(w / p) + 1
        for x0 in np.arange(0, p, 1.0):
            xs = (x0 + np.arange(n) * p).astype(int)
            xs = xs[xs < w]
            sc = prof[xs].sum()
            if best is None or sc > best[0]:
                best = (sc, x0, p)
    _, x0, p = best
    return x0 + np.arange(0, int((w - x0) / p) + 1) * p


def letters(strip):
    """One entry per box: the letter's ink picture, or None for an empty box."""
    ink = _ink(strip)
    h = ink.shape[0]
    out = []
    xs = _box_edges(strip)
    for a, b in zip(xs[:-1], xs[1:]):
        c = ink[:, int(a + 3):int(b - 2)]
        bw = (c > 60).astype(np.uint8)
        n, lab, st, _ = cv2.connectedComponentsWithStats(bw)
        keep = np.zeros_like(bw)
        for j in range(1, n):
            if st[j, 4] >= 12 and st[j, 3] >= h * 0.12:
                keep[lab == j] = 1
        if keep.sum() < 25:
            out.append(None)
            continue
        ys, xx = np.where(keep)
        out.append((c * keep)[ys.min():ys.max() + 1, xx.min():xx.max() + 1])
    return out


def _read_strip(s):
    boxes = letters(s)
    idx = [i for i, g in enumerate(boxes) if g is not None]
    if not idx:
        return None
    prob = _predict(np.stack([to28(boxes[i]) for i in idx]))
    conf = prob.max(1)
    # a lone mark far from the rest (often the red watermark or a stray line) is not a letter
    keep = []
    for j, i in enumerate(idx):
        near = any(abs(i - k) <= 2 for k in idx if k != i)
        if near or conf[j] >= 0.9:
            keep.append(j)
    if not keep:
        return None
    idx = [idx[j] for j in keep]
    prob, conf = prob[keep], conf[keep]
    chars = {i: LETTERS[k] for i, k in zip(idx, prob.argmax(1))}
    text = ""
    for i in range(idx[0], idx[-1] + 1):
        if i in chars:
            text += chars[i]
        elif not text.endswith(" "):
            text += " "
    return {"name": text.strip(), "sure": bool(conf.min() >= 0.9), "score": float(conf.mean()), "n": len(idx)}


def best_strip(strips):
    """(strip, reading) for the candidate that reads most confidently."""
    best = (None, None)
    for s in strips:
        r = _read_strip(s)
        if r and r["n"] >= 2 and (best[1] is None or r["score"] > best[1]["score"]):
            best = (s, r)
    return best


def read_name(img, m, register_u0, scale=1.0):
    """{"name": "RAKESH M", "sure": bool}; name is "" if it could not be found."""
    try:
        strips = name_strip(img, m, register_u0, scale)
    except cv2.error:
        strips = []
    best = best_strip(strips)[1]
    if best is None or best["score"] < 0.5:
        return {"name": "", "sure": False}
    return {"name": best["name"], "sure": best["sure"]}
