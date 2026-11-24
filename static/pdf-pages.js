// Turns a PDF (for example an OMR sheet PDF downloaded from KEA) into one JPEG image per page,
// inside the browser, so the scanner can read it like a photo. Uses pdf.js from cdnjs.
(function () {
  "use strict";
  var PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
  var WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  var loading = null;
  function load() {
    return loading || (loading = new Promise(function (ok, fail) {
      if (window.pdfjsLib) return ok();
      var el = document.createElement("script"); el.src = PDFJS; el.onload = ok;
      el.onerror = function () { loading = null; fail(new Error("Could not load the PDF reader. Check the internet connection and try again.")); };
      document.head.appendChild(el);
    }).then(function () { window.pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER; }));
  }
  function isPdf(f) { return !!f && (/\.pdf$/i.test(f.name || "") || f.type === "application/pdf"); }
  async function render(doc, n) {
    var page = await doc.getPage(n), v = page.getViewport({ scale: 1 });
    v = page.getViewport({ scale: 2200 / Math.max(v.width, v.height) });
    var cv = document.createElement("canvas"); cv.width = Math.round(v.width); cv.height = Math.round(v.height);
    var ctx = cv.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
    await page.render({ canvasContext: ctx, viewport: v }).promise;
    var blob = await new Promise(function (ok) { cv.toBlob(ok, "image/jpeg", 0.9); });
    cv.width = cv.height = 0;
    return blob;
  }
  // [{name, bytes(): Promise<Uint8Array>, blob(): Promise<Blob>}] — pages are drawn only when asked for.
  async function pages(file) {
    await load();
    var doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise, out = [];
    for (var p = 1; p <= doc.numPages; p++) (function (p) {
      var blob = function () { return render(doc, p); };
      out.push({ name: file.name + (doc.numPages > 1 ? " page " + p : ""), page: p, blob: blob,
        bytes: async function () { return new Uint8Array(await (await blob()).arrayBuffer()); } });
    })(p);
    return out;
  }
  window.OMRPdf = { isPdf: isPdf, pages: pages, load: load };
})();
