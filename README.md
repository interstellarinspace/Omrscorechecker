# OMR Scanner (KEA / KREIS answer sheet)

Candidates photograph their filled OMR sheet on their phone, choose their
subject, and get their score straight away. The app reads the Question
Booklet Version Code (A1 / B1 / C1 / D1), the Register Number, the Question
Booklet Serial No. and all 100 answers, then scores them against that
subject's key for that version.

## Run it

```bash
pip install -r requirements.txt
OMR_ADMIN_PASSWORD=choose-a-password python app.py
```

Open `http://<computer-ip>:5000` on a phone on the same Wi-Fi. For candidates
to use it from anywhere, host it on any Python host (Render, Railway,
PythonAnywhere, a VPS) and share the link.

| Page | Who | What |
|---|---|---|
| `/` | Candidates | Choose subject, upload photo, see score and the marked sheet |
| `/admin` | You | Answer keys, recent uploads, download results CSV |
| `/api/scan` | Scripts | POST `sheet` (image) and `subject`, get JSON back |

## Answer keys

Already loaded from the KEA key PDF of 22.11.2026: Paper I General Knowledge,
Paper II Kannada and Paper II Science, sets A1, B1, C1, D1. They are stored in
`keys/<subject>/<set>.txt` and a full table is in `answer_keys.csv`.

To change them, log in at `/admin` and paste rows of `Q A1 B1 C1 D1`
(e.g. `17 1 1 2 3`). A partial paste only changes the rows you paste. Use `23`
when both 2 and 3 are accepted, and `X` to drop a question (everyone gets the mark).

## Marking (`config.json`)

| Case | Marks |
|---|---|
| Correct | +1 |
| Wrong | -0.25 |
| Option 5 shaded (not attempted) | 0 |
| No bubble shaded | -0.25 (the sheet says to shade 5 if you don't know) |
| More than one bubble shaded | -0.25 |

Edit `marking` in `config.json` to change any of these. Add a subject by adding
it to `subjects` and creating its keys at `/admin`.

## How the reading works

- The sheet has a column of short blue dashes down each side, one per row. The
  scanner finds both columns, numbers the dashes, and uses them to locate every
  bubble row, even if the paper is tilted, bent, sideways or upside down.
- Each bubble grid is then fine-tuned to the printed circles found in the photo.
- A bubble counts as shaded when its inside is clearly darker and bluer than the
  paper around it. The printed digit inside each bubble is measured and subtracted.
  A much fainter stray mark next to a real one is ignored; two similar marks
  count as "multiple".

## Tests

`python tests/test_real_sheets.py` reads two real phone photos (hand-checked,
answer by answer) plus 22 altered versions of them (rotated, tilted, rescaled,
darker, low quality, at an angle). All 24 read with no errors.

## Files

- `omr/scanner.py`: sheet location and bubble reading
- `omr/keys.py`: answer keys and scoring
- `app.py`, `templates/`: the web app
- `results/`: every upload (photo + a row in `results.csv`)

## Phone app (Android and iOS)

`mobile/` is a Capacitor app: native camera/gallery capture, subject choice and
the result screen. It sends the photo to this server's `/api/scan`, so set the
server address in `mobile/www/config.js` (GitHub builds set it from the
`OMR_API_BASE` repository variable).

```bash
cd mobile && npm ci && npx cap sync
npx cap open android   # Android Studio
npx cap open ios       # Xcode (Mac only)
```

`.github/workflows/build.yml` runs the scanner tests, builds an Android APK
(and a signed Play Store `.aab` when the keystore secrets are set) and checks
the iOS app compiles. The same screens also work in a browser at `/app/`.

## Website search

Pages: `/` (score checker + FAQ), `/kreis-2026/<subject>-answer-key`,
`/privacy`, plus `sitemap.xml` and `robots.txt`. Set `SITE_URL` to your domain,
and `PLAY_STORE_URL` / `APP_STORE_URL` once the apps are live.

## Website on GitHub Pages (no server)

`build_site.py` renders the same pages as static files into `_site/`, and the
scanner runs in the visitor's browser with Pyodide (Python + OpenCV compiled
for the web), so photos never leave the phone. `.github/workflows/pages.yml`
publishes it on every push to `main` once Settings > Pages > Source is set to
"GitHub Actions". The site is then at
`https://<user>.github.io/<repo>/`. Results are not collected centrally on
this version; use the hosted server (`app.py`) if you need the admin page.

## Admin page on the website (private address)

The GitHub Pages site has an admin page at an address that is not linked anywhere, not in the sitemap and marked noindex. The address is in `admin_page_path.txt`. To keep the address out of this public code as well, add a GitHub Actions secret `ADMIN_PAGE_PATH` with a new value (letters, digits, - or _, 8+ characters); the site then uses that address instead.

The address is only a convenience. The real protection is:
- **GitHub token** (fine-grained, this repository only, *Contents: Read and write*): needed to change anything.
- **Admin passphrase** (set on first sign-in): the admin's list of all published sheets (`admin/index.bin`) is encrypted with it (AES-GCM, PBKDF2 310,000 rounds). It cannot be recovered if lost.

Tabs:
- **Bulk OMR upload:** pick a subject, select many sheet photos (read in the browser), check or fix register and booklet numbers and names, download a CSV, and publish. Publishing saves each candidate's encrypted result for the public Results page and each marked OMR sheet, encrypted, for the admin.
- **Search by register no.:** find a candidate by register number (or part of it), booklet number or name, and see their marks and attached OMR sheet.
- **Answer keys** and **Subjects:** as before; saved to `keys/` and `config.json`.

Published results live in `published/results/`, one file per candidate holding all their published papers. Each file is encrypted with a key derived (PBKDF2, 150,000 rounds) from the lookup numbers, and its file name comes from the same derivation, so there is no public list. `results_lookup` in `config.json` sets the lookup numbers: `"register"` (register number only, the current setting) or `"register_booklet"` (register number plus booklet number, harder for others to guess). Changing it needs the results to be published again.

Each marked OMR sheet is stored once in `published/sheets/`, encrypted with its own random key. That key is inside the candidate's result file and the admin's encrypted list, so the candidate (from the Results page, "View my OMR sheet") and the admin (Search by register no.) can both open it.


### Fetch from a KEA link, merit list, key files

* **Fetch from KEA link** (admin tab): paste the KEA "View OMR Records" link and pick the exam. This saves
  `admin/kea-request.json`, which starts `.github/workflows/kea-fetch.yml` (`tools/kea_fetch.py`). It walks
  exam > district > subject > centres, downloads each centre's PDF, scores every page and publishes it the
  same way as bulk upload. It is slow on purpose (one request about every 20 s), backs off on HTTP 429,
  stops on a captcha, saves progress after every centre (`admin/kea-state.json`) and resumes every 3 hours.
  New sheets reach the admin list through `admin/inbox/` (encrypted to the admin's public key, which the
  admin page creates in `admin/vault.json` at sign-in).
* **Merit list** (admin tab): Paper I + Paper II per register number, topper first, download as Excel.
* **Answer keys**: upload the key as PDF, Excel or CSV, check the preview, then save. Exams & subjects has
  an Add / upload key button next to every subject.

### Candidate names, unshaded set codes and carrying on

- `omr/names.py` reads the handwritten name from the boxes at the top of a KEA sheet: it finds
  the box row by its orange lines, cuts out each box and reads the letter with a small network
  (trained on EMNIST letters plus letters from KEA sheets; weights in `omr/name_model.txt`,
  run with plain numpy so it also works in the browser). Handwriting varies, so a name the
  reader is not sure of is marked for the admin to check. Names that cannot be found stay blank.
- When the version code is not shaded, `keys.guess_set` scores the answers against every set's
  key and uses a set only when it is clearly ahead. Otherwise the admin picks the set in the
  bulk table's Set column.
- A bulk scan that stops (connection lost, scanner problem) keeps the sheets already read; press
  Continue to carry on. A KEA fetch keeps the centres already done; "Continue from where it
  stopped" carries on the same fetch, "Start a new fetch" begins again.
- Every centre the fetch reads records the reader's fingerprint (`reader_version`: omr/ and
  tools/kea_fetch.py). Pushing a changed reader starts the fetch workflow; centres with problem
  sheets from an older reader are read again by themselves (once per reader), their old
  problems leave the list, and a run in progress stops before its next centre so the new run
  carries on with the new reader. Sheets that still cannot be read wait in admin/review/ for
  "Fix the sheets that need a look".

## Exams, papers and subjects

`config.json` has an `exams` list (KREIS, KAS, FDA, SDA, Warder) and each subject names its `exam` and `paper`. Every exam has a tab and a page (`/exams/<id>`), and each subject has an answer-key page that shows "Key coming soon" until a key is added. An exam can override `num_questions`, `options`, `set_codes`, `marking` and `not_attempted_option`. Photo checking works for exams with `"omr_layout": "kea_kreis"` (the KEA sheet). Other exams need their sheet layout added from a sample photo; until then their sheets can be added in the admin page's **Add one sheet** tab by typing the answers.

Admin tabs: **Bulk OMR upload** (many photos at once, for exams whose sheet the site can read), **Add one sheet** (any exam and subject: type the answers or read them from a photo, optional photo attached), **Search by register no.**, **Answer keys**, **Exams & subjects** (add exams and subjects; remove a subject that has no key yet).
