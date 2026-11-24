// Runs the same Python scanner (omr/scanner.py, omr/keys.py) inside the browser
// with Pyodide, so the GitHub Pages site needs no server and photos never leave the phone.
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var form = $("scan-form");
  if (!form) return;
  var ready = null;
  var GLUE = [
    "import sys, json, base64, cv2",
    "sys.path.insert(0, '/omr-app')",
    "from omr import scanner as S, keys as K",
    "def omr_run(data, subject, name):",
    "    c = K.load_config()",
    "    names = {s['id']: s['name'] for s in c['subjects']}",
    "    try:",
    "        res = S.scan(bytes(data), c['num_questions'])",
    "    except S.ScanError as e:",
    "        return json.dumps({'scan_error': str(e)})",
    "    out = {'subject_name': names.get(subject, subject), 'name': name, 'version': res['version'],",
    "           'register_number': res['register_number'], 'booklet_serial': res['booklet_serial'],",
    "           'register_complete': res['register_complete'], 'grading': None, 'error': None}",
    "    if not res['version']:",
    "        out['error'] = 'Could not read the Question Booklet Version Code bubbles (' + str(res['version_note']) + '). Please check that one letter and one number are shaded.'",
    "    elif res['version'] not in c['set_codes']:",
    "        out['error'] = 'Version code ' + res['version'] + ' is not one of ' + ', '.join(c['set_codes']) + '.'",
    "    else:",
    "        key = K.load_key(subject, res['version'], c)",
    "        if key is None:",
    "            out['error'] = 'The answer key for this subject and set ' + res['version'] + ' has not been added yet.'",
    "        else:",
    "            out['grading'] = K.grade(res['answers'], key, c)",
    "    img = S.annotate(res, out['grading'])",
    "    ok, buf = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, 85])",
    "    out['annotated_b64'] = base64.b64encode(buf.tobytes()).decode()",
    "    out['marking'] = c['marking']",
    "    out['five'] = c.get('not_attempted_option', '5')",
    "    return json.dumps(out)"
  ].join("\n");

  function load() {
    if (ready) return ready;
    ready = (async function () {
      var py = await loadPyodide();
      var bundle = await (await fetch(window.OMR_BUNDLE)).json();
      Object.keys(bundle).forEach(function (path) {
        var full = "/omr-app/" + path;
        var dir = full.substring(0, full.lastIndexOf("/"));
        py.FS.mkdirTree(dir);
        py.FS.writeFile(full, bundle[path]);
      });
      await py.loadPackage(["numpy", "opencv-python"]);
      py.runPython(GLUE);
      return py;
    })();
    ready.catch(function () { ready = null; });
    return ready;
  }

  // Start downloading the scanner as soon as the candidate picks a photo or subject.
  ["sheet", "subject"].forEach(function (id) { $(id).addEventListener("change", function () { load(); }); });

  function fmt(x) { return (Math.round(x * 100) / 100).toString(); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function show(el, on) { el.hidden = !on; }
  function busy(on, text) {
    var b = $("busy"); b.style.display = on ? "block" : "none"; if (text) b.textContent = text;
    form.querySelector("button[type=submit]").disabled = on;
  }
  function formError(msg) {
    var e = form.parentNode.querySelector(".err.form-err");
    if (!e) { e = document.createElement("div"); e.className = "err form-err"; form.parentNode.insertBefore(e, form); }
    e.textContent = msg; show(e, !!msg); if (msg) e.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  form.addEventListener("submit", async function (ev) {
    ev.preventDefault();
    var file = $("sheet").files[0], subject = $("subject").value;
    if (!subject) { formError("Please choose your subject."); return; }
    if (!file) { formError("Please choose a photo of your answer sheet."); return; }
    formError("");
    try {
      busy(true, ready ? "Reading your sheet…" : "Downloading the scanner (first time only)…");
      var py = await load();
      busy(true, "Reading your sheet…");
      await new Promise(function (r) { setTimeout(r, 30); });
      var data = new Uint8Array(await file.arrayBuffer());
      var fn = py.globals.get("omr_run");
      var out = JSON.parse(fn(py.toPy(data), subject, $("name").value.trim()));
      fn.destroy();
      if (out.scan_error) { formError(out.scan_error); return; }
      render(out);
    } catch (e) {
      console.error(e);
      formError("Something went wrong while reading the sheet. Check your internet connection for the first download, then try again.");
    } finally {
      busy(false, "Reading your sheet…");
    }
  });

  function render(r) {
    var g = r.grading, m = r.marking, five = r.five;
    $("res-meta").innerHTML = esc(r.subject_name) + (r.name ? " · " + esc(r.name) : "") + "<br>Version <b>" + esc(r.version || "?") +
      "</b> · Register no. <b>" + esc(r.register_number) + "</b> · Booklet <b>" + esc(r.booklet_serial) + "</b>";
    $("res-error").textContent = r.error || ""; show($("res-error"), !!r.error);
    show($("res-score"), !!g); show($("res-stats"), !!g); show($("res-marking"), !!g);
    if (g) {
      $("res-score").textContent = fmt(g.score) + " / " + fmt(g.max_score);
      var c = g.counts;
      $("res-stats").innerHTML = '<div><b class="r-correct">' + c.correct + '</b>Correct</div><div><b class="r-wrong">' + c.wrong +
        "</b>Wrong</div><div><b>" + c.skipped + "</b>Option " + esc(five) + "</div><div><b>" + c.blank + '</b>Blank</div><div><b class="r-multiple">' +
        c.multiple + "</b>Multiple</div>";
      $("res-marking").textContent = "Marking: +" + fmt(m.correct) + " correct, " + fmt(m.wrong) + " wrong, " + fmt(m.skipped) + " for option " + five +
        " (not attempted), " + fmt(m.blank) + " for no bubble shaded, " + fmt(m.multiple) + " for more than one shaded.";
    }
    $("res-image").src = "data:image/jpeg;base64," + r.annotated_b64;
    var rows = g ? g.questions.filter(function (q) { return q.result !== "no_key"; }) : [];
    $("res-table").innerHTML = "<tr><th>Q</th><th>Yours</th><th>Key</th><th>Result</th><th>Marks</th></tr>" + rows.map(function (q) {
      var given = q.given === "*" ? "multiple" : (q.given || "–");
      return "<tr><td>" + q.q + "</td><td>" + esc(given) + "</td><td>" + esc(q.key || "dropped") + '</td><td class="r-' + q.result + '">' +
        esc(q.result === "skipped" ? "not attempted" : q.result) + "</td><td>" + fmt(q.marks) + "</td></tr>";
    }).join("");
    show(form, false); show($("result"), true); $("result").scrollIntoView();
  }

  $("again").addEventListener("click", function () {
    show($("result"), false); show(form, true); $("sheet").value = "";
    var p = $("pick"); p.textContent = "Tap to take a photo or choose one from your gallery";
    form.scrollIntoView();
  });
})();
