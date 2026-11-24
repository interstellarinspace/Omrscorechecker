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
