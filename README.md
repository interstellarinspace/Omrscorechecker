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

## Admin page on the website (/manage)

The GitHub Pages site has its own admin page at `/manage` (linked as "Admin" in the footer). It saves everything as commits to this repository, and the site republishes itself 1 to 2 minutes later.

- **Connect:** create a fine-grained GitHub token (github.com › Settings › Developer settings › Fine-grained tokens) with access to only this repository and *Contents: Read and write*. Paste it on the admin page. It is kept in the browser only.
- **Answer keys:** paste a whole table (`Q A1 B1 C1 D1`, rows you leave out keep their saved answer) or one set's key. Saved to `keys/<subject>/<set>.txt`.
- **Subjects:** add a new paper that uses the same OMR sheet. Saved to `config.json`. It gets its own answer-key page, tab and dropdown entry.
- **Bulk scan & publish:** pick a subject and select many sheet photos. They are read in the browser (not uploaded). Check or correct the register and booklet numbers, add names if you want, download a CSV, and publish.

Published results live in `published/results/`. Each file is encrypted (AES-GCM) with a key derived (PBKDF2, 150,000 rounds) from the candidate's register number plus booklet number, and its file name comes from the same derivation. There is no list of results. A candidate opens `/results`, types both numbers, and sees their marks, score card PDF and share buttons.
