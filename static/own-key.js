// "Use my own answer key" on the home page: the student adds any answer key (typed, pasted, or
// read from a photo or PDF of the key table), sets the marking scheme, then adds their OMR
// sheet (or types their answers) and gets their marks. All of it runs in the browser.
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var form = $("own-form");
  if (!form) return;
  var E = window.OMREngine, parsed = null, keyPages = [], STORE = "omr-own-v1";

  // The page loads the calculator straight away, so it is ready when the student is.
  E.load().catch(function () {});

  function error(msg) {
    var e = form.parentNode.querySelector(".err.form-err");
    if (!e) { e = document.createElement("div"); e.className = "err form-err"; form.parentNode.insertBefore(e, form); }
    e.textContent = msg; e.hidden = !msg; if (msg) e.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  function busy(on, text) {
    $("own-busy").hidden = !on; if (text) $("own-busy").textContent = text;
    form.querySelector("button[type=submit]").disabled = on;
  }
  function num(id, dflt) { var v = parseFloat($(id).value); return isFinite(v) ? v : dflt; }
  function fmt(x) { return (Math.round(x * 100) / 100).toString(); }
  function nq() { return Math.max(1, Math.min(100, Math.round(num("own-n", 100)))); }

  // ---------- the key ----------
  var timer = null;
  async function parseKey() {
    var text = $("own-key").value;
    if (!text.trim()) { parsed = null; $("own-keyinfo").className = "muted small"; $("own-keyinfo").textContent = "Upload the answer key as a photo or PDF of the key table (one column per set, like KEA's key)."; sets(); summary(); return; }
    if (!E.isLoaded()) $("own-keyinfo").textContent = "Getting the calculator ready (first time only)…";
    var r = await E.call("omr_custom_key", text, nq());
    var info = $("own-keyinfo");
    if (r.error) { parsed = null; info.className = "bad small"; info.textContent = r.error; }
    else {
      parsed = r;
      var n = Object.keys(r.keys[r.sets[0]]).length;
      info.className = "ok small";
      info.textContent = "Key read: " + n + " answers" + (r.sets.length > 1 ? " in " + r.sets.length + " sets (" + r.sets.join(", ") + ")" : "") + ".";
      if (n > nq()) { $("own-n").value = n; }
    }
    sets(); summary(); save();
  }
  function keyChanged() { clearTimeout(timer); timer = setTimeout(function () { parseKey().catch(console.error); }, 400); }

  function sets() {
    var many = parsed && parsed.sets.length > 1, sel = $("own-set"), was = sel.value;
    $("own-set-wrap").hidden = !many;
    if (!many) return;
    sel.innerHTML = '<option value="">Read it from my OMR sheet</option>' + parsed.sets.map(function (s) { return "<option>" + s + "</option>"; }).join("");
    if (parsed.sets.indexOf(was) >= 0) sel.value = was;
  }

  $("own-keyfile").addEventListener("change", async function () {
    var f = this.files[0]; if (!f) return;
    $("own-keypick").innerHTML = '<span class="cam" aria-hidden="true">🗝️</span>'; $("own-keypick").appendChild(document.createTextNode(f.name));
    error("");
    try {
      $("own-keyinfo").className = "muted small"; $("own-keyinfo").textContent = E.isLoaded() ? "Reading the key…" : "Getting the key reader ready (first time only)…";
      await E.load();
      var imgs = window.OMRPdf.isPdf(f) ? await window.OMRPdf.pages(f) : [{ page: 1, bytes: async function () { return new Uint8Array(await f.arrayBuffer()); } }];
      keyPages = [];
      for (var i = 0; i < imgs.length && i < 30; i++) {
        $("own-keyinfo").textContent = "Reading the key" + (imgs.length > 1 ? " (page " + (i + 1) + " of " + imgs.length + ")" : "") + "…";
        var r = await E.call("omr_custom_key_page", await imgs[i].bytes());
        if (!r.error) keyPages.push({ page: imgs[i].page, text: r.text, unsure: r.unsure, rows: r.rows });
      }
      if (!keyPages.length) { $("own-keyinfo").className = "bad small"; $("own-keyinfo").textContent = "Could not find an answer key table in this file. Try a clearer photo or the key PDF."; return; }
      $("own-keypage-wrap").hidden = keyPages.length < 2;
      $("own-keypage").innerHTML = keyPages.map(function (p, i) { return '<option value="' + i + '">Page ' + p.page + " (" + p.rows + " questions)</option>"; }).join("");
      usePage(0);
    } catch (e) { console.error(e); $("own-keyinfo").className = "bad small"; $("own-keyinfo").textContent = "Could not read this file. Check your internet connection and try again."; }
  });
  $("own-keypage").addEventListener("change", function () { usePage(+this.value); });
  async function usePage(i) {
    var p = keyPages[i];
    // a question whose answer could not be read clearly is left out of the marks
    $("own-key").value = p.text.split("\n").filter(function (ln) { return ln.indexOf("?") < 0; }).join("\n") + "\n";
    if (p.rows) $("own-n").value = Math.min(100, p.rows);
    await parseKey();
    if (p.unsure.length) {
      $("own-keyinfo").className = "bad small";
      $("own-keyinfo").textContent = $("own-keyinfo").textContent + " Questions " + p.unsure.slice(0, 12).join(", ") + (p.unsure.length > 12 ? "…" : "") + " could not be read clearly, so they are left out of the marks. A clearer photo may read them.";
    }
  }

  // ---------- marking ----------
  var PRESETS = { kea: [-0.25, -0.25, -0.25], third: [-1 / 3, 0, 0], none: [0, 0, 0] };
  $("own-presets").addEventListener("click", function (ev) {
    var b = ev.target.closest("button"); if (!b) return;
    var p = PRESETS[b.dataset.p], c = num("own-correct", 1);
    $("own-wrong").value = fmt(p[0] * c); $("own-blank").value = fmt(p[1] * c); $("own-multi").value = fmt(p[2] * c);
    Array.prototype.forEach.call(this.children, function (x) { x.classList.toggle("on", x === b); });
    summary(); save();
  });
  function perQ() {
    var out = {}, bad = "";
    $("own-perq").value.split("\n").forEach(function (ln) {
      ln = ln.trim(); if (!ln) return;
      var m = ln.match(/^(?:q\s*)?(\d+)\s*(?:(?:-|to|–)\s*(\d+))?\s*[:=\s]\s*(-?\d+(?:\.\d+)?)\s*(?:marks?)?$/i);
      if (!m) { bad = bad || ln; return; }
      for (var q = +m[1]; q <= +(m[2] || m[1]); q++) if (q >= 1 && q <= nq()) out[q] = parseFloat(m[3]);
    });
    return { map: out, bad: bad };
  }
  function keyedCount() { return parsed ? Object.keys(parsed.keys[parsed.sets[0]]).filter(function (q) { return +q <= nq(); }).length : nq(); }
  function total() {
    var pq = perQ().map, c = num("own-correct", 1), n = keyedCount(), t = 0, keyed = parsed ? parsed.keys[parsed.sets[0]] : null;
    for (var q = 1; q <= nq(); q++) if (!keyed || keyed[q]) t += (q in pq) ? pq[q] : c;
    return n ? t : 0;
  }
  function summary() {
    var pq = perQ();
    if (document.activeElement !== $("own-total")) $("own-total").value = fmt(total());
    var t = $("own-summary");
    if (pq.bad) { t.textContent = "'" + pq.bad + "' in Different marks: write it like 51-100: 2"; return; }
    var five = $("own-five").checked;
    t.textContent = "Out of " + fmt(total()) + " marks. Correct +" + fmt(num("own-correct", 1)) + (Object.keys(pq.map).length ? " (some questions differ)" : "") +
      ", wrong " + fmt(num("own-wrong", 0)) + ", no bubble " + fmt(num("own-blank", 0)) + ", more than one " + fmt(num("own-multi", 0)) +
      (five ? ", option 5 " + fmt(num("own-skip", 0)) : "") + ($("own-scale").checked ? ". Negatives grow with each question's marks." : ".");
  }
  // Typing the total sets the marks for each correct answer (when no question has its own marks).
  $("own-total").addEventListener("input", function () {
    var t = parseFloat(this.value), n = keyedCount();
    if (isFinite(t) && n && !Object.keys(perQ().map).length) { $("own-correct").value = fmt(t / n); summary(); save(); }
  });
  ["own-n", "own-correct", "own-wrong", "own-blank", "own-multi", "own-skip", "own-perq"].forEach(function (id) {
    $(id).addEventListener("input", function () { if (id === "own-n") keyChanged(); summary(); save(); });
  });
  ["own-five", "own-scale"].forEach(function (id) { $(id).addEventListener("change", function () { $("own-skip-wrap").hidden = !$("own-five").checked; summary(); save(); }); });

  // ---------- the student's answers ----------
  // ---------- the student's OMR sheet ----------
  var pickHTML = $("own-pick").innerHTML;
  $("own-sheet").addEventListener("change", function () {
    var f = this.files[0], p = $("own-pick"); if (!f) { p.innerHTML = pickHTML; return; }
    E.load().catch(function () {});
    p.innerHTML = '<span class="cam" aria-hidden="true">✅</span>Uploaded. Calculating your marks…';
    if (parsed) form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event("submit", { cancelable: true }));
    else p.innerHTML = '<span class="cam" aria-hidden="true">✅</span>Uploaded. Upload the answer key (step 1), then press Calculate my marks.';
  });

  function scheme() {
    var five = $("own-five").checked;
    return { n: nq(), correct: num("own-correct", 1), wrong: num("own-wrong", 0), blank: num("own-blank", 0), multiple: num("own-multi", 0),
      skipped: five ? num("own-skip", 0) : num("own-wrong", 0), five: five ? "5" : "", scale: $("own-scale").checked, per_q: perQ().map, set: $("own-set").value };
  }

  form.addEventListener("submit", async function (ev) {
    ev.preventDefault();
    error("");
    try {
      busy(true, E.isLoaded() ? "Working…" : "Getting the calculator ready (first time only)…");
      await E.load();
      await parseKey();
      if (!parsed) { error($("own-key").value.trim() ? $("own-keyinfo").textContent : "Upload the answer key first (step 1)."); return; }
      if (perQ().bad) { error($("own-summary").textContent); return; }
      var sc = scheme(), keys = JSON.stringify(parsed.keys), name = $("own-name").value.trim(), out;
      {
        var f = $("own-sheet").files[0];
        if (!f) { error("Upload a photo or PDF of your OMR sheet (step 3)."); return; }
        busy(true, "Reading your sheet…");
        await new Promise(function (r) { setTimeout(r, 30); });
        if (window.OMRPdf.isPdf(f)) {
          var pages = await window.OMRPdf.pages(f);
          if (!pages.length) { error("This PDF has no pages."); return; }
          for (var i = 0; i < pages.length && i < 5; i++) {
            busy(true, "Reading your sheet" + (pages.length > 1 ? " (page " + (i + 1) + ")" : "") + "…");
            out = await E.call("omr_run_custom", await pages[i].bytes(), "", keys, JSON.stringify(sc), name);
            if (!out.scan_error) break;
          }
        } else {
          out = await E.call("omr_run_custom", new Uint8Array(await f.arrayBuffer()), "", keys, JSON.stringify(sc), name);
        }
      }
      if (out.scan_error) {
        if (parsed.sets.length > 1 && /Choose your set/.test(out.scan_error)) { $("own-set-wrap").hidden = false; $("own-set").focus(); }
        error(out.scan_error); return;
      }
      out.own_key = true;
      delete out.annotated_b64;   // the sheet itself is not shown, only the marks
      out.marking_note = $("own-summary").textContent.replace(/^Out of [\d.]+ marks\. /, "Your marking: ");
      window.OMRResult.render(out);
    } catch (e) {
      console.error(e);
      error("Something went wrong. Check your internet connection for the first download, then try again.");
    } finally {
      busy(false, "Working…");
      var sf = $("own-sheet").files[0];
      if (sf) { $("own-pick").innerHTML = '<span class="cam" aria-hidden="true">✅</span>'; $("own-pick").appendChild(document.createTextNode("Uploaded: " + sf.name + " (tap to choose another)")); }
    }
  });

  // "Check another sheet": start again with an empty sheet box (the key and scheme stay)
  if ($("again")) $("again").addEventListener("click", function () { $("own-sheet").value = ""; $("own-pick").innerHTML = pickHTML; });

  // ---------- remember the key and scheme on this device ----------
  var FIELDS = ["own-key", "own-n", "own-correct", "own-wrong", "own-blank", "own-multi", "own-skip", "own-perq"];
  function save() {
    try {
      var d = {}; FIELDS.forEach(function (id) { d[id] = $(id).value; });
      d.five = $("own-five").checked; d.scale = $("own-scale").checked;
      localStorage.setItem(STORE, JSON.stringify(d));
    } catch (e) { /* private mode */ }
  }
  try {
    var d = JSON.parse(localStorage.getItem(STORE) || "null");
    if (d) {
      FIELDS.forEach(function (id) { if (d[id] != null) $(id).value = d[id]; });
      $("own-five").checked = d.five !== false; $("own-scale").checked = !!d.scale;
      $("own-skip-wrap").hidden = !$("own-five").checked;
      if (d["own-perq"]) $("own-perq-box").open = true;
    }
  } catch (e) { /* ignore */ }
  summary();
  if ($("own-key").value.trim()) parseKey().catch(console.error);
})();
