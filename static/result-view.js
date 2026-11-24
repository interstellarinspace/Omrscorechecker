// Shows a scored sheet: score, score card PDF, sharing, and the marked OMR sheet on request only.
// Used by the in-browser scanner (browser-scan.js) and by the server's result page.
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var SITE = window.OMR_SITE || {};
  var JSPDF_URL = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
  var current = null, standalone = false, pushed = false, cardCache = {};
  var pickHTML = $("pick") ? $("pick").innerHTML : "";

  function examOf(r) { return r && r.own_key ? "" : (r && r.exam_short) || SITE.exam || ""; }
  function fmt(x) { return (Math.round(x * 100) / 100).toString(); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function show(el, on) { if (el) el.hidden = !on; }
  function mask(reg) {
    reg = String(reg || "");
    return reg.length < 5 ? reg : reg.slice(0, 2) + new Array(reg.length - 3).join("•") + reg.slice(-2);
  }
  function today() { return new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }); }
  function note(msg) { var n = $("share-note"); n.textContent = msg || ""; show(n, !!msg); }

  var jspdfReady = null;
  function loadJsPDF() {
    if (window.jspdf) return Promise.resolve(window.jspdf);
    if (jspdfReady) return jspdfReady;
    jspdfReady = new Promise(function (ok, fail) {
      var s = document.createElement("script"); s.src = JSPDF_URL; s.async = true;
      s.onload = function () { ok(window.jspdf); }; s.onerror = function () { jspdfReady = null; fail(new Error("jsPDF")); };
      document.head.appendChild(s);
    });
    return jspdfReady;
  }

  // ---------- result view ----------
  function render(r, opts) {
    opts = opts || {};
    current = r; cardCache = {}; standalone = !!opts.standalone;
    var g = r.grading, m = r.marking || {}, five = r.five || "5";
    $("res-who").textContent = r.name ? r.name : "Your result";
    $("res-subject").textContent = (examOf(r) ? examOf(r) + " · " : "") + (r.subject_name || "");
    $("res-error").textContent = r.error || ""; show($("res-error"), !!r.error);
    show($("res-scorebox"), !!g); show($("res-share"), !!g);
    if (g) {
      $("res-score").textContent = fmt(g.score);
      $("res-max").textContent = "out of " + fmt(g.max_score);
      var pct = g.max_score ? Math.max(0, Math.min(100, g.score / g.max_score * 100)) : 0;
      $("res-ring").style.setProperty("--pct", pct.toFixed(1) + "%");
      var c = g.counts;
      $("res-stats").innerHTML = [["correct", c.correct, "Correct"], ["wrong", c.wrong, "Wrong"], ["skipped", c.skipped, "Option " + esc(five)],
        ["blank", c.blank, "Blank"], ["multiple", c.multiple, "Multiple"]].map(function (s) {
        return '<div class="s-' + s[0] + '"><b>' + s[1] + "</b>" + s[2] + "</div>";
      }).join("");
      $("res-marking").textContent = r.marking_note ? r.marking_note : "Marking: +" + fmt(m.correct) + " correct, " + fmt(m.wrong) + " wrong, " + fmt(m.skipped) + " for option " + five +
        " (not attempted), " + fmt(m.blank) + " for no bubble shaded, " + fmt(m.multiple) + " for more than one shaded.";
      loadJsPDF().catch(function () {});
    }
    $("res-facts").innerHTML = "<span>Set <b>" + esc(r.version || "?") + "</b></span><span>Register <b>" + esc(r.register_number) +
      "</b></span><span>Booklet <b>" + esc(r.booklet_serial) + "</b></span>";
    show($("res-omr"), !!(r.annotated_b64 || (r.sheet && r.sheet_key)));
    var rows = g && g.questions ? g.questions.filter(function (q) { return q.result !== "no_key"; }) : [];
    show($("res-qs"), rows.length > 0); $("res-qs").open = false;
    $("res-table").innerHTML = "<tr><th>Q</th><th>Yours</th><th>Key</th><th>Result</th><th>Marks</th></tr>" + rows.map(function (q) {
      var given = q.given === "*" ? "multiple" : (q.given || "–");
      return "<tr><td>" + q.q + "</td><td>" + esc(given) + "</td><td>" + esc(q.key || "dropped") + '</td><td class="r-' + q.result + '">' +
        esc(q.result === "skipped" ? "not attempted" : q.result) + "</td><td>" + fmt(q.marks) + "</td></tr>";
    }).join("");
    note("");
    show($("forms") || $("scan-form"), false); show($("intro"), false); show($("result"), true); show($("nav-back"), true);
    if (!standalone && !pushed) { history.pushState({ omr: "result" }, ""); pushed = true; }
    window.scrollTo(0, 0);
  }

  function showForm() {
    pushed = false;
    show($("result"), false); show($("forms") || $("scan-form"), true); show($("intro"), true); show($("nav-back"), false); show($("multi"), false);
    if ($("sheet")) $("sheet").value = "";
    if ($("pick")) $("pick").innerHTML = pickHTML;
    window.scrollTo(0, 0);
  }

  window.addEventListener("popstate", function () { if (!standalone && !$("result").hidden) showForm(); });
  window.OMRBack = function () {
    if (standalone || $("result").hidden) return false;
    if (pushed) history.back(); else showForm();
    return true;
  };
  $("again").addEventListener("click", function () {
    if (standalone) { location.href = SITE.home || "./"; return; }
    if (pushed) history.back(); else showForm();
  });

  // ---------- marked OMR in a new tab ----------
  function sheetPage(src) {
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<meta name="robots" content="noindex"><title>My marked OMR sheet</title><style>body{margin:0;background:#f3f4ff;font:15px/1.45 system-ui,sans-serif;color:#1b1f3b}' +
      'header{background:linear-gradient(120deg,#4338ca,#7c3aed 55%,#db2777);color:#fff;padding:12px 16px;font-weight:700}main{max-width:900px;margin:0 auto;padding:12px}' +
      'p{margin:0 0 10px;color:#5f6787}img{width:100%;border-radius:8px;border:1px solid #e3e5f3;background:#fff}</style></head><body>' +
      "<header>My marked OMR sheet · " + esc(current.subject_name) + " · Set " + esc(current.version || "?") + "</header><main>" +
      "<p>Green ring: correct. Red ring: wrong, with the right answer ringed thinly in green. Orange: more than one bubble shaded. " +
      "Blue: option 5 (not attempted), and the version, register and booklet numbers. Close this tab to go back to your score.</p>" +
      (src ? '<img alt="Your sheet with answers marked" src="' + src + '">' : "<p>Opening your sheet…</p>") + "</main></body></html>";
  }
  $("view-omr").addEventListener("click", async function () {
    if (!current) return;
    if (current.annotated_b64) {
      var url = URL.createObjectURL(new Blob([sheetPage("data:image/jpeg;base64," + current.annotated_b64)], { type: "text/html" }));
      var w = window.open(url, "_blank");
      if (!w) { var a = document.createElement("a"); a.href = url; a.target = "_blank"; a.rel = "noopener"; document.body.appendChild(a); a.click(); a.remove(); }
      return;
    }
    if (!current.sheet || !current.sheet_key) return;
    // A sheet saved by the exam admin: open the tab now (so it isn't blocked), then fill it in.
    var tab = window.open("", "_blank"), btn = this, label = btn.textContent;
    if (tab) { tab.document.write(sheetPage("")); tab.document.close(); }
    btn.disabled = true; btn.textContent = "Opening…";
    try {
      var src = await OMRCrypto.openSheet((SITE.published || "published/") + current.sheet.replace(/^published\//, ""), current.sheet_key);
      if (tab && !tab.closed) { tab.document.open(); tab.document.write(sheetPage(src)); tab.document.close(); }
      else location.href = src;
    } catch (e) {
      console.error(e); if (tab) tab.close();
      note("Could not open your OMR sheet right now. Check your internet connection and try again.");
    } finally { btn.disabled = false; btn.textContent = label; }
  });

  // ---------- score card image ----------
  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function fit(ctx, text, max, size, weight) {
    var s = size; do { ctx.font = weight + " " + s + "px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"; s -= 2; } while (ctx.measureText(text).width > max && s > 18);
  }
  function drawCard(r, full) {
    var W = 1080, H = 1350, cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    var ctx = cv.getContext("2d"), g = r.grading, c = g.counts;
    var bg = ctx.createLinearGradient(0, 0, W, H); bg.addColorStop(0, "#4338ca"); bg.addColorStop(0.55, "#7c3aed"); bg.addColorStop(1, "#db2777");
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "rgba(255,255,255,.10)"; ctx.beginPath(); ctx.arc(W - 60, 70, 210, 0, 7); ctx.fill(); ctx.beginPath(); ctx.arc(70, H - 40, 170, 0, 7); ctx.fill();
    ctx.textAlign = "center"; ctx.fillStyle = "#fff";
    ctx.font = "800 54px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"; ctx.fillText(SITE.name || "OMR Score Check", W / 2, 110);
    ctx.font = "600 32px system-ui, sans-serif"; ctx.globalAlpha = 0.9; ctx.fillText((examOf(r) ? examOf(r) + " · " : "") + "Score card", W / 2, 162); ctx.globalAlpha = 1;
    // panel
    ctx.save(); ctx.shadowColor = "rgba(30,20,90,.35)"; ctx.shadowBlur = 40; ctx.shadowOffsetY = 14;
    rr(ctx, 70, 220, W - 140, 960, 44); ctx.fillStyle = "#fff"; ctx.fill(); ctx.restore();
    ctx.fillStyle = "#1b1f3b"; fit(ctx, r.name || "Candidate", W - 220, 58, "800"); ctx.fillText(r.name || "Candidate", W / 2, 320);
    ctx.fillStyle = "#5f6787"; fit(ctx, r.subject_name || "", W - 220, 36, "600"); ctx.fillText(r.subject_name || "", W / 2, 374);
    // ring
    var cx = W / 2, cy = 600, R = 170, pct = g.max_score ? Math.max(0, Math.min(1, g.score / g.max_score)) : 0;
    ctx.lineWidth = 34; ctx.lineCap = "round"; ctx.strokeStyle = "#ece9fe"; ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.stroke();
    var rg = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R); rg.addColorStop(0, "#4338ca"); rg.addColorStop(0.6, "#7c3aed"); rg.addColorStop(1, "#db2777");
    if (pct > 0) { ctx.strokeStyle = rg; ctx.beginPath(); ctx.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + pct * 2 * Math.PI); ctx.stroke(); }
    ctx.fillStyle = "#3b2fc9"; fit(ctx, fmt(g.score), 2 * R - 90, 104, "800"); ctx.fillText(fmt(g.score), cx, cy + 22);
    ctx.fillStyle = "#5f6787"; ctx.font = "600 32px system-ui, sans-serif"; ctx.fillText("out of " + fmt(g.max_score), cx, cy + 74);
    // stats
    var tiles = [["Correct", c.correct, "#dcfce7", "#15803d"], ["Wrong", c.wrong, "#fee2e2", "#dc2626"], ["Option " + (r.five || "5"), c.skipped, "#e0f2fe", "#0369a1"],
      ["Blank", c.blank, "#eef0f5", "#4b5563"], ["Multiple", c.multiple, "#ffedd5", "#c2410c"]];
    var tw = 164, gap = 14, x0 = (W - (tw * 5 + gap * 4)) / 2;
    tiles.forEach(function (t, i) {
      var x = x0 + i * (tw + gap); rr(ctx, x, 830, tw, 132, 22); ctx.fillStyle = t[2]; ctx.fill();
      ctx.fillStyle = t[3]; ctx.font = "800 54px system-ui, sans-serif"; ctx.fillText(String(t[1]), x + tw / 2, 900);
      ctx.font = "600 25px system-ui, sans-serif"; ctx.fillText(t[0], x + tw / 2, 940);
    });
    ctx.fillStyle = "#3730a3"; ctx.font = "600 30px system-ui, sans-serif";
    ctx.fillText("Set " + (r.version || "?") + "   ·   Register " + (full ? r.register_number : mask(r.register_number)) + "   ·   Booklet " + (r.booklet_serial || ""), W / 2, 1030);
    ctx.fillStyle = "#5f6787"; ctx.font = "500 26px system-ui, sans-serif";
    ctx.fillText("Checked on " + today() + " against " + (r.own_key ? "your own answer key" : "the KEA provisional answer key"), W / 2, 1082);
    ctx.fillText("Unofficial estimate. KEA's final key and results are what count.", W / 2, 1122);
    ctx.fillStyle = "#fff"; ctx.font = "700 34px system-ui, sans-serif"; ctx.fillText("Check your score free", W / 2, 1250);
    ctx.font = "500 28px system-ui, sans-serif"; ctx.globalAlpha = 0.95; ctx.fillText((SITE.url || location.origin).replace(/^https?:\/\//, ""), W / 2, 1296); ctx.globalAlpha = 1;
    return cv;
  }
  function cardBlob(full) {
    var k = full ? "full" : "masked";
    if (cardCache[k]) return Promise.resolve(cardCache[k]);
    return new Promise(function (ok) { drawCard(current, full).toBlob(function (b) { cardCache[k] = b; ok(b); }, "image/png"); });
  }
  function baseName() {
    return ((examOf(current) || "OMR") + " score " + (current.subject_name || "")).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }
  function download(blob, name) {
    var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 30000);
  }

  // ---------- PDF ----------
  $("dl-pdf").addEventListener("click", async function () {
    if (!current || !current.grading) return;
    var btn = this; btn.disabled = true; note("");
    try {
      var lib = await loadJsPDF();
      var doc = new lib.jsPDF({ unit: "mm", format: "a4" });
      var img = drawCard(current, true).toDataURL("image/jpeg", 0.92);
      doc.addImage(img, "JPEG", 30, 12, 150, 187.5);
      var m = current.marking || {}, y = 212;
      doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor(60, 64, 90);
      var lines = doc.splitTextToSize(current.own_key ? (current.marking_note || "") + " Worked out with your own answer key and marking scheme. This is an unofficial estimate." : "Marking: +" + fmt(m.correct) + " for a correct answer, " + fmt(m.wrong) + " for a wrong answer, " + fmt(m.skipped) +
        " for option " + (current.five || "5") + " (not attempted), " + fmt(m.blank) + " for no bubble shaded, " + fmt(m.multiple) + " for more than one bubble shaded. " +
        "This is an unofficial estimate based on the KEA provisional answer key; the final key and results announced by KEA are what count.", 150);
      doc.text(lines, 30, y);
      var qs = (current.grading.questions || []).filter(function (q) { return q.result !== "no_key"; });
      if (qs.length) {
        doc.addPage();
        doc.setFont("helvetica", "bold"); doc.setFontSize(14); doc.setTextColor(27, 31, 59);
        doc.text("Question by question · " + (current.subject_name || "") + " · Set " + (current.version || "?"), 15, 16);
        var colors = { correct: [21, 128, 61], wrong: [220, 38, 38], multiple: [194, 65, 12], skipped: [3, 105, 161], blank: [95, 103, 135], dropped: [95, 103, 135] };
        var label = { skipped: "option " + (current.five || "5") };
        doc.setFontSize(8);
        for (var col = 0; col < 4; col++) {
          var x = 15 + col * 46; doc.setFont("helvetica", "bold"); doc.setTextColor(95, 103, 135);
          doc.text("Q", x, 26); doc.text("Yours", x + 7, 26); doc.text("Key", x + 17, 26); doc.text("Result", x + 25, 26);
        }
        doc.setFont("helvetica", "normal");
        qs.forEach(function (q, i) {
          var col = Math.floor(i / 25) % 4, row = i % 25, page = Math.floor(i / 100);
          if (i && i % 100 === 0) doc.addPage();
          var x = 15 + col * 46, yy = 33 + row * 10;
          doc.setTextColor(27, 31, 59);
          doc.text(String(q.q), x, yy); doc.text(q.given === "*" ? "multi" : (q.given || "-"), x + 7, yy); doc.text(q.key || "drop", x + 17, yy);
          var cl = colors[q.result] || [27, 31, 59]; doc.setTextColor(cl[0], cl[1], cl[2]);
          doc.text((label[q.result] || q.result) + " (" + fmt(q.marks) + ")", x + 25, yy);
          void page;
        });
      }
      var blob = doc.output("blob");
      download(blob, baseName() + ".pdf");
      note("Your result sheet PDF has been downloaded. Look for it in your Downloads or Files app.");
    } catch (e) {
      console.error(e);
      note("Could not make the PDF. Check your internet connection and try again.");
    } finally { btn.disabled = false; }
  });

  // ---------- print: the page's print style shows only the result and every question ----------
  $("print-res").addEventListener("click", function () {
    if (!current || !current.grading) return;
    var qs = $("res-qs"), was = qs.open; qs.open = true;
    var done = function () { qs.open = was; window.removeEventListener("afterprint", done); };
    window.addEventListener("afterprint", done);
    window.print();
  });

  // ---------- sharing ----------
  function shareText() {
    var g = current.grading;
    return "I scored " + fmt(g.score) + "/" + fmt(g.max_score) + " in " + (examOf(current) ? examOf(current) + " " : "") + current.subject_name +
      " (set " + (current.version || "?") + ") on " + (SITE.name || "OMR Score Check") + ". Check your score free: " + (SITE.url || location.href);
  }
  async function shareCard(appName) {
    var blob = await cardBlob(false);
    var file = new File([blob], baseName() + ".png", { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      if (appName) note("Choose " + appName + " in the share menu.");
      try { await navigator.share({ files: [file], text: shareText(), title: "My score card" }); note(""); }
      catch (e) { if (e && e.name !== "AbortError") note("Sharing did not work. Use Save image and send it yourself."); }
      return true;
    }
    return false;
  }
  function openLink(url) { var w = window.open(url, "_blank"); if (w) { try { w.opener = null; } catch (e) {} } else location.href = url; }

  $("sh-wa").addEventListener("click", async function () {
    if (!current || !current.grading) return;
    if (!(await shareCard("WhatsApp"))) openLink("https://wa.me/?text=" + encodeURIComponent(shareText()));
  });
  $("sh-tg").addEventListener("click", async function () {
    if (!current || !current.grading) return;
    if (!(await shareCard("Telegram"))) openLink("https://t.me/share/url?url=" + encodeURIComponent(SITE.url || location.href) + "&text=" + encodeURIComponent(shareText().replace(/ Check your score free: .*$/, "")));
  });
  $("sh-ig").addEventListener("click", async function () {
    if (!current || !current.grading) return;
    if (await shareCard("Instagram")) return;
    download(await cardBlob(false), baseName() + ".png");
    note("Instagram can't be opened from a website on this device, so your score card image has been saved. Open Instagram and add it to your story or a post.");
  });
  $("sh-more").addEventListener("click", async function () {
    if (!current || !current.grading) return;
    if (await shareCard("")) return;
    download(await cardBlob(false), baseName() + ".png");
    note("Your score card image has been saved.");
  });

  window.OMRResult = { render: render, showForm: showForm };
  if (window.OMR_RESULT) render(window.OMR_RESULT, { standalone: true });
})();
