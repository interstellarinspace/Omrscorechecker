"""OMR scanner web app.

Candidates open the home page on their phone, pick their subject, take a photo
of their filled answer sheet and get their score. The exam admin manages the
answer keys at /admin.

Run:  python app.py      (then open http://<this-computer-ip>:5000)
"""
import base64
import csv
import datetime as dt
import os
import secrets

import cv2
from flask import Flask, abort, jsonify, redirect, render_template, request, send_from_directory, session, url_for

from omr import keys as K
from omr import scanner as S

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY") or secrets.token_hex(16)
app.config["MAX_CONTENT_LENGTH"] = 25 * 1024 * 1024

ADMIN_PASSWORD = os.environ.get("OMR_ADMIN_PASSWORD", "admin123")
# Set OMR_SHOW_DETAILS=0 to show candidates only their score, not the key.
SHOW_DETAILS = os.environ.get("OMR_SHOW_DETAILS", "1") != "0"
RESULTS_DIR = os.path.join(K.ROOT, "results")
RESULTS_CSV = os.path.join(RESULTS_DIR, "results.csv")
UPLOAD_DIR = os.path.join(RESULTS_DIR, "uploads")


SITE_URL = os.environ.get("SITE_URL", "").rstrip("/")   # e.g. https://omrscorecheck.in, used for SEO links
PLAY_URL = os.environ.get("PLAY_STORE_URL", "")
APPSTORE_URL = os.environ.get("APP_STORE_URL", "")
# Set by build_site.py: render pages for GitHub Pages, where the scanner runs in the browser.
STATIC_SITE = os.environ.get("STATIC_SITE") == "1"


def cfg():
    return K.load_config()


@app.context_processor
def inject():
    base = SITE_URL or request.url_root.rstrip("/")
    return {"cfg": cfg(), "site_url": base, "play_url": PLAY_URL, "appstore_url": APPSTORE_URL,
            "canonical": base + request.path, "static_site": STATIC_SITE}


def subject_name(c, sid):
    return next((s["name"] for s in c["subjects"] if s["id"] == sid), sid)


def process(image_bytes, subject, name=""):
    c = cfg()
    res = S.scan(image_bytes, c["num_questions"])
    out = {"subject": subject, "subject_name": subject_name(c, subject), "name": name,
           "version": res["version"], "register_number": res["register_number"],
           "register_complete": res["register_complete"], "booklet_serial": res["booklet_serial"],
           "grading": None, "error": None}
    if not res["version"]:
        out["error"] = ("Could not read the Question Booklet Version Code bubbles "
                        f"({res['version_note']}). Please check that one letter and one number are shaded.")
    elif res["version"] not in c["set_codes"]:
        out["error"] = f"Version code {res['version']} is not one of {', '.join(c['set_codes'])}."
    else:
        key = K.load_key(subject, res["version"], c)
        if key is None:
            out["error"] = f"The answer key for {out['subject_name']}, set {res['version']} has not been added yet."
        else:
            out["grading"] = K.grade(res["answers"], key, c)
    out["answers"] = [{"q": a["q"], "answer": a["answer"], "status": a["status"]} for a in res["answers"]]
    img = S.annotate(res, out["grading"])
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 85])
    out["annotated_b64"] = base64.b64encode(buf).decode()
    _log(out, image_bytes)
    return out


def _log(out, image_bytes):
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S-") + secrets.token_hex(3)
    with open(os.path.join(UPLOAD_DIR, stamp + ".jpg"), "wb") as f:
        f.write(image_bytes)
    new = not os.path.exists(RESULTS_CSV)
    g = out["grading"] or {}
    cnt = g.get("counts", {})
    with open(RESULTS_CSV, "a", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        if new:
            w.writerow(["time", "upload", "name", "subject", "register_number", "booklet_serial", "set",
                        "score", "max_score", "correct", "wrong", "skipped", "blank", "multiple",
                        "error", "answers"])
        w.writerow([dt.datetime.now().isoformat(timespec="seconds"), stamp, out["name"], out["subject"],
                    out["register_number"], out["booklet_serial"], out["version"] or "",
                    g.get("score", ""), g.get("max_score", ""), cnt.get("correct", ""), cnt.get("wrong", ""),
                    cnt.get("skipped", ""), cnt.get("blank", ""), cnt.get("multiple", ""), out["error"] or "",
                    "".join(a["answer"] or "-" for a in out["answers"])])


@app.route("/", methods=["GET", "POST"])
def index():
    c = cfg()
    if request.method == "GET":
        return render_template("index.html", cfg=c)
    subject = request.form.get("subject", "")
    if subject not in [s["id"] for s in c["subjects"]]:
        return render_template("index.html", cfg=c, error="Please choose your subject.")
    f = request.files.get("sheet")
    if not f or not f.filename:
        return render_template("index.html", cfg=c, error="Please choose a photo of your answer sheet.",
                               subject=subject)
    try:
        out = process(f.read(), subject, request.form.get("name", "").strip()[:80])
    except S.ScanError as e:
        return render_template("index.html", cfg=c, error=str(e), subject=subject)
    return render_template("result.html", r=out, cfg=c, show_details=SHOW_DETAILS)


@app.after_request
def cors(resp):
    # The phone app calls /api/* from its own origin (capacitor://localhost, https://localhost)
    if request.path.startswith("/api/"):
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return resp


@app.route("/api/config")
def api_config():
    c = cfg()
    return jsonify(exam_title=c.get("exam_title", ""), subjects=c["subjects"], marking=c["marking"],
                   not_attempted_option=c.get("not_attempted_option"), show_details=SHOW_DETAILS)


@app.route("/api/scan", methods=["POST", "OPTIONS"])
def api_scan():
    if request.method == "OPTIONS":
        return "", 204
    c = cfg()
    f = request.files.get("sheet")
    subject = request.form.get("subject", "")
    if not f or subject not in [s["id"] for s in c["subjects"]]:
        return jsonify(error="Please choose your subject and a photo of your answer sheet."), 400
    try:
        out = process(f.read(), subject, request.form.get("name", "")[:80])
    except S.ScanError as e:
        return jsonify(error=str(e)), 422
    if not SHOW_DETAILS:
        out.pop("annotated_b64")
        if out["grading"]:
            out["grading"].pop("questions")
    return jsonify(out)


@app.route("/kreis-2026/<subject>")
def answer_key(subject):
    c = cfg()
    subj = next((s for s in c["subjects"] if s["slug"] == subject), None)
    if not subj:
        abort(404)
    keys = {code: (K.load_key(subj["id"], code, c) or {}) for code in c["set_codes"]}
    return render_template("answer_key.html", subj=subj, keys=keys)



@app.route("/robots.txt")
def robots():
    base = SITE_URL or request.url_root.rstrip("/")
    body = f"User-agent: *\nDisallow: /admin\nDisallow: /api/\nAllow: /\n\nSitemap: {base}/sitemap.xml\n"
    return app.response_class(body, mimetype="text/plain")


@app.route("/sitemap.xml")
def sitemap():
    c = cfg()
    base = SITE_URL or request.url_root.rstrip("/")
    paths = ["/"] + [f"/kreis-2026/{s['slug']}" for s in c["subjects"]] + ["/privacy"]
    today = dt.date.today().isoformat()
    urls = "".join(f"<url><loc>{base}{p}</loc><lastmod>{today}</lastmod></url>" for p in paths)
    xml = f'<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">{urls}</urlset>'
    return app.response_class(xml, mimetype="application/xml")


@app.route("/app/")
@app.route("/app/<path:path>")
def mobile_web(path="index.html"):
    """The phone app's screens, also usable in a browser (handy for testing)."""
    return send_from_directory(os.path.join(K.ROOT, "mobile", "www"), path)


@app.route("/health")
def health():
    return "ok"


@app.route("/privacy")
def privacy():
    return render_template("privacy.html", cfg=cfg())


@app.route("/admin", methods=["GET", "POST"])
def admin():
    c = cfg()
    if not session.get("admin"):
        if request.method == "POST" and secrets.compare_digest(request.form.get("password", ""), ADMIN_PASSWORD):
            session["admin"] = True
            return redirect(url_for("admin"))
        return render_template("login.html", bad=request.method == "POST")
    msg, err = None, None
    subjects = [s["id"] for s in c["subjects"]]
    if request.method == "POST":
        subject = request.form.get("subject")
        if subject not in subjects:
            abort(400)
        try:
            if request.form.get("table") is not None:
                table = K.parse_table(request.form["table"], c["set_codes"], c["options"], c["num_questions"])
                for s, k in table.items():
                    if k:  # merge into the saved key so a partial paste only changes those rows
                        merged = K.load_key(subject, s, c) or {}
                        merged.update(k)
                        K.save_key(subject, s, K.key_to_text(merged), c)
                msg = f"Saved {subject_name(c, subject)}: " + ", ".join(
                    f"{s} ({len(k)} answers)" for s, k in table.items() if k)
            else:
                code = request.form.get("set_code")
                if code not in c["set_codes"]:
                    abort(400)
                k = K.save_key(subject, code, request.form.get("key", ""), c)
                msg = f"Saved {subject_name(c, subject)}, set {code} ({len(k)} answers)."
        except ValueError as e:
            err = str(e)
    keys_text, counts = {}, {}
    for s in subjects:
        for code in c["set_codes"]:
            p = K.key_path(s, code)
            text = open(p, encoding="utf-8").read() if os.path.exists(p) else ""
            keys_text[(s, code)] = text
            try:
                counts[(s, code)] = len(K.parse_key(text, c["options"], c["num_questions"]))
            except ValueError:
                counts[(s, code)] = "error"
    rows = []
    if os.path.exists(RESULTS_CSV):
        with open(RESULTS_CSV, encoding="utf-8") as f:
            rows = list(csv.DictReader(f))[-200:][::-1]
    return render_template("admin.html", cfg=c, keys=keys_text, counts=counts, msg=msg, err=err, rows=rows)


@app.route("/admin/results.csv")
def results_csv():
    if not session.get("admin"):
        return redirect(url_for("admin"))
    if not os.path.exists(RESULTS_CSV):
        abort(404)
    return send_from_directory(RESULTS_DIR, "results.csv", as_attachment=True)


@app.route("/admin/logout")
def logout():
    session.clear()
    return redirect(url_for("index"))


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))
