// Runs the same Python scanner (omr/scanner.py, omr/keys.py) inside the browser
// with Pyodide, so the GitHub Pages site needs no server and photos never leave the phone.
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var form = $("scan-form");
  if (!form) return;
  var load = window.OMREngine.load;

  // Start downloading the scanner as soon as the candidate picks a photo or subject.
  ["sheet", "subject"].forEach(function (id) { $(id).addEventListener("change", function () { load(); }); });

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
    if (!file) { formError("Please choose a photo or PDF of your answer sheet."); return; }
    formError("");
    try {
      busy(true, window.OMREngine.isLoaded() ? "Reading your sheet…" : "Downloading the scanner (first time only)…");
      await load();
      busy(true, "Reading your sheet…");
      await new Promise(function (r) { setTimeout(r, 30); });
      var out;
      if (window.OMRPdf && window.OMRPdf.isPdf(file)) {
        // A KEA OMR PDF: use the first page that reads as an OMR sheet.
        busy(true, "Opening the PDF…");
        var pages = await window.OMRPdf.pages(file);
        for (var i = 0; i < pages.length && i < 5; i++) {
          busy(true, "Reading your sheet" + (pages.length > 1 ? " (page " + (i + 1) + ")" : "") + "…");
          out = await window.OMREngine.call("omr_run", await pages[i].bytes(), subject, $("name").value.trim());
          if (!out.scan_error) break;
        }
        if (!pages.length) { formError("This PDF has no pages."); return; }
      } else {
        out = await window.OMREngine.call("omr_run", await (window.OMRPdf ? window.OMRPdf.imageBytes(file) : file.arrayBuffer().then(function (b) { return new Uint8Array(b); })), subject, $("name").value.trim());
      }
      if (out.scan_error) { formError(out.scan_error); return; }
      window.OMRResult.render(out);
    } catch (e) {
      console.error(e);
      formError("Something went wrong while reading the sheet. Check your internet connection for the first download, then try again.");
    } finally {
      busy(false, "Reading your sheet…");
    }
  });

})();
