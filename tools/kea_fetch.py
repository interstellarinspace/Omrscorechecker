"""Fetch the OMR sheets that KEA publishes, score them and publish them on the website.

Run by .github/workflows/kea-fetch.yml. The admin page writes admin/kea-request.json
(the KEA link, the KEA exam, which exam on this site it belongs to). This script then walks
KEA's page: exam > district > subject > list of exam centres > one PDF per centre.

It is deliberately slow and polite to the government server:
  * one request at a time, about 20 seconds apart (KEA_DELAY),
  * on "429 Too Many Requests" or 503 it waits 2, 5, 15 then 30 minutes, then stops for this run,
  * if a captcha appears it stops and says so. It never tries to solve one,
  * progress is saved after every centre in admin/kea-state.json, so the next run carries on
    where this one stopped and never downloads the same centre twice.

Each sheet is scored with the same scanner and keys as the website and published in the same
encrypted format as the admin page's bulk upload. The admin's own list gets the new entries
through admin/inbox/*.bin, encrypted to the admin's public key (set up on admin sign-in).
"""
import argparse
import base64
import datetime as dt
import hashlib
import html
import json
import os
import random
import re
import secrets
import subprocess
import sys
import time
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

REQUEST = "admin/kea-request.json"
STATE = "admin/kea-state.json"
VAULT = "admin/vault.json"
ALLOWED_HOST = re.compile(r"(^|\.)karnataka\.gov\.in$")
SALT = b"omr-score-check/results/v1"
ITER = 150000
WAITS = (120, 300, 900, 1800)   # seconds to wait after each "too many requests"
UA = "Mozilla/5.0 (compatible; OMRScoreCheck/1.0; slow single-request fetcher)"


class Blocked(Exception):
    """The server keeps saying "too many requests". Stop for now and try again later."""


class CaptchaSeen(Exception):
    """KEA asked for a captcha. We do not solve captchas, so the fetch stops here."""


def now():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def rel(path):
    return os.path.join(ROOT, path)


def read_json(path, default=None):
    try:
        with open(rel(path), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json(path, obj):
    os.makedirs(os.path.dirname(rel(path)), exist_ok=True)
    with open(rel(path), "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=1, ensure_ascii=False)
        f.write("\n")


# ------------------------------------------------------------------ polite HTTP client

class Polite:
    def __init__(self, delay=20.0, waits=None, sleep=time.sleep):
        import requests
        self.s = requests.Session()
        self.s.headers["User-Agent"] = UA
        self.delay, self.waits, self.sleep, self.last, self.count = delay, waits or WAITS, sleep, 0.0, 0

    def request(self, method, url, **kw):
        for attempt in range(len(self.waits) + 1):
            gap = self.delay + random.uniform(0, self.delay / 4) - (time.time() - self.last)
            if gap > 0 and self.count:
                self.sleep(gap)
            r = self.s.request(method, url, timeout=180, allow_redirects=False, **kw)
            self.last, self.count = time.time(), self.count + 1
            if r.status_code in (429, 503):
                if attempt == len(self.waits):
                    raise Blocked(f"KEA answered {r.status_code} (too many requests) even after waiting.")
                wait = self.waits[attempt]
                try:
                    wait = max(wait, int(r.headers.get("Retry-After", "0")))
                except ValueError:
                    pass
                log(f"KEA said {r.status_code}; waiting {wait // 60} min before trying again")
                self.sleep(wait)
                continue
            ctype = r.headers.get("Content-Type", "")
            if "html" in ctype and has_captcha(r.text):
                raise CaptchaSeen("KEA is asking for a captcha.")
            return r


def has_captcha(text):
    # The page always loads a script called Captcha.js, so look for an actual captcha field or image.
    return bool(re.search(r"<(input|img)\b[^>]*(id|name|src)=\"[^\"]*captcha", text, re.I)
                or re.search(r"g-recaptcha|hcaptcha", text, re.I))


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


# ------------------------------------------------------------------ ASP.NET WebForms page

def hidden_fields(page):
    return {m.group(1): html.unescape(m.group(2))
            for m in re.finditer(r'<input type="hidden" name="(__[A-Z]+)" id="[^"]*" value="([^"]*)"', page)}


def options(page, name):
    m = re.search(r'<select name="%s"[^>]*>(.*?)</select>' % re.escape(name), page, re.S)
    if not m:
        return []
    out = []
    for v, t in re.findall(r'<option[^>]*value="([^"]*)"[^>]*>(.*?)</option>', m.group(1), re.S):
        v = html.unescape(v)
        if v.strip() and v.strip() != "-1":
            out.append((v, re.sub(r"\s+", " ", html.unescape(t)).strip()))
    return out


def centres(page):
    """Rows of the centre table: (code, name, button name)."""
    m = re.search(r'id="gvStdData".*?</table>', page, re.S)
    out = []
    for row in re.findall(r"<tr.*?</tr>", m.group(0) if m else "", re.S):
        btn = re.search(r'<input type="submit" name="([^"]+)" value="View"', row)
        cells = [re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", c))).strip()
                 for c in re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)]
        if btn and len(cells) >= 2:
            out.append((cells[0], cells[1], html.unescape(btn.group(1))))
    return out


def grid_pages(page):
    return sorted({int(n) for n in re.findall(r"__doPostBack\(&#39;gvStdData&#39;,&#39;Page\$(\d+)&#39;\)", page)})


class KeaSite:
    def __init__(self, url, http):
        self.url, self.http, self.page = url, http, None

    def load(self):
        r = self.http.request("GET", self.url)
        r.raise_for_status()
        self.page = r.text
        return self.page

    def post(self, fields, target="", argument=""):
        data = hidden_fields(self.page)
        data.update(fields)
        data["__EVENTTARGET"], data["__EVENTARGUMENT"] = target, argument
        r = self.http.request("POST", self.url, data=data)
        return r

    def choose(self, target, fields):
        r = self.post(fields, target)
        if r.status_code != 200 or "gvStdData" not in r.text and "ddlExam" not in r.text:
            raise RuntimeError(f"KEA page did not load after choosing {target} (HTTP {r.status_code}).")
        self.page = r.text
        return self.page

    def pdf_url(self, fields, button):
        f = dict(fields)
        f[button] = "View"
        r = self.post(f)
        loc = r.headers.get("Location")
        if r.status_code in (301, 302, 303) and loc:
            return urllib.parse.urljoin(self.url, loc)
        if r.status_code == 200:
            self.page = r.text  # some centres may show a message instead of a file
        return None

    def download(self, url, dest):
        r = self.http.request("GET", url, stream=True)
        if r.status_code != 200:
            raise RuntimeError(f"PDF download failed (HTTP {r.status_code}).")
        with open(dest, "wb") as f:
            for chunk in r.iter_content(1 << 16):
                f.write(chunk)
        with open(dest, "rb") as f:
            if f.read(5) != b"%PDF-":
                raise RuntimeError("KEA sent something that is not a PDF.")


# ------------------------------------------------------------------ subjects

def match_subject(label, exam_id, cfg, overrides=None):
    """KEA subject label, e.g. 'General Knowledge (PAPER -1) - RPC' -> subject id on this site."""
    if overrides and label.strip() in overrides:
        return overrides[label.strip()] or None
    low = re.sub(r"\s+", " ", label.lower())
    paper = None
    if re.search(r"paper\s*[-:]?\s*(1|i)\b", low):
        paper = "paper i"
    elif re.search(r"paper\s*[-:]?\s*(2|ii)\b", low):
        paper = "paper ii"
    best = None
    for s in cfg["subjects"]:
        if s.get("exam") != exam_id:
            continue
        if paper and s.get("paper", "").lower() != paper:
            continue
        words = [s.get("subject", ""), s.get("short", ""), s.get("name", "").split(":")[-1]]
        words = [w.lower().strip() for w in words if w and len(w.strip()) >= 3]
        if any(w in low or (w.split()[0] in low and len(w.split()[0]) >= 5) for w in words):
            if best is None:
                best = s["id"]
    return best


# ------------------------------------------------------------------ scoring

def pdf_pages(path, dpi=200):
    import fitz  # PyMuPDF
    with fitz.open(path) as doc:
        for i, page in enumerate(doc):
            text = page.get_text("text") or ""
            yield i + 1, page.get_pixmap(dpi=dpi).tobytes("png"), text


def text_field(text, *labels):
    for lab in labels:
        m = re.search(lab + r"\s*[:\-]?\s*([^\n]+)", text, re.I)
        if m and m.group(1).strip():
            return re.sub(r"\s+", " ", m.group(1)).strip()
    return ""


def score_page(png, subject_id, cfg, text=""):
    import cv2
    import numpy as np
    from omr import keys as K
    from omr import scanner as S
    c = K.subject_config(cfg, subject_id)
    res = S.scan(png, c["num_questions"])
    reg = res["register_number"]
    if not res.get("register_complete"):
        t = re.sub(r"\D", "", text_field(text, r"Reg(?:ister|istration)?\.?\s*No\.?", r"Roll\s*No\.?"))
        if 5 <= len(t) <= 12:
            reg = t
    out = {"version": res["version"], "register_number": reg, "booklet_serial": res["booklet_serial"],
           "name": text_field(text, r"Candidate'?s?\s*Name", r"Name")[:80], "grading": None, "error": None}
    if not res["version"] or res["version"] not in c["set_codes"]:
        out["error"] = "version code not read"
    else:
        key = K.load_key(subject_id, res["version"], c)
        if key is None:
            out["error"] = f"no answer key for set {res['version']}"
        else:
            out["grading"] = K.grade(res["answers"], key, c)
    if len(re.sub(r"\D", "", reg or "")) < 5:
        out["error"] = out["error"] or "register number not read"
    img = S.annotate(res, out["grading"])
    h, w = img.shape[:2]
    sc = min(1.0, 1600.0 / max(h, w))
    if sc < 1:
        img = cv2.resize(img, (int(w * sc), int(h * sc)), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 72])
    out["image"] = np.asarray(buf).tobytes()
    out["marking"], out["five"] = c["marking"], c.get("not_attempted_option", "5")
    return out


# ------------------------------------------------------------------ encryption (same as static/omr-crypto.js)

def b64(b):
    return base64.b64encode(b).decode()


def derive(register, second=""):
    secret = (re.sub(r"\D", "", str(register)) + ":" + re.sub(r"\D", "", str(second))).encode()
    bits = hashlib.pbkdf2_hmac("sha256", secret, SALT, ITER, dklen=48)
    return bits[:16].hex(), bits[16:48]


def seal_json(obj, key):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    iv = secrets.token_bytes(12)
    ct = AESGCM(key).encrypt(iv, json.dumps(obj, ensure_ascii=False).encode(), None)
    return json.dumps({"v": 1, "iv": b64(iv), "ct": b64(ct)})


def open_json(text, key):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    f = json.loads(text)
    return json.loads(AESGCM(key).decrypt(base64.b64decode(f["iv"]), base64.b64decode(f["ct"]), None))


def seal_bytes(key, data):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    iv = secrets.token_bytes(12)
    return iv + AESGCM(key).encrypt(iv, data, None)


def seal_for_admin(pub_b64, obj):
    """Hybrid: a random AES key, wrapped with the admin's RSA-OAEP (SHA-256) public key."""
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding
    pub = serialization.load_der_public_key(base64.b64decode(pub_b64))
    k = secrets.token_bytes(32)
    wrapped = pub.encrypt(k, padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None))
    body = seal_bytes(k, json.dumps(obj, ensure_ascii=False).encode())
    return json.dumps({"v": 1, "k": b64(wrapped), "data": b64(body)})


def publish(rows, cfg, admin_pub, label):
    """Write result files, sheet files and one admin inbox file. Returns the paths written."""
    by_register = cfg.get("results_lookup", "register_booklet") == "register"
    when = dt.date.today().isoformat()
    lists, written, removed, index = {}, [], [], []
    for r in rows:
        rid, key = derive(r["register_number"], "" if by_register else r["booklet_serial"])
        if rid not in lists:
            path = f"published/results/{rid}.json"
            old = []
            if os.path.exists(rel(path)):
                try:
                    with open(rel(path), encoding="utf-8") as f:
                        data = open_json(f.read(), key)
                    old = data.get("results") or [data]
                except Exception:
                    old = []
            lists[rid] = {"path": path, "key": key, "results": old}
        L = lists[rid]
        sk = secrets.token_bytes(32)
        sheet = f"published/sheets/{secrets.token_hex(12)}.bin"
        os.makedirs(rel("published/sheets"), exist_ok=True)
        with open(rel(sheet), "wb") as f:
            f.write(seal_bytes(sk, r["image"]))
        written.append(sheet)
        keep = []
        for e in L["results"]:
            if e.get("subject") == r["subject"] and (by_register or e.get("booklet_serial") == r["booklet_serial"]):
                if e.get("sheet") and os.path.exists(rel(e["sheet"])):
                    removed.append(e["sheet"])
            else:
                keep.append(e)
        g = r["grading"]
        keep.append({"subject": r["subject"], "subject_name": r["subject_name"], "exam": r["exam"],
                     "exam_short": r["exam_short"], "name": r["name"], "version": r["version"],
                     "register_number": r["register_number"], "booklet_serial": r["booklet_serial"],
                     "register_complete": True, "grading": g, "error": None, "marking": r["marking"],
                     "five": r["five"], "published": when, "sheet": sheet, "sheet_key": b64(sk),
                     "centre": r.get("centre", "")})
        L["results"] = keep
        index.append({"reg": r["register_number"], "booklet": r["booklet_serial"], "name": r["name"],
                      "subject": r["subject"], "subject_name": r["subject_name"], "exam": r["exam"],
                      "exam_short": r["exam_short"], "set": r["version"], "score": g["score"],
                      "max": g["max_score"], "counts": g["counts"], "photo": r.get("file", ""),
                      "sheet": sheet, "sheet_key": b64(sk), "published": when,
                      "centre": r.get("centre", ""), "district": r.get("district", ""), "source": "kea"})
    os.makedirs(rel("published/results"), exist_ok=True)
    for L in lists.values():
        with open(rel(L["path"]), "w", encoding="utf-8") as f:
            f.write(seal_json({"v": 2, "results": L["results"]}, L["key"]))
        written.append(L["path"])
    for p in removed:
        os.remove(rel(p))
    inbox = f"admin/inbox/{dt.datetime.now().strftime('%Y%m%d-%H%M%S')}-{secrets.token_hex(4)}.bin"
    os.makedirs(rel("admin/inbox"), exist_ok=True)
    with open(rel(inbox), "w", encoding="utf-8") as f:
        f.write(seal_for_admin(admin_pub, {"label": label, "entries": index}))
    written.append(inbox)
    return written, removed


# ------------------------------------------------------------------ git

def git(*args, check=True):
    return subprocess.run(["git", *args], cwd=ROOT, check=check, capture_output=True, text=True)


def save(message, push=True):
    git("add", "-A", "published", "admin")
    if not git("diff", "--cached", "--quiet", check=False).returncode:
        return
    git("commit", "-m", message)
    if not push:
        return
    for i in range(5):
        if git("push", "origin", "HEAD", check=False).returncode == 0:
            return
        git("pull", "--rebase", "origin", os.environ.get("GITHUB_REF_NAME", "main"), check=False)
        time.sleep(5 * (i + 1))
    raise RuntimeError("Could not push to GitHub.")


# ------------------------------------------------------------------ main walk

def link_ok(url):
    host = urllib.parse.urlparse(url).hostname or ""
    return url.startswith("https://") and bool(ALLOWED_HOST.search(host))


def pending(req, state):
    if not req or req.get("stop"):
        return False
    return not (state and state.get("request") == req.get("id") and state.get("status") in ("done", "captcha"))


def run(args):
    from omr import keys as K
    req = read_json(REQUEST)
    state = read_json(STATE) or {}
    if not pending(req, state):
        log("Nothing to fetch.")
        return 0
    if state.get("request") != req.get("id"):
        state = {"request": req["id"], "done": {}, "failures": [], "totals": {"centres": 0, "sheets": 0, "published": 0, "failed": 0}}
    state.update(status="running", message="Fetching…", started=state.get("started") or now(), updated=now())

    url = req.get("url", "")
    if not link_ok(url):
        state.update(status="error", message="The link must be a https://…karnataka.gov.in page.")
        write_json(STATE, state); save("KEA fetch: bad link", push=not args.no_push)
        return 1
    vault = read_json(VAULT) or {}
    if not vault.get("pub"):
        state.update(status="error", message="Sign in to the admin page once (it sets up the key the fetch needs), then start the fetch again.")
        write_json(STATE, state); save("KEA fetch: waiting for admin key", push=not args.no_push)
        return 1

    cfg = K.load_config()
    exam = next((e for e in cfg["exams"] if e["id"] == req.get("exam")), None)
    if not exam:
        state.update(status="error", message=f"Exam {req.get('exam')} is not on this website.")
        write_json(STATE, state); save("KEA fetch: unknown exam", push=not args.no_push)
        return 1
    if exam.get("omr_layout", "kea_kreis") != "kea_kreis":
        state.update(status="error", message=f"Photo reading is off for {exam['name']}. In the admin page, Exams & subjects, press Turn on next to {exam['name']} (if it uses the KEA OMR sheet), then start the fetch again.")
        write_json(STATE, state); save("KEA fetch: photo reading off", push=not args.no_push)
        return 1
    want_districts = {d.strip().upper() for d in req.get("districts", []) if d.strip()}
    overrides = req.get("subjects") or {}
    deadline = time.time() + args.max_minutes * 60
    http = Polite(delay=args.delay)
    site = KeaSite(url, http)
    tmp = os.path.join(os.environ.get("RUNNER_TEMP", "/tmp"), "kea.pdf")

    def stop(status, message):
        state.update(status=status, message=message, updated=now())
        write_json(STATE, state)
        save(f"KEA fetch: {status}", push=not args.no_push)

    try:
        site.load()
        want = str(req.get("kea_exam", "")).strip().lower()
        ex = [o for o in options(site.page, "ddlExam") if o[0].lower() == want] or \
             [o for o in options(site.page, "ddlExam") if want and want in o[1].lower()]
        if not ex:
            stop("error", "Could not find that exam on the KEA page. Exams listed there: " +
                 "; ".join(f"{v} = {t}" for v, t in options(site.page, "ddlExam")))
            return 1
        kea_exam = ex[0][0]
        state["kea_exam_name"] = ex[0][1]
        site.choose("ddlExam", {"ddlExam": kea_exam})
        districts = [d for d in options(site.page, "ddlDistrict") if not want_districts or d[0].strip().upper() in want_districts]
        state["districts"] = [d[0] for d in districts]
        for dval, dname in districts:
            site.choose("ddlDistrict", {"ddlExam": kea_exam, "ddlDistrict": dval})
            for sval, sname in options(site.page, "ddlSubject"):
                sid = match_subject(sname, exam["id"], cfg, overrides)
                if not sid:
                    note = f"Skipped KEA subject '{sname}': no matching subject in {exam['name']}."
                    if note not in state["failures"]:
                        state["failures"].append(note)
                    continue
                subj, _ = K.find_subject(cfg, sid)
                sc = K.subject_config(cfg, sid)
                missing = [c for c in sc["set_codes"] if K.load_key(sid, c, sc) is None]
                if missing:  # leave these centres for a later run, once the key is added
                    note = f"Waiting for the {subj['name']} answer key (sets {', '.join(missing)}). Add it, and the next run fetches this subject."
                    if note not in state["failures"]:
                        state["failures"].append(note)
                    state["waiting_for_keys"] = True
                    continue
                fields = {"ddlExam": kea_exam, "ddlDistrict": dval, "ddlSubject": sval}
                site.choose("ddlSubject", fields)
                pages = [1] + grid_pages(site.page)
                for pg in pages:
                    if pg > 1:  # the centre list has more than one page
                        r = site.post(fields, "gvStdData", f"Page${pg}")
                        if r.status_code != 200:
                            raise RuntimeError(f"Could not open page {pg} of the centre list (HTTP {r.status_code}).")
                        site.page = r.text
                    for code, cname, button in centres(site.page):
                        key = f"{kea_exam}|{dval}|{sval.strip()}|{code}"
                        if key in state["done"]:
                            continue
                        if time.time() > deadline:
                            stop("paused", "Paused to stay within GitHub's time limit. It carries on automatically in the next run.")
                            return 0
                        log(f"{dname} / {sname.strip()} / centre {code}")
                        state["message"] = f"Working on {dname}, {sname.strip()}, centre {code}."
                        link = site.pdf_url(fields, button)
                        if not link:
                            state["done"][key] = {"sheets": 0, "note": "no file"}
                            continue
                        site.download(link, tmp)
                        rows, failed = [], 0
                        for pno, png, text in pdf_pages(tmp):
                            try:
                                r = score_page(png, sid, cfg, text)
                            except Exception as e:  # noqa: BLE001 - a bad page must not stop the centre
                                r = {"error": str(e)[:80]}
                            if r.get("error"):
                                failed += 1
                                state["failures"].append(f"{dname} centre {code} page {pno}: {r['error']}")
                                continue
                            r.update(subject=sid, subject_name=subj["name"], exam=exam["id"], exam_short=exam.get("short", ""),
                                     centre=f"{code} {cname}"[:120], district=dname, file=f"KEA {code} p{pno}")
                            rows.append(r)
                        if rows:
                            publish(rows, cfg, vault["pub"], f"{exam.get('short', '')} {subj['name']} centre {code}")
                        state["done"][key] = {"sheets": len(rows) + failed, "published": len(rows), "failed": failed, "centre": cname[:80]}
                        t = state["totals"]
                        t["centres"] += 1; t["sheets"] += len(rows) + failed; t["published"] += len(rows); t["failed"] += failed
                        state["failures"] = state["failures"][-300:]
                        state["updated"] = now()
                        write_json(STATE, state)
                        save(f"KEA fetch: {dname} {sname.strip()} centre {code} ({len(rows)} published)", push=not args.no_push)
        if state.pop("waiting_for_keys", False):
            stop("paused", "Fetched everything that has an answer key. Some subjects are waiting for their key (see the problems list). Add the key and press Start fetching again.")
            return 0
        stop("done", f"Finished. {state['totals']['published']} sheets published from {state['totals']['centres']} centres.")
        return 0
    except CaptchaSeen:
        stop("captcha", "KEA asked for a captcha, so the automatic fetch stopped. It will not try to get past it. "
                        "Download the remaining centre PDFs yourself and use Bulk OMR upload.")
        return 0
    except Blocked as e:
        stop("blocked", f"{e} It will try again in the next scheduled run (about 3 hours).")
        return 0
    except Exception as e:  # noqa: BLE001
        stop("error", f"Stopped: {str(e)[:200]} It will try again in the next scheduled run.")
        raise


def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--check", action="store_true", help="exit 0 if there is work to do, 1 if not")
    p.add_argument("--delay", type=float, default=float(os.environ.get("KEA_DELAY", "20")))
    p.add_argument("--max-minutes", type=float, default=float(os.environ.get("KEA_MAX_MINUTES", "300")))
    p.add_argument("--no-push", action="store_true")
    a = p.parse_args()
    if a.check:
        return 0 if pending(read_json(REQUEST), read_json(STATE)) else 1
    return run(a)


if __name__ == "__main__":
    sys.exit(main())
