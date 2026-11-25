"""Scoring with a student's own answer key and marking scheme (the home page's "My own key").

The key can be typed or pasted (one answer per question, or a table with one column per set),
or read from a photo or PDF of a printed key table. Answers may be written 1-5 or A-E.
The marking scheme is the student's: marks for a correct answer (the same for all, or
different for some questions), marks for a wrong answer, no bubble, more than one bubble and
the "not attempted" option, optionally scaled to each question's marks.
"""
import re

from . import keys as K

OPTIONS = ["1", "2", "3", "4", "5"]
LETTER = {"A": "1", "B": "2", "C": "3", "D": "4", "E": "5"}
MAX_Q = 100   # the KEA OMR sheet has 100 questions


def _digits(v):
    v = v.strip().upper().strip("().")
    if v in ("X", "-", "*", "DROP", "DROPPED", "DELETED"):
        return "X"
    if v and all(c in LETTER for c in v.replace("/", "").replace(",", "")) and not v.isdigit():
        v = "".join(LETTER[c] for c in v.replace("/", "").replace(",", ""))
    return v


def parse_key(text, num_questions=MAX_Q):
    """Returns (sets, keys): sets is the list of set names, keys {set: {q: answer}}."""
    lines = [ln.strip() for ln in (text or "").splitlines() if ln.strip() and not ln.strip().startswith("#")]
    if not lines:
        raise ValueError("Add the answer key first.")
    rows = [[p for p in re.split(r"[\s,;|:=\t]+|(?<=\d)[.)](?=\s|$)", ln) if p] for ln in lines]
    table = [r for r in rows if len(r) >= 3 and r[0].isdigit()]
    if len(table) >= 2 and len(table) >= 0.8 * len([r for r in rows if r and r[0].isdigit()]):
        width = max(set(len(r) for r in table), key=[len(r) for r in table].count)
        head = next((r for r in rows if r and not r[0].isdigit() and len(r) >= width - 1), None)
        names = head[-(width - 1):] if head else [f"Set {i + 1}" for i in range(width - 1)]
        names = [re.sub(r"[^\w -]", "", n)[:12] or f"Set {i + 1}" for i, n in enumerate(names)]
        keys = {n: {} for n in names}
        for r in table:
            if len(r) != width:
                continue
            q = int(r[0])
            if not 1 <= q <= num_questions:
                raise ValueError(f"Question number {q} is more than {num_questions}.")
            for n, v in zip(names, r[1:]):
                if v in ("?", ""):
                    raise ValueError(f"Question {q}, {n}: the answer could not be read. Type it in.")
                try:
                    keys[n][q] = K._clean(_digits(v), OPTIONS)
                except ValueError as e:
                    raise ValueError(f"Question {q}, {n}: {e}") from None
        return names, keys
    # one set: "1 3" lines, "3,1,2,…", or "3124…"
    flat = "\n".join(" ".join(r) if len(r) == 2 and r[0].isdigit() else ln for r, ln in zip(rows, lines))
    mapped = re.sub(r"(?i)\b([A-E](?:/[A-E])*)\b", lambda m: "".join(LETTER[c] for c in m.group(1).upper() if c in LETTER), flat)
    if re.fullmatch(r"[A-Ea-e\s]+", flat):
        mapped = "".join(LETTER[c] for c in flat.upper() if c in LETTER)
    return ["Key"], {"Key": _parse_one(mapped, num_questions)}


def _parse_one(text, num_questions):
    try:
        return K.parse_key(text, OPTIONS, num_questions)
    except ValueError as e:
        raise ValueError(str(e).replace("(or X to drop the question)", "(or A to E, or X for a dropped question)")) from None


def parse_marks(text, num_questions, default):
    """'1-50: 1', '51-100 = 2', '7 2' lines → {q: marks} for those questions."""
    out = {}
    for ln in (text or "").splitlines():
        ln = ln.strip()
        if not ln:
            continue
        m = re.fullmatch(r"(?:q\s*)?(\d+)\s*(?:(?:-|to|–)\s*(\d+))?\s*[:=\s]\s*(-?\d+(?:\.\d+)?)\s*(?:marks?)?", ln, re.I)
        if not m:
            raise ValueError(f"'{ln}': write it like 1-50: 1 or 51-100: 2")
        a, b = int(m.group(1)), int(m.group(2) or m.group(1))
        if not 1 <= a <= b <= num_questions:
            raise ValueError(f"'{ln}': questions go from 1 to {num_questions}")
        for q in range(a, b + 1):
            out[q] = float(m.group(3))
    return out


def grade(answers, key, scheme):
    """K.grade with marks per question. scheme: correct, wrong, blank, multiple, skipped,
    five (the not-attempted option or ""), per_q {q: marks}, scale (negatives follow each
    question's marks, so a 2-mark question loses twice as much)."""
    base = float(scheme.get("correct", 1)) or 1.0
    per_q = {int(q): float(v) for q, v in (scheme.get("per_q") or {}).items()}
    cfg = {"marking": {k: scheme.get(k, 0) for k in ("correct", "wrong", "blank", "multiple", "skipped")},
           "not_attempted_option": scheme.get("five", "")}
    g = K.grade(answers, key, cfg)
    score = maxs = 0.0
    for r in g["questions"]:
        if r["result"] == "no_key":
            continue
        w = per_q.get(r["q"], base)
        if r["result"] in ("correct", "dropped"):
            r["marks"] = w
        elif scheme.get("scale"):
            r["marks"] = r["marks"] * w / base
        score += r["marks"]
        maxs += w
    g["score"], g["max_score"] = round(score, 2), round(maxs, 2)
    return g


def choose_key(pages, answers, version="", want=""):
    """Pick the key (page of the key file, and set) that fits the sheet.

    pages: [{"label": "Page 2", "keys": {set: {q: ans}}}]. The set shaded on the sheet (version)
    or the one the student chose (want) is used when the key has it; among pages, and among sets
    when the sheet's set is unknown, the one the answers agree with most is taken, but only when
    it is clearly ahead. Returns (page index, set, how) or raises ValueError.
    """
    given = {a["q"]: a["answer"] for a in answers if a["status"] == "ok"}

    def agree(key):
        return sum(1 for q, k in key.items() if k != "X" and given.get(q) and given[q] in k)

    cands = [(i, s) for i, p in enumerate(pages) for s in p["keys"]]
    how = "chosen"
    if want and any(s == want for _, s in cands):
        cands = [c for c in cands if c[1] == want]
    elif version and any(s == version for _, s in cands):
        cands = [c for c in cands if c[1] == version]
        how = "from your sheet"
    elif len({s for _, s in cands}) > 1:
        how = "matched"
    if len(cands) == 1:
        return cands[0][0], cands[0][1], how
    scored = sorted(((agree(pages[i]["keys"][s]), i, s) for i, s in cands), reverse=True)
    best, second = scored[0][0], scored[1][0]
    if best >= 15 and best - second >= 8 and best >= 1.3 * second:
        return scored[0][1], scored[0][2], how if how != "chosen" else "matched"
    sets = sorted({s for _, s in cands})
    if len(sets) > 1:
        raise ValueError("Your key has " + str(len(sets)) + " sets (" + ", ".join(sets) + ") and the set on your sheet "
                         + ("reads " + version if version else "could not be read") + ". Choose your set and check again.")
    raise ValueError("Your key file has more than one key in it and your answers do not clearly match one of them. Choose the page with your subject's key and check again.")
