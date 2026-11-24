"""Answer keys and scoring.

Keys live in keys/<subject>/<SET>.txt, one file per subject and paper set.
Any of these formats work in a file:
    3342212...                 one digit per question, in order
    3, 3, 4, 2, ...            comma or space separated
    1 3 / 1. 3 / 1) 3 / 1-3    one numbered answer per line
Use 23 (or 2/3) when more than one option is accepted, and X for a dropped
question (everyone gets the marks for it).

The admin page also accepts a whole subject at once as a table, one row per
question:  Q  A1  B1  C1  D1   (the layout of the published key PDF).
"""
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEY_DIR = os.path.join(ROOT, "keys")
SAFE = re.compile(r"[A-Za-z0-9_-]{1,40}")


def load_config():
    with open(os.path.join(ROOT, "config.json"), encoding="utf-8") as f:
        return json.load(f)


def key_path(subject, set_code):
    if not SAFE.fullmatch(subject or "") or not SAFE.fullmatch(set_code or ""):
        raise ValueError("bad subject or set code")
    return os.path.join(KEY_DIR, subject, f"{set_code}.txt")


def _clean(v, options):
    v = v.upper().replace("/", "").replace(",", "")
    if v in ("X", "-", "*"):
        return "X"
    bad = [c for c in v if c not in options]
    if bad or not v:
        raise ValueError(f"'{v}' is not one of {', '.join(options)} (or X to drop the question)")
    return "".join(sorted(set(v)))


def parse_key(text, options, num_questions):
    lines = [ln.strip() for ln in text.splitlines() if ln.strip() and not ln.strip().startswith("#")]
    raw = {}
    numbered = [re.match(r"^(\d+)\s*[\.\):\-=]?\s+([0-9A-Za-z/,\-]+)$|^(\d+)[\.\):\-=]\s*([0-9A-Za-z/,\-]+)$", ln)
                for ln in lines]
    if len(lines) > 1 and all(numbered):
        for m in numbered:
            q, a = (m.group(1), m.group(2)) if m.group(1) else (m.group(3), m.group(4))
            raw[int(q)] = a
    else:
        joined = " ".join(lines)
        tokens = re.split(r"[\s,;]+", joined.strip()) if re.search(r"[\s,;]", joined) else list(joined)
        for i, t in enumerate([t for t in tokens if t], start=1):
            raw[i] = t
    out = {}
    for q, v in raw.items():
        try:
            out[q] = _clean(v, options)
        except ValueError as e:
            raise ValueError(f"Question {q}: {e}")
    extra = [q for q in out if q < 1 or q > num_questions]
    if extra:
        raise ValueError(f"The key has answers for questions beyond {num_questions}: {extra[:5]}")
    return out


def parse_table(text, set_codes, options, num_questions):
    """Parse 'Q A1 B1 C1 D1' rows (header rows are ignored). Returns {set: {q: ans}}."""
    keys = {s: {} for s in set_codes}
    for ln in text.splitlines():
        parts = [p for p in re.split(r"[\s,;|]+", ln.strip()) if p]
        if len(parts) != len(set_codes) + 1 or not parts[0].isdigit():
            continue
        q = int(parts[0])
        if not 1 <= q <= num_questions:
            raise ValueError(f"Question number {q} is out of range")
        for s, v in zip(set_codes, parts[1:]):
            try:
                keys[s][q] = _clean(v, options)
            except ValueError as e:
                raise ValueError(f"Question {q}, set {s}: {e}")
    if not any(keys.values()):
        raise ValueError("No rows found. Each row should be: question number, then one answer per set.")
    return keys


def key_to_text(key):
    return "\n".join(f"{q} {key[q]}" for q in sorted(key))


def load_key(subject, set_code, cfg):
    p = key_path(subject, set_code)
    if not os.path.exists(p):
        return None
    with open(p, encoding="utf-8") as f:
        k = parse_key(f.read(), cfg["options"], cfg["num_questions"])
    return k or None


def save_key(subject, set_code, text, cfg):
    k = parse_key(text, cfg["options"], cfg["num_questions"])  # validate first
    p = key_path(subject, set_code)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write(key_to_text(k) + "\n")
    return k


def grade(answers, key, cfg):
    """Score read answers against a key.

    Result per question: correct, wrong, skipped (the 'not attempted' option was
    shaded), blank (nothing shaded), multiple (more than one shaded), dropped,
    or no_key.
    """
    m = cfg.get("marking", {})
    pts = {k: float(m.get(k, d)) for k, d in
           (("correct", 1), ("wrong", 0), ("skipped", 0), ("blank", 0), ("multiple", 0))}
    skip_opt = str(cfg.get("not_attempted_option", "") or "")
    counts = {k: 0 for k in ("correct", "wrong", "skipped", "blank", "multiple", "dropped", "no_key")}
    score = 0.0
    rows = []
    for a in answers:
        k = key.get(a["q"], "")
        given = a["answer"]
        if not k:
            res = "no_key"
            gained = 0.0
        elif k == "X":
            res, gained = "dropped", pts["correct"]
        elif a["status"] == "blank":
            res, gained = "blank", pts["blank"]
        elif a["status"] == "multiple":
            res, gained = "multiple", pts["multiple"]
        elif given in k:
            res, gained = "correct", pts["correct"]
        elif skip_opt and given == skip_opt:
            res, gained = "skipped", pts["skipped"]
        else:
            res, gained = "wrong", pts["wrong"]
        counts[res] += 1
        score += gained
        rows.append({"q": a["q"], "given": given, "key": "" if k == "X" else k,
                     "result": res, "marks": gained})
    graded = len([r for r in rows if r["result"] != "no_key"])
    return {"score": round(score, 2), "max_score": round(graded * pts["correct"], 2),
            "counts": counts, "questions": rows}
