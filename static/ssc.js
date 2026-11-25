// SSC marks calculator: reads a TCS (ssc.digialm.com) response sheet, from its link, a saved
// copy of the page (.html / .mhtml) or a PDF of it, and works out the marks section by section.
// Everything runs in the browser; nothing is uploaded.
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var JSPDF_URL = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";

  // ---------- marking schemes ----------
  // rules: first matching section-name pattern wins; otherwise the exam's default marks.
  var EXAMS = [
    { id: "cgl1", name: "SSC CGL Tier 1", right: 2, wrong: 0.5, test: /combined graduate/i, tier: 1 },
    { id: "cgl2", name: "SSC CGL Tier 2", right: 3, wrong: 1, test: /combined graduate/i, tier: 2,
      rules: [{ re: /computer|data entry|dest/i, counted: false }] },
    { id: "chsl1", name: "SSC CHSL Tier 1", right: 2, wrong: 0.5, test: /higher secondary|chsl/i, tier: 1 },
    { id: "chsl2", name: "SSC CHSL Tier 2", right: 3, wrong: 1, test: /higher secondary|chsl/i, tier: 2,
      rules: [{ re: /computer|typing|skill/i, counted: false }] },
    { id: "mts", name: "SSC MTS & Havaldar", right: 3, wrong: 1, test: /multi.?tasking|havaldar|\bmts\b/i,
      rules: [{ re: /numerical|mathematic|reasoning|problem solving/i, wrong: 0 }] },
    { id: "gd", name: "SSC GD Constable", right: 2, wrong: 0.25, test: /\bGD\b|general duty|constable.*(capf|gd)/i },
    { id: "cpo", name: "SSC CPO (SI) Paper 1", right: 1, wrong: 0.25, test: /sub.?inspector|\bCPO\b|capfs?\b/i },
    { id: "je", name: "SSC JE Paper 1", right: 1, wrong: 0.25, test: /junior engineer/i },
    { id: "steno", name: "SSC Stenographer", right: 1, wrong: 0.25, test: /stenographer/i },
    { id: "sel", name: "SSC Selection Post", right: 2, wrong: 0.5, test: /selection post/i },
    { id: "delhi", name: "Delhi Police Constable", right: 1, wrong: 0.25, test: /delhi police/i },
    { id: "custom", name: "Other (set your own marks)", right: 1, wrong: 0 }
  ];

  function detectExam(info) {
    var s = [info.subject, info.exam, info.title].join(" ");
    var tier2 = /tier[\s-]*(ii|2)\b|paper[\s-]*(ii|2)\b/i.test(s);
    for (var i = 0; i < EXAMS.length; i++) {
      var e = EXAMS[i];
      if (!e.test || !e.test.test(s)) continue;
      if (e.tier && (e.tier === 2) !== tier2) continue;
      return e.id;
    }
    return "";
  }

  // ---------- reading the response sheet ----------
  function clean(s) { return String(s || "").replace(/ /g, " ").replace(/[ \t\r\f\v]+/g, " ").trim(); }

  // A saved .mhtml page: pull out the HTML part.
  function fromMhtml(text) {
    var m = text.match(/boundary="?([^"\r\n;]+)"?/i);
    if (!m) return text;
    var parts = text.split("--" + m[1]);
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i], head = p.split(/\r?\n\r?\n/)[0];
      if (!/content-type:\s*text\/html/i.test(head)) continue;
      var body = p.slice(head.length).replace(/^\s+/, "");
      if (/content-transfer-encoding:\s*quoted-printable/i.test(head)) {
        body = body.replace(/=\r?\n/g, "");
        var bytes = [], j = 0;
        while (j < body.length) {
          if (body[j] === "=" && /^[0-9A-F]{2}$/i.test(body.substr(j + 1, 2))) { bytes.push(parseInt(body.substr(j + 1, 2), 16)); j += 3; }
          else { var c = body.charCodeAt(j++); if (c < 128) bytes.push(c); else Array.prototype.push.apply(bytes, Array.from(new TextEncoder().encode(String.fromCharCode(c)))); }
        }
        return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
      }
      if (/content-transfer-encoding:\s*base64/i.test(head)) {
        var bin = atob(body.replace(/\s+/g, "")), arr = new Uint8Array(bin.length);
        for (var k = 0; k < bin.length; k++) arr[k] = bin.charCodeAt(k);
        return new TextDecoder("utf-8").decode(arr);
      }
      return body;
    }
    return text;
  }

  // The page's text in reading order, with markers where the sheet shows the right answer
  // ([[RIGHT n]]) and the section names (Section : …). The same text parser reads PDFs.
  function htmlToStream(html) {
    var doc = new DOMParser().parseFromString(html, "text/html");
    Array.prototype.forEach.call(doc.querySelectorAll("script,style,noscript"), function (el) { el.remove(); });
    Array.prototype.forEach.call(doc.querySelectorAll(".rightAns"), function (td) {
      var m = clean(td.textContent).match(/^([1-9])\s*\./), n = m ? m[1] : "";
      if (!n) {   // no label text: count the option cells in this question's table
        var tbl = td.closest("table"), opts = tbl ? tbl.querySelectorAll(".rightAns,.wrngAns") : [];
        n = String(Array.prototype.indexOf.call(opts, td) + 1);
      }
      td.appendChild(doc.createTextNode(" [[RIGHT " + n + "]] "));
    });
    Array.prototype.forEach.call(doc.querySelectorAll(".section-lbl"), function (el) {
      var t = clean(el.textContent).replace(/^section\s*:?\s*/i, "");
      el.textContent = "\nSection : " + t + "\n";
    });
    var out = [];
    var BLOCK = /^(DIV|TR|TABLE|P|BR|LI|H[1-6]|TBODY|SECTION)$/;
    (function walk(n) {
      if (n.nodeType === 3) { out.push(n.nodeValue); return; }
      if (n.nodeType !== 1) return;
      if (n.tagName === "IMG" && /tick|right|correct/i.test(n.getAttribute("src") || "")) out.push(" ");
      for (var c = n.firstChild; c; c = c.nextSibling) walk(c);
      if (BLOCK.test(n.tagName)) out.push("\n"); else if (n.tagName === "TD" || n.tagName === "TH") out.push(" \t ");
    })(doc.body || doc.documentElement);
    return { text: out.join(""), title: clean(doc.title) };
  }

  var INFO_LABELS = [
    ["roll", /^(Roll\s*(No|Number)\.?|Participant ID|Registration\s*(No|Number)\.?)\s*:?$/i],
    ["name", /^(Candidate Name|Participant Name|Name)\s*:?$/i],
    ["centre", /^(Venue Name|Test Cent(er|re) Name|Exam Cent(er|re)|Centre Name)\s*:?$/i],
    ["date", /^(Exam Date|Test Date)\s*:?$/i],
    ["time", /^(Exam Time|Test Time)\s*:?$/i],
    ["subject", /^(Subject|Exam Name|Exam)\s*:?$/i]
  ];

  function parseStream(text, title) {
    var lines = text.split("\n").map(function (l) { return l.split("\t").map(clean).filter(Boolean); });
    var info = { title: title || "" };
    // Candidate details: "Label <tab> value" cells before the first question.
    for (var i = 0; i < lines.length && i < 400; i++) {
      var cells = lines[i];
      if (cells.some(function (c) { return /^Q\.\s*\d+/.test(c); })) break;
      for (var j = 0; j < cells.length - 1; j++) {
        for (var k = 0; k < INFO_LABELS.length; k++) {
          if (!info[INFO_LABELS[k][0]] && INFO_LABELS[k][1].test(cells[j])) info[INFO_LABELS[k][0]] = cells[j + 1];
        }
      }
    }
    var flat = text.replace(/\s+/g, " ");
    // The same details from plain text (PDFs), when the cells were not found.
    var TEXT_INFO = {
      roll: /(?:Roll\s*(?:No|Number)\.?|Participant ID|Registration\s*(?:No|Number)\.?)\s*:?\s*([A-Z0-9]{6,20})\b/i,
      name: /(?:Candidate Name|Participant Name)\s*:?\s*([A-Za-z][A-Za-z .']{1,60}?)(?=\s+(?:Venue|Test|Exam|Roll|Participant|Subject|Registration)\b)/i,
      centre: /(?:Venue Name|Test Cent(?:er|re) Name)\s*:?\s*(.{3,120}?)(?=\s+(?:Exam Date|Test Date|Exam Time|Test Time|Subject)\b)/i,
      date: /(?:Exam Date|Test Date)\s*:?\s*(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})/i,
      time: /(?:Exam Time|Test Time)\s*:?\s*(\d{1,2}[:.]\d{2}\s*[AP]M\s*-\s*\d{1,2}[:.]\d{2}\s*[AP]M)/i,
      subject: /Subject\s*:?\s*(.{3,120}?)(?=\s+(?:Section\b|Q\.\s*\d|Group\b|PART\b))/i
    };
    if (!info.subject) { var sm = text.match(/Subject\s*:?[ \t]*([^\n\t]{3,120})/i); if (sm) info.subject = clean(sm[1]); }
    Object.keys(TEXT_INFO).forEach(function (k) {
      if (info[k]) return;
      var m = flat.match(TEXT_INFO[k]); if (m) info[k] = clean(m[1]);
    });

    var TOK = /Section\s*:\s*([^\n\t]+?)\s*(?=\n|\t|Q\.\s*\d)|\bQ\.\s*(\d{1,3})\b|\[\[RIGHT ([1-9])\]\]|Question ID\s*:\s*(\d+)|Option\s*([1-9])\s*ID\s*:\s*(\d+)|Status\s*:\s*([A-Za-z ]+?)(?=\s*(?:Chosen|\t|\n|$))|Chosen Option\s*:\s*(\d+|-+|N\.?A\.?)|Question Type\s*:\s*([A-Za-z]+)/g;
    var qs = [], cur = null, section = "", m2, lastEnd = 0, secSeen = false;
    var MENU = /^(Chosen Option|Status|Option\s*\d+\s*ID|Question ID|Question Type|Ans\b|\[\[RIGHT)/i;
    while ((m2 = TOK.exec(text))) {
      var gapStart = lastEnd; lastEnd = TOK.lastIndex;
      if (m2[1] !== undefined) { section = clean(m2[1]); secSeen = true; }
      else if (m2[2] !== undefined) {
        // A PDF has the section name on its own line, just before its first question.
        if (!secSeen && (!qs.length || +m2[2] <= qs[qs.length - 1].n)) {
          var gap = text.slice(gapStart, m2.index).split("\n").map(clean).filter(function (l) { return l && !MENU.test(l) && /[A-Za-z]{3}/.test(l); });
          var cand = gap.length ? gap[gap.length - 1].replace(/^section\s*:?\s*/i, "") : "";
          if (cand && cand.length <= 90 && !/^(Subject|Exam|Test|Venue|Candidate|Participant|Roll)\b/i.test(cand)) section = cand;
        }
        secSeen = false;
        cur = { n: +m2[2], section: section || "Questions", right: [], chosen: "", status: "", id: "", optIds: {}, type: "" };
        qs.push(cur);
      } else if (!cur) continue;
      else if (m2[3] !== undefined) { if (cur.right.indexOf(m2[3]) < 0) cur.right.push(m2[3]); }
      else if (m2[4] !== undefined) cur.id = m2[4];
      else if (m2[5] !== undefined) cur.optIds[m2[6]] = m2[5];
      else if (m2[7] !== undefined) cur.status = clean(m2[7]);
      else if (m2[8] !== undefined) {
        var v = m2[8];
        if (/^\d+$/.test(v) && v.length > 2 && cur.optIds[v]) v = cur.optIds[v];   // an option ID instead of its number
        cur.chosen = /^\d+$/.test(v) ? String(+v) : "";
      } else if (m2[9] !== undefined) cur.type = m2[9].toUpperCase();
    }
    // A question number repeated with no menu details (a "Q.1" inside question text) is dropped.
    qs = qs.filter(function (q, i) { return q.id || q.status || q.chosen || q.right.length || !qs[i + 1] || qs[i + 1].n !== q.n; });
    // Only multiple-choice questions are scored.
    qs = qs.filter(function (q) { return !q.type || q.type === "MCQ" || q.type === "MSQ"; });
    return { info: info, questions: qs };
  }

  // A PDF of the response sheet: its text, plus [[RIGHT n]] where the option label is green
  // (the sheet shows the right answer in green with a green tick).
  async function pdfToStream(file) {
    await window.OMRPdf.load();
    var pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    var out = [];
    for (var p = 1; p <= pdf.numPages; p++) {
      setBusy("Reading page " + p + " of " + pdf.numPages + "…");
      var page = await pdf.getPage(p), scale = 2, vp = page.getViewport({ scale: scale });
      var cv = document.createElement("canvas"); cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
      var ctx = cv.getContext("2d", { willReadFrequently: true }); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      var tc = await page.getTextContent(), items = tc.items.filter(function (it) { return typeof it.str === "string"; });
      var px = ctx.getImageData(0, 0, cv.width, cv.height).data;
      var green = function (x0, y0, x1, y1) {
        x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0)); x1 = Math.min(cv.width, Math.ceil(x1)); y1 = Math.min(cv.height, Math.ceil(y1));
        var n = 0;
        for (var y = y0; y < y1; y++) for (var x = x0; x < x1; x++) {
          var o = (y * cv.width + x) * 4, r = px[o], g = px[o + 1], b = px[o + 2];
          if (g > 90 && g > r * 1.35 + 15 && g > b * 1.15 + 10) n++;
        }
        return n;
      };
      var lastY = null;
      for (var i = 0; i < items.length; i++) {
        var it = items[i], s = it.str;
        // "1" and "." can come out as two pieces
        if (/^\s*[1-9]\s*$/.test(s) && items[i + 1] && /^\s*\./.test(items[i + 1].str)) s = s + items[i + 1].str;
        var tx = window.pdfjsLib.Util.transform(vp.transform, it.transform);
        var x = tx[4], y = tx[5], h = Math.max(6, Math.hypot(tx[2], tx[3]));
        if (lastY !== null && Math.abs(y - lastY) > h * 0.6) out.push("\n");
        lastY = y;
        out.push(it.str, it.hasEOL ? "\n" : " ");
        var lab = s.match(/^\s*(?:Ans\s*)?([1-9])\s*\.(\s|$)/);
        if (lab) {
          var w = Math.max(it.width * scale, h);
          var band = green(x - h * 2.2, y - h * 0.95, x + Math.max(w, h * 1.5) + h * 1.2, y + h * 0.2);
          if (band >= Math.max(6, h * 0.6)) out.push(" [[RIGHT " + lab[1] + "]] ");
        }
      }
      out.push("\n");
      cv.width = cv.height = 0;
    }
    return { text: out.join("").replace(/[ \t]*\n[ \t]*/g, "\n"), title: "" };
  }

  // ---------- scoring ----------
  var state = { sheet: null, sections: [], examId: "" };

  function sectionNames(qs) {
    var names = [];
    qs.forEach(function (q) { if (names.indexOf(q.section) < 0) names.push(q.section); });
    return names;
  }
  function examById(id) { for (var i = 0; i < EXAMS.length; i++) if (EXAMS[i].id === id) return EXAMS[i]; return EXAMS[EXAMS.length - 1]; }
  function applyExam(id) {
    var e = examById(id); state.examId = e.id;
    state.sections = sectionNames(state.sheet.questions).map(function (name) {
      var s = { name: name, right: e.right, wrong: e.wrong, counted: true };
      (e.rules || []).some(function (r) {
        if (!r.re.test(name)) return false;
        if (r.right !== undefined) s.right = r.right; if (r.wrong !== undefined) s.wrong = r.wrong; if (r.counted !== undefined) s.counted = r.counted;
        return true;
      });
      return s;
    });
    $("ssc-all-right").value = e.right; $("ssc-all-wrong").value = e.wrong;
  }

  function score() {
    var bonus = $("ssc-bonus").checked, bySec = {}, rows = [];
    state.sections.forEach(function (s) { bySec[s.name] = { s: s, n: 0, att: 0, ok: 0, bad: 0, na: 0, drop: 0, marks: 0, max: 0 }; });
    state.sheet.questions.forEach(function (q, i) {
      var b = bySec[q.section], s = b.s, res, marks = 0;
      b.n++; b.max += s.right;
      if (!q.right.length) {
        res = bonus ? "bonus" : "nokey"; if (bonus) { marks = s.right; b.drop++; } else { b.max -= s.right; b.drop++; }
        if (q.chosen) b.att++; else b.na++;
      } else if (!q.chosen) { res = "na"; b.na++; }
      else if (q.right.indexOf(q.chosen) >= 0) { res = "ok"; marks = s.right; b.ok++; b.att++; }
      else { res = "bad"; marks = -s.wrong; b.bad++; b.att++; }
      b.marks += marks;
      rows.push({ i: i + 1, q: q, res: res, marks: marks });
    });
    var tot = { n: 0, att: 0, ok: 0, bad: 0, na: 0, drop: 0, marks: 0, max: 0 };
    state.sections.forEach(function (s) {
      var b = bySec[s.name]; if (!s.counted) return;
      Object.keys(tot).forEach(function (k) { tot[k] += b[k]; });
    });
    return { bySec: bySec, rows: rows, tot: tot };
  }

  // ---------- view ----------
  function fmt(x) { x = Math.round(x * 100) / 100; return (Object.is(x, -0) ? 0 : x).toString(); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function setBusy(msg) { $("ssc-busy").textContent = msg || ""; $("ssc-busy").hidden = !msg; }
  function setErr(msg) { $("ssc-err").innerHTML = msg || ""; $("ssc-err").hidden = !msg; }
  function note(msg) { $("ssc-note").textContent = msg || ""; $("ssc-note").hidden = !msg; }

  function renderScheme() {
    var t = '<thead><tr><th>Section</th><th>Qs</th><th>Correct +</th><th>Wrong −</th><th>Count</th></tr></thead><tbody>';
    var counts = {}; state.sheet.questions.forEach(function (q) { counts[q.section] = (counts[q.section] || 0) + 1; });
    state.sections.forEach(function (s, i) {
      t += '<tr><td class="sec-name">' + esc(s.name) + "</td><td>" + counts[s.name] + '</td><td><input type="number" step="0.01" min="0" data-i="' + i + '" data-k="right" value="' + s.right +
        '" aria-label="Marks for a correct answer in ' + esc(s.name) + '"></td><td><input type="number" step="0.01" min="0" data-i="' + i + '" data-k="wrong" value="' + s.wrong +
        '" aria-label="Marks off for a wrong answer in ' + esc(s.name) + '"></td><td><input type="checkbox" data-i="' + i + '" data-k="counted"' + (s.counted ? " checked" : "") +
        ' aria-label="Count ' + esc(s.name) + ' in the total"></td></tr>';
    });
    $("ssc-sec-edit").innerHTML = t + "</tbody>";
  }

  function render() {
    var r = score(), t = r.tot, info = state.sheet.info, e = examById(state.examId);
    $("ssc-who").textContent = info.name || "Your marks";
    $("ssc-sub").textContent = e.id === "custom" ? (info.subject || "") : e.name + (info.subject && !/^\s*$/.test(info.subject) ? " · " + info.subject : "");
    $("ssc-score").textContent = fmt(t.marks);
    $("ssc-max").textContent = "out of " + fmt(t.max);
    $("ssc-ring").style.setProperty("--pct", (t.max ? Math.max(0, Math.min(100, t.marks / t.max * 100)) : 0).toFixed(1) + "%");
    $("ssc-stats").innerHTML = [["correct", t.ok, "Correct"], ["wrong", t.bad, "Wrong"], ["blank", t.na, "Not answered"], ["skipped", t.att, "Attempted"]].map(function (s) {
      return '<div class="s-' + s[0] + '"><b>' + s[1] + "</b>" + s[2] + "</div>";
    }).join("");
    var same = state.sections.every(function (s) { return s.right === state.sections[0].right && s.wrong === state.sections[0].wrong; });
    var off = state.sections.filter(function (s) { return !s.counted; }).map(function (s) { return s.name; });
    $("ssc-marking").textContent = (same && state.sections.length ? "Marking: +" + fmt(state.sections[0].right) + " for a correct answer, −" + fmt(state.sections[0].wrong) + " for a wrong answer, 0 for not answered."
      : "Marking: each section's own marks (see below), 0 for not answered.") + (off.length ? " Not counted in the total: " + off.join(", ") + "." : "") +
      (t.drop ? " " + t.drop + " question" + (t.drop > 1 ? "s show" : " shows") + " no correct answer" + ($("ssc-bonus").checked ? " (full marks given)." : " (left out).") : "");
    var inf = [["Roll number", info.roll], ["Exam date", info.date], ["Time", info.time], ["Centre", info.centre]].filter(function (x) { return x[1]; });
    $("ssc-info").innerHTML = inf.map(function (x) { return "<span>" + esc(x[0]) + "</span><span>" + esc(x[1]) + "</span>"; }).join("");
    $("ssc-info").hidden = !inf.length;

    var st = "<thead><tr><th>Section</th><th class=\"c-qs\">Qs</th><th>Attempted</th><th>Correct</th><th>Wrong</th><th>Marks</th></tr></thead><tbody>";
    state.sections.forEach(function (s) {
      var b = r.bySec[s.name];
      st += "<tr" + (s.counted ? "" : ' class="muted"') + "><td>" + esc(s.name) + (s.counted ? "" : " <small>(not counted)</small>") + "</td><td class=\"c-qs\">" + b.n + "</td><td>" + b.att + '</td><td class="q-ok">' + b.ok +
        '</td><td class="q-bad">' + b.bad + "</td><td><b>" + fmt(b.marks) + "</b> / " + fmt(b.max) + "</td></tr>";
    });
    st += "</tbody><tfoot><tr><td>Total</td><td class=\"c-qs\">" + t.n + "</td><td>" + t.att + "</td><td>" + t.ok + "</td><td>" + t.bad + "</td><td>" + fmt(t.marks) + " / " + fmt(t.max) + "</td></tr></tfoot>";
    $("ssc-sec").innerHTML = st;

    var LABEL = { ok: ["q-ok", "Correct"], bad: ["q-bad", "Wrong"], na: ["q-na", "Not answered"], bonus: ["q-bonus", "Dropped (full marks)"], nokey: ["q-na", "No answer shown"] };
    var qt = "<thead><tr><th>#</th><th>Section</th><th>Q</th><th>Yours</th><th>Right</th><th>Result</th><th>Marks</th></tr></thead><tbody>";
    r.rows.forEach(function (x) {
      var l = LABEL[x.res];
      qt += "<tr><td>" + x.i + "</td><td>" + esc(short(x.q.section)) + "</td><td>" + x.q.n + "</td><td>" + (x.q.chosen || "–") + "</td><td>" + (x.q.right.join(", ") || "–") +
        '</td><td class="' + l[0] + '">' + l[1] + "</td><td>" + fmt(x.marks) + "</td></tr>";
    });
    $("ssc-qtable").innerHTML = qt + "</tbody>";
    state.last = r;
  }
  function short(s) { return s.length > 28 ? s.slice(0, 26) + "…" : s; }

  function showSheet(sheet) {
    if (!sheet.questions.length) {
      setErr("No questions were found in this file. Use the response sheet page from the SSC link (it lists every question with <i>Chosen Option</i>), saved as a PDF or as a page.");
      return;
    }
    var withKey = sheet.questions.filter(function (q) { return q.right.length; }).length;
    if (!withKey) {
      setErr("The questions were found, but not the correct answers (the green ticks). If you uploaded a PDF, save it again with <b>Background graphics</b> turned on in the print options, or save the page itself (Ctrl+S) and upload that.");
      return;
    }
    setErr("");
    state.sheet = sheet;
    var det = detectExam(sheet.info), sel = $("ssc-exam");
    sel.innerHTML = EXAMS.map(function (e) { return '<option value="' + e.id + '">' + esc(e.name) + "</option>"; }).join("");
    sel.value = det || "cgl1";
    $("ssc-detected").textContent = (det ? "Picked from your response sheet. " : "We couldn't tell the exam from the sheet, so check it. ") +
      sheet.questions.length + " questions found in " + sectionNames(sheet.questions).length + " sections.";
    applyExam(sel.value); renderScheme(); render();
    $("ssc-scheme").hidden = false; $("ssc-result").hidden = false;
    try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {}
    $("ssc-scheme").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ---------- inputs ----------
  async function readFile(file) {
    setErr(""); setBusy("Reading your response sheet…");
    $("ssc-file-label").textContent = file.name;
    try {
      var stream;
      if (window.OMRPdf && window.OMRPdf.isPdf(file)) stream = await pdfToStream(file);
      else {
        var text = await file.text();
        if (/^\s*(From:|MIME-Version|Content-Type: multipart)/i.test(text.slice(0, 2000)) || /\.mht(ml)?$/i.test(file.name)) text = fromMhtml(text);
        stream = htmlToStream(text);
      }
      showSheet(parseStream(stream.text, stream.title));
    } catch (e) {
      console.error(e);
      setErr("Could not read this file. " + esc(e.message || ""));
    } finally { setBusy(""); }
  }

  $("ssc-file").addEventListener("change", function () { if (this.files[0]) readFile(this.files[0]); this.value = ""; });

  $("ssc-fetch").addEventListener("click", async function () {
    var url = clean($("ssc-url").value);
    if (!/^https?:\/\//i.test(url)) { setErr("Paste the full link of your response sheet, starting with https://"); return; }
    if (!/digialm\.com/i.test(url)) { setErr("This doesn't look like an SSC response sheet link (they are on ssc.digialm.com). Check the link, or upload the response sheet PDF below."); return; }
    setErr(""); setBusy("Opening your response sheet…"); this.disabled = true;
    try {
      var r = await fetch(url, { credentials: "omit" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      var s = htmlToStream(await r.text());
      showSheet(parseStream(s.text, s.title));
    } catch (e) {
      setErr("Your response sheet site does not allow other websites to open the link directly, so it couldn't be read from here. " +
        "Open the link, save the page as a PDF (steps below) and upload it, or use the one-click bookmark on a computer.");
      $("ssc-how").open = true;
    } finally { setBusy(""); this.disabled = false; }
  });

  // One-click bookmark: run on the response sheet page, it opens this page and hands over the page.
  var here = location.origin + location.pathname;
  $("ssc-bm").href = "javascript:(function(){var h=document.documentElement.outerHTML,w=window.open(" + JSON.stringify(here + "#from-bookmark") +
    ");if(!w){alert('Please allow pop-ups for this site and click the bookmark again.');return}function f(e){if(e.source===w&&e.data==='ssc-ready'){w.postMessage({sscSheet:h,title:document.title},'*');removeEventListener('message',f)}}addEventListener('message',f)})()";
  $("ssc-bm").addEventListener("click", function (e) { e.preventDefault(); note(""); setErr("Drag this button to your bookmarks bar (don't click it here). Then open your response sheet and click the bookmark there."); });
  window.addEventListener("message", function (e) {
    if (!e.data || typeof e.data.sscSheet !== "string") return;
    var s = htmlToStream(e.data.sscSheet);
    showSheet(parseStream(s.text, e.data.title || s.title));
  });
  if (/from-bookmark/.test(location.hash) && window.opener) { try { window.opener.postMessage("ssc-ready", "*"); } catch (e) {} }

  // ---------- marking edits ----------
  $("ssc-exam").addEventListener("change", function () { applyExam(this.value); renderScheme(); render(); });
  function setAll() {
    var rt = parseFloat($("ssc-all-right").value), wr = parseFloat($("ssc-all-wrong").value);
    state.sections.forEach(function (s) { if (!isNaN(rt)) s.right = rt; if (!isNaN(wr)) s.wrong = Math.abs(wr); });
    renderScheme(); render();
  }
  $("ssc-all-right").addEventListener("input", setAll);
  $("ssc-all-wrong").addEventListener("input", setAll);
  $("ssc-sec-edit").addEventListener("input", function (e) {
    var el = e.target, s = state.sections[+el.dataset.i]; if (!s) return;
    if (el.dataset.k === "counted") s.counted = el.checked;
    else { var v = parseFloat(el.value); if (!isNaN(v)) s[el.dataset.k] = Math.abs(v); }
    render();
  });
  $("ssc-sec-edit").addEventListener("change", function (e) { if (e.target.dataset.k === "counted") { state.sections[+e.target.dataset.i].counted = e.target.checked; render(); } });
  $("ssc-bonus").addEventListener("change", render);
  $("ssc-again").addEventListener("click", function () {
    $("ssc-result").hidden = true; $("ssc-scheme").hidden = true; $("ssc-url").value = ""; $("ssc-file-label").textContent = "Upload the response sheet PDF or saved page";
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  // ---------- print and PDF ----------
  $("ssc-print").addEventListener("click", function () {
    var d = $("ssc-qs"), was = d.open; d.open = true;
    var done = function () { d.open = was; window.removeEventListener("afterprint", done); };
    window.addEventListener("afterprint", done);
    window.print();
  });

  function loadJsPDF() {
    if (window.jspdf) return Promise.resolve(window.jspdf);
    return new Promise(function (ok, fail) {
      var s = document.createElement("script"); s.src = JSPDF_URL; s.onload = function () { ok(window.jspdf); };
      s.onerror = function () { fail(new Error("Could not load the PDF maker.")); }; document.head.appendChild(s);
    });
  }
  function ascii(s) { return String(s == null ? "" : s).replace(/[−–—]/g, "-").replace(/[^\x20-\x7e]/g, ""); }

  $("ssc-pdf").addEventListener("click", async function () {
    var btn = this; btn.disabled = true; note("");
    try {
      var lib = await loadJsPDF(), doc = new lib.jsPDF({ unit: "mm", format: "a4" }), r = state.last, info = state.sheet.info, e = examById(state.examId);
      var y = 0;
      doc.setFillColor(124, 58, 237); doc.rect(0, 0, 210, 30, "F");
      doc.setFillColor(219, 39, 119); doc.rect(105, 0, 105, 30, "F");
      doc.setTextColor(255, 255, 255); doc.setFont("helvetica", "bold"); doc.setFontSize(18);
      doc.text("SSC marks", 15, 14); doc.setFontSize(11); doc.setFont("helvetica", "normal");
      doc.text(ascii(e.id === "custom" ? info.subject || "" : e.name), 15, 22);
      doc.setFont("helvetica", "bold"); doc.setFontSize(22);
      doc.text(fmt(r.tot.marks) + " / " + fmt(r.tot.max), 195, 18, { align: "right" });
      y = 40; doc.setTextColor(27, 31, 59); doc.setFontSize(10);
      [["Name", info.name], ["Roll number", info.roll], ["Exam", info.subject], ["Date", [info.date, info.time].filter(Boolean).join("  ")], ["Centre", info.centre]].forEach(function (x) {
        if (!x[1]) return;
        doc.setFont("helvetica", "bold"); doc.text(x[0], 15, y); doc.setFont("helvetica", "normal");
        var l = doc.splitTextToSize(ascii(x[1]), 145); doc.text(l, 45, y); y += 5.5 * l.length;
      });
      y += 4;
      var cols = [15, 105, 122, 142, 160, 178];
      doc.setFont("helvetica", "bold"); doc.setTextColor(95, 103, 135);
      ["Section", "Qs", "Attempted", "Correct", "Wrong", "Marks"].forEach(function (h, i) { doc.text(h, cols[i], y); });
      y += 2; doc.setDrawColor(220, 214, 240); doc.line(15, y, 195, y); y += 5;
      doc.setFont("helvetica", "normal"); doc.setTextColor(27, 31, 59);
      state.sections.forEach(function (s) {
        var b = r.bySec[s.name], l = doc.splitTextToSize(ascii(s.name) + (s.counted ? "" : " (not counted)"), 86);
        doc.text(l, cols[0], y); doc.text(String(b.n), cols[1], y); doc.text(String(b.att), cols[2], y);
        doc.text(String(b.ok), cols[3], y); doc.text(String(b.bad), cols[4], y); doc.text(fmt(b.marks) + " / " + fmt(b.max), cols[5], y);
        y += 5 * l.length + 1.5;
      });
      doc.line(15, y - 3, 195, y - 3); y += 2;
      doc.setFont("helvetica", "bold");
      doc.text("Total", cols[0], y); doc.text(String(r.tot.n), cols[1], y); doc.text(String(r.tot.att), cols[2], y);
      doc.text(String(r.tot.ok), cols[3], y); doc.text(String(r.tot.bad), cols[4], y); doc.text(fmt(r.tot.marks) + " / " + fmt(r.tot.max), cols[5], y);
      y += 9; doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(95, 103, 135);
      var ml = doc.splitTextToSize(ascii($("ssc-marking").textContent) + " This is an unofficial estimate from the response sheet; SSC's final answer key, normalisation and results are what count.", 180);
      doc.text(ml, 15, y); y += ml.length * 4.5 + 6;

      // question by question, 4 columns
      doc.addPage(); doc.setFontSize(13); doc.setFont("helvetica", "bold"); doc.setTextColor(27, 31, 59);
      doc.text("Question by question", 15, 15);
      var COL = { ok: [21, 128, 61], bad: [220, 38, 38], na: [95, 103, 135], bonus: [3, 105, 161], nokey: [95, 103, 135] };
      var WORD = { ok: "right", bad: "wrong", na: "-", bonus: "dropped", nokey: "no key" };
      var per = 50, top = 24;
      r.rows.forEach(function (x, i) {
        if (i && i % (per * 4) === 0) { doc.addPage(); top = 15; }
        var k = i % (per * 4), col = Math.floor(k / per), row = k % per, cx = 15 + col * 46, cy = top + row * 5.2;
        if (row === 0) {
          doc.setFontSize(7.5); doc.setFont("helvetica", "bold"); doc.setTextColor(95, 103, 135);
          doc.text("#", cx, cy - 4); doc.text("You", cx + 8, cy - 4); doc.text("Key", cx + 16, cy - 4); doc.text("Result", cx + 24, cy - 4);
          doc.setFont("helvetica", "normal");
        }
        doc.setTextColor(27, 31, 59); doc.text(String(x.i), cx, cy); doc.text(x.q.chosen || "-", cx + 8, cy); doc.text(x.q.right.join(",") || "-", cx + 16, cy);
        var c = COL[x.res]; doc.setTextColor(c[0], c[1], c[2]); doc.text(WORD[x.res] + " (" + fmt(x.marks) + ")", cx + 24, cy);
      });
      var name = "ssc-marks" + (info.roll ? "-" + ascii(info.roll).replace(/[^A-Za-z0-9]/g, "") : "") + ".pdf";
      var blob = doc.output("blob"), a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 30000);
      note("Your marks PDF has been downloaded. Look for it in your Downloads or Files app.");
    } catch (err) {
      console.error(err); note("Could not make the PDF. Check your internet connection and try again.");
    } finally { btn.disabled = false; }
  });

  window.SSCMarks = { parseStream: parseStream, htmlToStream: htmlToStream, fromMhtml: fromMhtml, detectExam: detectExam, readFile: readFile };
})();
