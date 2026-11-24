"""Build the static GitHub Pages site into _site/.

The pages are the same templates the Flask app serves; the scanner runs in the
visitor's browser (Pyodide), so no server is needed.

    SITE_URL=https://<user>.github.io/<repo> python build_site.py
"""
import glob
import json
import os
import shutil
import sys
from urllib.parse import urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "_site")
os.environ["STATIC_SITE"] = "1"
site_url = os.environ.get("SITE_URL", "").rstrip("/")
prefix = urlparse(site_url).path.rstrip("/") if site_url else ""

sys.path.insert(0, ROOT)
import app as A  # noqa: E402
from omr import keys as K  # noqa: E402

shutil.rmtree(OUT, ignore_errors=True)
os.makedirs(OUT)
client = A.app.test_client()
cfg = K.load_config()


def get(path):
    r = client.get(path, base_url="http://localhost" + prefix + "/")
    assert r.status_code == 200, (path, r.status_code)
    return r.data


pages = {"/": "index.html", "/results": "results.html", "/privacy": "privacy.html", "/sitemap.xml": "sitemap.xml", "/robots.txt": "robots.txt"}
if A.ADMIN_PAGE:   # unlinked admin page
    pages["/" + A.ADMIN_PAGE] = A.ADMIN_PAGE + ".html"
slugs = {e["id"]: e["slug"] for e in cfg.get("exams", [])}
for e in cfg.get("exams", []):
    pages[f"/exams/{e['id']}"] = f"exams/{e['id']}.html"
for s in cfg["subjects"]:
    ex = slugs.get(s.get("exam"), "kreis-2026")
    pages[f"/{ex}/{s['slug']}"] = f"{ex}/{s['slug']}.html"   # Pages serves /x for x.html
# Build the scanner bundle first, so pages can link it with a version that changes with the keys
import hashlib  # noqa: E402
bundle = {}
for rel in ["config.json", "omr/__init__.py", "omr/scanner.py", "omr/keys.py"] + \
        [os.path.relpath(p, ROOT) for p in glob.glob(os.path.join(ROOT, "keys", "*", "*.txt"))]:
    with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
        bundle[rel.replace(os.sep, "/")] = f.read()
bundle_text = json.dumps(bundle, sort_keys=True)
A._asset_versions["omr-bundle.json"] = hashlib.md5(bundle_text.encode()).hexdigest()[:8]

for path, name in pages.items():
    dest = os.path.join(OUT, name)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "wb") as f:
        f.write(get(path))

shutil.copytree(os.path.join(ROOT, "static"), os.path.join(OUT, "static"))
pub = os.path.join(ROOT, "published")
if os.path.isdir(pub):
    shutil.copytree(pub, os.path.join(OUT, "published"))
with open(os.path.join(OUT, "static", "omr-bundle.json"), "w", encoding="utf-8") as f:
    f.write(bundle_text)
open(os.path.join(OUT, ".nojekyll"), "w").close()
with open(os.path.join(OUT, "404.html"), "wb") as f:
    f.write(get("/").replace(b"<h1>", b"<p class=\"err\">That page was not found. You can check your score here.</p><h1>", 1))
print(f"Built {len(pages) + 1} pages into {OUT} (site URL: {site_url or 'relative'})")
