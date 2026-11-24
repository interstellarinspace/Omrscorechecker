"""Run tools/kea_fetch.py against a small fake KEA site (no requests go to KEA)."""
import base64
import http.server
import json
import os
import shutil
import sys
import tempfile
import threading
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tools"))
import kea_fetch as KF  # noqa: E402

SUBJ = "General Knowledge (PAPER -1) - RPC\r\n"
HITS = {"pdf": 0, "total": 0}
MODE = {"captcha_at": None}


def page(exam="", district="", subject="", centres=None, pager=False, captcha=False):
    opt = lambda vals, sel: "".join(f'<option{" selected=\"selected\"" if v == sel else ""} value="{v}">{v}</option>\r\n' for v in vals)
    rows = "".join(f'<tr><td>{c}</td><td>CENTRE {c} ROAD</td><td><input type="submit" name="gvStdData$ctl0{i + 2}$btnView" value="View" id="b{i}" /></td></tr>'
                   for i, c in enumerate(centres or []))
    pg = "<tr><td><a href=\"javascript:__doPostBack(&#39;gvStdData&#39;,&#39;Page$2&#39;)\">2</a></td></tr>" if pager else ""
    cap = '<img src="CaptchaImage.aspx" /><input name="txtCaptcha" />' if captcha else ""
    return f"""<html><body><script src="newjs/Captcha.js"></script><form method="post" action="./kries.aspx">
<input type="hidden" name="__EVENTTARGET" id="__EVENTTARGET" value="" />
<input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="vs-{exam}-{district}" />
<input type="hidden" name="__EVENTVALIDATION" id="__EVENTVALIDATION" value="ev" />
<select name="ddlExam" id="ddlExam"><option value="-1">SELECT EXAM</option>{opt(["KREISREC26", "KSET26"], exam)}</select>
<select name="ddlDistrict" id="ddlDistrict">{'<option value="-1">SELECT DISTRICT</option>' + opt(["BALLARI", "MYSORE"], district) if exam else ""}</select>
<select name="ddlSubject" id="ddlSubject">{'<option value="-1">SELECT SUBJECT</option><option value="' + SUBJ + '">' + SUBJ + '</option><option value="Hindi (PAPER -2)">Hindi (PAPER -2)</option>' if district else ""}</select>
{cap}<table id="gvStdData">{"<tr><th>Center Code</th><th>Center Name</th><th>Action</th></tr>" + rows + pg if centres is not None else "<tr><td>NO DATA</td></tr>"}</table></form></body></html>"""


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body, ctype="text/html; charset=utf-8", extra=None):
        b = body if isinstance(body, bytes) else body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        HITS["total"] += 1
        if self.path.startswith("/keaomrs/DownloadPdf.ashx"):
            HITS["pdf"] += 1
            if HITS["pdf"] == 1:
                return self.send(429, "The custom error module does not recognize this error.")
            with open(PDF, "rb") as f:
                return self.send(200, f.read(), "application/pdf")
        self.send(200, page())

    def do_POST(self):
        HITS["total"] += 1
        f = urllib.parse.parse_qs(self.rfile.read(int(self.headers["Content-Length"])).decode(), keep_blank_values=True)
        g = lambda k: f.get(k, [""])[0]
        t, ex, d, s = g("__EVENTTARGET"), g("ddlExam"), g("ddlDistrict"), g("ddlSubject")
        if g("__VIEWSTATE") == "":
            return self.send(500, "no viewstate")
        btn = [k for k in f if k.endswith("$btnView")]
        if btn:
            if MODE["captcha_at"] and HITS["pdf"] >= MODE["captcha_at"]:
                return self.send(200, page(ex, d, s, [], captcha=True))
            code = {"BALLARI": "35", "MYSORE": "50"}[d] + btn[0][13]
            return self.send(302, "moved", extra={"Location": f"/keaomrs/DownloadPdf.ashx?fileId=files%2f{ex}%2fP1-{code}.pdf"})
        if t == "ddlExam":
            return self.send(200, page(ex))
        if t == "ddlDistrict":
            return self.send(200, page(ex, d))
        if t == "ddlSubject":
            if s != SUBJ:
                return self.send(200, page(ex, d, s, []))
            return self.send(200, page(ex, d, s, ["2", "3"], pager=(d == "BALLARI")))
        if t == "gvStdData" and g("__EVENTARGUMENT") == "Page$2":
            return self.send(200, page(ex, d, s, ["4"]))
        self.send(400, "?")


def make_pdf(path):
    import fitz
    doc = fitz.open()
    for name in ["general_knowledge_C1.jpg", "general_knowledge_C1.jpg"]:
        img = fitz.open(os.path.join(HERE, "photos", name))
        rect = img[0].rect
        pdfbytes = img.convert_to_pdf()
        doc.insert_pdf(fitz.open("pdf", pdfbytes))
    blank = doc.new_page()
    blank.insert_text((72, 72), "not an OMR sheet")
    doc.save(path)


def setup_repo(tmp):
    for d in ["omr", "keys", "tools"]:
        shutil.copytree(os.path.join(ROOT, d), os.path.join(tmp, d), ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copy(os.path.join(ROOT, "config.json"), tmp)
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pub = key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    os.makedirs(os.path.join(tmp, "admin"))
    json.dump({"v": 1, "salt": "x", "check": "y", "pub": base64.b64encode(pub).decode(), "priv": "sealed"}, open(os.path.join(tmp, "admin/vault.json"), "w"))
    return key


def open_inbox(key, path):
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    f = json.load(open(path))
    k = key.decrypt(base64.b64decode(f["k"]), padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None))
    d = base64.b64decode(f["data"])
    return json.loads(AESGCM(k).decrypt(d[:12], d[12:], None))


class Args:
    delay, max_minutes, no_push, check = 0.0, 30, True, False


def run_case(captcha_at=None):
    global PDF
    tmp = tempfile.mkdtemp()
    PDF = os.path.join(tmp, "centre.pdf")
    make_pdf(PDF)
    key = setup_repo(tmp)
    os.system(f"cd {tmp} && git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init")
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{srv.server_port}/keaomrs/kries.aspx"
    json.dump({"id": "r1", "url": url, "exam": "kreis", "kea_exam": "KREISREC26", "districts": []}, open(os.path.join(tmp, "admin/kea-request.json"), "w"))
    HITS.update(pdf=0, total=0)
    MODE["captcha_at"] = captcha_at
    KF.ROOT, KF.WAITS = tmp, (0.2, 0.2, 0.2, 0.2)
    KF.link_ok = lambda u: True
    os.environ["RUNNER_TEMP"] = tmp
    os.chdir(tmp)
    KF.run(Args())
    srv.shutdown()
    return tmp, key


def test_full_fetch():
    tmp, key = run_case()
    st = json.load(open(os.path.join(tmp, KF.STATE)))
    print(json.dumps({k: st[k] for k in ("status", "message", "totals")}, indent=1))
    assert st["status"] == "done", st
    assert st["totals"]["centres"] == 5            # Ballari 2 + page 2 (1) + Mysore 2
    assert st["totals"]["published"] == 10 and st["totals"]["failed"] == 5
    assert any("Hindi" in f for f in st["failures"])
    inbox = sorted(os.listdir(os.path.join(tmp, "admin/inbox")))
    assert len(inbox) == 5
    entries = [e for p in inbox for e in open_inbox(key, os.path.join(tmp, "admin/inbox", p))["entries"]]
    e = entries[-1]
    assert e["subject"] == "general_knowledge" and e["centre"] == "3 CENTRE 3 ROAD" and e["district"] == "MYSORE"
    rid, k = KF.derive(e["reg"])
    res = KF.open_json(open(os.path.join(tmp, f"published/results/{rid}.json")).read(), k)
    assert len(res["results"]) == 1 and res["results"][0]["grading"]["score"] == e["score"]
    sheets = os.listdir(os.path.join(tmp, "published/sheets"))
    assert len(sheets) == 1, sheets                  # same candidate re-published: old sheet files removed
    print("score", e["score"], "reg", e["reg"], "requests", HITS["total"])
    # a second run has nothing left to do
    assert not KF.pending(json.load(open(os.path.join(tmp, KF.REQUEST))), st)


def test_captcha_stops():
    tmp, _ = run_case(captcha_at=3)
    st = json.load(open(os.path.join(tmp, KF.STATE)))
    assert st["status"] == "captcha", st
    assert 1 <= st["totals"]["centres"] < 5
    print("captcha stop after", st["totals"]["centres"], "centres")


if __name__ == "__main__":
    test_full_fetch()
    test_captcha_stops()
    print("ok")
