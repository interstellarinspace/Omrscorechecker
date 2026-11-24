(function () {
  "use strict";
  var API = (window.OMR_API_BASE || window.location.origin).replace(/\/$/, "");
  var Cap = window.Capacitor;
  var isNative = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
  var Camera = isNative && Cap.Plugins ? Cap.Plugins.Camera : null;
  var $ = function (id) { return document.getElementById(id); };
  var photo = null; // Blob
  var config = null;

  function show(el, on) { el.hidden = !on; }
  function fmt(x) { return (Math.round(x * 100) / 100).toString(); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function formError(msg) { $("form-error").textContent = msg; show($("form-error"), !!msg); if (msg) window.scrollTo(0, 0); }
  function updateButton() { $("check").disabled = !(photo && $("subject").value); }

  function loadConfig() {
    fetch(API + "/api/config").then(function (r) { return r.json(); }).then(function (c) {
      config = c;
      $("exam-title").textContent = c.exam_title || "";
      var sel = $("subject");
      sel.innerHTML = '<option value="">Choose your paper</option>';
      c.subjects.forEach(function (s) {
        var o = document.createElement("option"); o.value = s.id; o.textContent = s.name; sel.appendChild(o);
      });
      try { var last = localStorage.getItem("omr_subject"); if (last) sel.value = last; } catch (e) {}
      updateButton();
    }).catch(function () {
      formError("Could not reach the scoring server. Check your internet connection and try again.");
      setTimeout(loadConfig, 5000);
    });
  }

  // Shrink big camera photos before upload (keeps ~2000 px on the long side).
  function shrink(blob) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        var max = 2000, w = img.naturalWidth, h = img.naturalHeight, s = Math.min(1, max / Math.max(w, h));
        if (s === 1) { resolve(blob); return; }
        var c = document.createElement("canvas"); c.width = Math.round(w * s); c.height = Math.round(h * s);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        c.toBlob(function (b) { resolve(b || blob); }, "image/jpeg", 0.9);
      };
      img.onerror = function () { resolve(blob); };
      img.src = URL.createObjectURL(blob);
    });
  }

  function setPhoto(blob) {
    return shrink(blob).then(function (b) {
      photo = b;
      var p = $("preview"); p.src = URL.createObjectURL(b); show(p, true); show($("pick-text"), false);
      formError(""); updateButton();
    });
  }

  $("pick").addEventListener("click", function () {
    if (!Camera) { $("file").click(); return; }
    Camera.getPhoto({ quality: 90, resultType: "uri", source: "PROMPT", correctOrientation: true,
                      promptLabelHeader: "Answer sheet", promptLabelPhoto: "Choose from gallery",
                      promptLabelPicture: "Take photo", width: 2000 })
      .then(function (p) { return fetch(p.webPath).then(function (r) { return r.blob(); }); })
      .then(setPhoto)
      .catch(function (e) { if (!/cancel/i.test(String(e && e.message))) formError("Could not get the photo: " + (e && e.message || e)); });
  });
  $("file").addEventListener("change", function () { if (this.files[0]) setPhoto(this.files[0]); });
  $("subject").addEventListener("change", function () {
    try { localStorage.setItem("omr_subject", this.value); } catch (e) {}
    updateButton();
  });

  $("check").addEventListener("click", function () {
    var fd = new FormData();
    fd.append("subject", $("subject").value);
    fd.append("name", $("name").value.trim());
    fd.append("sheet", photo, "sheet.jpg");
    $("check").disabled = true; show($("busy"), true); formError("");
    fetch(API + "/api/scan", { method: "POST", body: fd })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) {
        if (!x.ok) { formError(x.j.error || "Something went wrong. Please try again."); return; }
        render(x.j);
      })
      .catch(function () { formError("Could not reach the scoring server. Check your internet connection and try again."); })
      .then(function () { show($("busy"), false); updateButton(); });
  });

  function render(r) {
    var g = r.grading, m = (config && config.marking) || {}, five = (config && config.not_attempted_option) || "5";
    $("res-error").textContent = r.error || ""; show($("res-error"), !!r.error);
    $("res-meta").innerHTML = esc(r.subject_name) + (r.name ? " · " + esc(r.name) : "") + "<br>Version <b>" + esc(r.version || "?") +
      "</b> · Register no. <b>" + esc(r.register_number) + "</b> · Booklet <b>" + esc(r.booklet_serial) + "</b>";
    show($("res-score"), !!g); show($("res-stats"), !!g); show($("res-marking"), !!g);
    if (g) {
      $("res-score").textContent = fmt(g.score) + " / " + fmt(g.max_score);
      var c = g.counts;
      $("res-stats").innerHTML =
        '<div><b class="r-correct">' + c.correct + '</b>Correct</div><div><b class="r-wrong">' + c.wrong + '</b>Wrong</div>' +
        "<div><b>" + c.skipped + "</b>Option " + esc(five) + "</div><div><b>" + c.blank + "</b>Blank</div>" +
        '<div><b class="r-multiple">' + c.multiple + "</b>Multiple</div>";
      $("res-marking").textContent = "Marking: +" + fmt(m.correct) + " correct, " + fmt(m.wrong) + " wrong, " + fmt(m.skipped) +
        " for option " + five + " (not attempted), " + fmt(m.blank) + " for no bubble shaded, " + fmt(m.multiple) + " for more than one shaded.";
    }
    show($("res-image-card"), !!r.annotated_b64);
    if (r.annotated_b64) $("res-image").src = "data:image/jpeg;base64," + r.annotated_b64;
    var rows = g && g.questions ? g.questions.filter(function (q) { return q.result !== "no_key"; }) : [];
    show($("res-table-card"), rows.length > 0);
    $("res-table").innerHTML = "<tr><th>Q</th><th>Yours</th><th>Key</th><th>Result</th><th>Marks</th></tr>" + rows.map(function (q) {
      var given = q.given === "*" ? "multiple" : (q.given || "–");
      var res = q.result === "skipped" ? "not attempted" : q.result;
      return "<tr><td>" + q.q + "</td><td>" + esc(given) + "</td><td>" + esc(q.key || "dropped") + '</td><td class="r-' + q.result + '">' +
        esc(res) + "</td><td>" + fmt(q.marks) + "</td></tr>";
    }).join("");
    show($("form-view"), false); show($("result-view"), true); window.scrollTo(0, 0);
  }

  $("again").addEventListener("click", function () {
    photo = null; $("file").value = ""; show($("preview"), false); show($("pick-text"), true);
    show($("result-view"), false); show($("form-view"), true); updateButton(); window.scrollTo(0, 0);
  });

  loadConfig();
})();
