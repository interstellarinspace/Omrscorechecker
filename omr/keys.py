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


EXAM_SETTINGS = ("num_questions", "options", "not_attempted_option", "set_codes", "marking")


def find_subject(cfg, subject_id):
    """Return (subject, exam) for a subject id, or (None, None)."""
    s = next((x for x in cfg["subjects"] if x["id"] == subject_id), None)
    if not s:
        return None, None
    exams = cfg.get("exams") or []
    e = next((x for x in exams if x["id"] == s.get("exam")), exams[0] if exams else {})
    return s, e


def subject_config(cfg, subject_id):
    """The config with the subject's exam settings applied (an exam may override the
    number of questions, options, set codes and marking)."""
    _, e = find_subject(cfg, subject_id)
    out = dict(cfg)
    for k in EXAM_SETTINGS:
        if e and k in e:
            out[k] = e[k]
    return out


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


def parse_answers(text, options, num_questions):
    """Answers typed by the admin for one sheet, in the same layouts as a key.

    Per question: an option (3), 0 or - for no bubble shaded, and * or two options (23) for
    more than one shaded. Returns the answer list grade() expects.
    """
    lines = [ln.strip() for ln in text.splitlines() if ln.strip() and not ln.strip().startswith("#")]
    raw = {}
    numbered = [re.match(r"^(\d+)\s*[\.\):\-=]?\s+(\S+)$|^(\d+)[\.\):=]\s*(\S+)$", ln) for ln in lines]
    if len(lines) > 1 and all(numbered):
        for m in numbered:
            q, a = (m.group(1), m.group(2)) if m.group(1) else (m.group(3), m.group(4))
            raw[int(q)] = a
    else:
        joined = " ".join(lines)
        tokens = re.split(r"[\s,;]+", joined.strip()) if re.search(r"[\s,;]", joined) else list(joined)
        raw = {i: t for i, t in enumerate([t for t in tokens if t], start=1)}
    if not raw:
        raise ValueError("Type the candidate's answers first.")
    bad_q = [q for q in raw if q < 1 or q > num_questions]
    if bad_q:
        raise ValueError(f"There are answers for questions beyond {num_questions}: {bad_q[:5]}")
    missing = [q for q in range(1, num_questions + 1) if q not in raw]
    if missing:
        raise ValueError(f"{len(raw)} answers typed, but the paper has {num_questions} questions. "
                         f"Missing: {', '.join(map(str, missing[:8]))}{'…' if len(missing) > 8 else ''}. Use 0 for a question left blank.")
    out = []
    for q in range(1, num_questions + 1):
        v = raw[q].upper().replace("/", "")
        if v in ("0", "-", "_", ".", "B"):
            out.append({"q": q, "answer": "", "status": "blank"})
        elif v in ("*", "M") or (len(v) > 1 and all(c in options for c in v)):
            out.append({"q": q, "answer": "*", "status": "multiple"})
        elif v in options:
            out.append({"q": q, "answer": v, "status": "ok"})
        else:
            raise ValueError(f"Question {q}: '{raw[q]}' is not one of {', '.join(options)}, 0 (blank) or * (more than one)")
    return out


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
