// Admin page for the GitHub Pages site. Everything is saved as commits to the site's GitHub
// repository (using the admin's own access token), and the Pages workflow republishes the site.
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var API = "https://api.github.com";
  var S = { repo: "", token: "", branch: "main", cfg: null, keys: {} };   // keys: {subject: {set: {q: ans}}}
  var bulk = [];

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function msg(id, text, kind) { var e = $(id); e.textContent = text || ""; e.className = kind || ""; }
  function store(k, v) { try { if (v == null) { localStorage.removeItem(k); sessionStorage.removeItem(k); } else ($("gh-remember").checked ? localStorage : sessionStorage).setItem(k, v); } catch (e) {} }
  function recall(k) { try { return localStorage.getItem(k) || sessionStorage.getItem(k); } catch (e) { return null; } }
  function utf8b64decode(b) { var bin = atob(b.replace(/\n/g, "")), a = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return new TextDecoder().decode(a); }
  function fmt(x) { return (Math.round(x * 100) / 100).toString(); }

  // ---------- GitHub ----------
  async function gh(path, opts) {
    opts = opts || {};
    var res = await fetch(API + "/repos/" + S.repo + path, {
      method: opts.method || "GET", cache: "no-store",
      headers: { Authorization: "Bearer " + S.token, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    if (!res.ok) {
      var detail = ""; try { detail = (await res.json()).message || ""; } catch (e) {}
      var err = new Error("GitHub said " + res.status + (detail ? ": " + detail : "")); err.status = res.status; throw err;
    }
    return res.status === 204 ? null : res.json();
  }
  async function readFile(path) {
    try { return utf8b64decode((await gh("/contents/" + path.split("/").map(encodeURIComponent).join("/") + "?ref=" + encodeURIComponent(S.branch))).content); }
    catch (e) { if (e.status === 404) return null; throw e; }
  }
  // Commit several files (path -> text, or null to delete) in one commit.
  async function commit(files, message) {
    for (var attempt = 0; attempt < 3; attempt++) {
      var ref = await gh("/git/ref/heads/" + S.branch);
      var head = await gh("/git/commits/" + ref.object.sha);
      var tree = await gh("/git/trees", { method: "POST", body: { base_tree: head.tree.sha, tree: Object.keys(files).map(function (p) {
        return files[p] == null ? { path: p, mode: "100644", type: "blob", sha: null } : { path: p, mode: "100644", type: "blob", content: files[p] };
      }) } });
      var c = await gh("/git/commits", { method: "POST", body: { message: message, tree: tree.sha, parents: [ref.object.sha] } });
      try { await gh("/git/refs/heads/" + S.branch, { method: "PATCH", body: { sha: c.sha } }); return c.sha; }
      catch (e) { if (e.status !== 422 || attempt === 2) throw e; }   // someone else committed meanwhile: retry on top
    }
  }

  // ---------- connect ----------
  async function connect() {
    S.repo = $("gh-repo").value.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
    S.token = $("gh-token").value.trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(S.repo)) { msg("gh-status", "Enter the repository as owner/name.", "bad"); return; }
    if (!S.token) { msg("gh-status", "Paste your GitHub access token.", "bad"); return; }
    $("gh-connect").disabled = true; msg("gh-status", "Connecting…");
    try {
      var info = await gh("");
      if (info.permissions && !info.permissions.push) throw new Error("This token can read the repository but not change it. Give it Contents: Read and write.");
      S.branch = info.default_branch || "main";
      await loadData();
      store("omr-gh-repo", S.repo); store("omr-gh-token", S.token);
      msg("gh-status", "Connected to " + info.full_name + ".", "ok");
      $("admin").hidden = false; $("gh-forget").hidden = false;
      OMREngine.load().catch(function () {});   // warm up the scanner in the background
    } catch (e) {
      console.error(e);
      msg("gh-status", e.status === 401 ? "GitHub did not accept this token. Check it was copied in full and has not expired." :
        e.status === 404 ? "Repository not found, or the token has no access to it." : (e.message || "Could not connect."), "bad");
    } finally { $("gh-connect").disabled = false; }
  }

  async function loadData() {
    S.cfg = JSON.parse(await readFile("config.json"));
    var tree = await gh("/git/trees/" + S.branch + "?recursive=1");
    var paths = tree.tree.filter(function (t) { return t.type === "blob" && /^keys\/[\w-]+\/[\w-]+\.txt$/.test(t.path); });
    var files = { "config.json": JSON.stringify(S.cfg, null, 2) };
    S.keys = {};
    await Promise.all(paths.map(async function (t) {
      var text = utf8b64decode((await gh("/git/blobs/" + t.sha)).content);
      files[t.path] = text;
      var parts = t.path.split("/");
      (S.keys[parts[1]] = S.keys[parts[1]] || {})[parts[2].replace(/\.txt$/, "")] = parseSimple(text);
    }));
    await OMREngine.setFiles(files);
    renderAll();
  }
  // Saved key files are always "q answer" per line (written by key_to_text).
  function parseSimple(text) {
    var k = {}; text.split(/\n/).forEach(function (ln) { var m = ln.trim().match(/^(\d+)\s+(\S+)$/); if (m) k[m[1]] = m[2]; }); return k;
  }

  function renderAll() {
    var c = S.cfg;
    ["key-subject", "bulk-subject"].forEach(function (id) {
      var sel = $(id), v = sel.value;
      sel.innerHTML = c.subjects.map(function (s) { return '<option value="' + esc(s.id) + '">' + esc(s.name) + "</option>"; }).join("");
      if (v && c.subjects.some(function (s) { return s.id === v; })) sel.value = v;
    });
    $("key-set").innerHTML = c.set_codes.map(function (s) { return "<option>" + esc(s) + "</option>"; }).join("");
    $("keys-status").innerHTML = "<tr><th>Subject</th>" + c.set_codes.map(function (s) { return "<th>" + esc(s) + "</th>"; }).join("") + "</tr>" +
      c.subjects.map(function (s) {
        return "<tr><td style='text-align:left'>" + esc(s.short || s.name) + "</td>" + c.set_codes.map(function (code) {
          var n = Object.keys((S.keys[s.id] || {})[code] || {}).length;
          return '<td class="' + (n >= c.num_questions ? "ok" : n ? "warn" : "bad") + '">' + (n || "–") + "</td>";
        }).join("") + "</tr>";
      }).join("");
    $("subj-table").innerHTML = "<tr><th>Name</th><th>Short</th><th>Answer-key page</th></tr>" + c.subjects.map(function (s) {
      return "<tr><td>" + esc(s.name) + "</td><td>" + esc(s.short || "") + "</td><td class='muted'>" + esc(s.slug) + "</td></tr>";
    }).join("");
  }

  // ---------- tabs ----------
  Array.prototype.forEach.call(document.querySelectorAll(".tabbar button"), function (b) {
    b.addEventListener("click", function () {
      Array.prototype.forEach.call(document.querySelectorAll(".tabbar button"), function (x) { x.classList.toggle("on", x === b); });
      Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (t) { t.hidden = t.id !== b.dataset.tab; });
    });
  });

  // ---------- answer keys ----------
  function keyMode() { return document.querySelector("input[name=key-mode]:checked").value; }
  Array.prototype.forEach.call(document.querySelectorAll("input[name=key-mode]"), function (r) {
    r.addEventListener("change", function () {
      $("key-set-wrap").hidden = keyMode() !== "one";
      $("key-help").textContent = keyMode() === "one"
        ? "The answers for one set: either one digit per question in order (3342212…), or one numbered answer per line (1 3, 2 4, …). Saving replaces this set's whole key. Use 23 when two options are accepted and X for a dropped question."
        : "One row per question: question number, then the answer for each set (" + S.cfg.set_codes.join(" ") + "), as in the published key PDF. Rows you leave out keep their saved answer. Use 23 when two options are accepted and X for a dropped question.";
    });
  });
  async function prepareKeys() {
    var subject = $("key-subject").value, text = $("key-text").value;
    if (!text.trim()) throw new Error("Paste the answers first.");
    msg("key-msg", OMREngine.isLoaded() ? "Checking…" : "Loading the checker (first time only)…");
    var changes = {};
    if (keyMode() === "table") {
      var t = await OMREngine.call("omr_parse_table", text);
      if (t.error) throw new Error(t.error);
      Object.keys(t.keys).forEach(function (set) {
        if (!Object.keys(t.keys[set]).length) return;
        changes[set] = Object.assign({}, (S.keys[subject] || {})[set] || {}, t.keys[set]);
      });
    } else {
      var k = await OMREngine.call("omr_parse_key", text);
      if (k.error) throw new Error(k.error);
      if (!Object.keys(k.key).length) throw new Error("No answers found.");
      changes[$("key-set").value] = k.key;
    }
    return { subject: subject, changes: changes };
  }
  function describe(p) {
    var n = S.cfg.num_questions;
    return Object.keys(p.changes).map(function (set) { var c = Object.keys(p.changes[set]).length; return set + ": " + c + " of " + n + " answers"; }).join(" · ");
  }
  $("key-check").addEventListener("click", async function () {
    try { var p = await prepareKeys(); msg("key-msg", "Looks good. After saving: " + describe(p) + ".", "ok"); }
    catch (e) { msg("key-msg", e.message, "bad"); }
  });
  $("key-save").addEventListener("click", async function () {
    var btn = this; btn.disabled = true;
    try {
      var p = await prepareKeys(), files = {};
      for (var set in p.changes) files["keys/" + p.subject + "/" + set + ".txt"] = await OMREngine.keyText(p.changes[set]);
      msg("key-msg", "Saving…");
      var name = (S.cfg.subjects.filter(function (s) { return s.id === p.subject; })[0] || {}).name || p.subject;
      await commit(files, "Update answer keys: " + name + " (" + Object.keys(p.changes).join(", ") + ")");
      S.keys[p.subject] = S.keys[p.subject] || {};
      for (set in p.changes) S.keys[p.subject][set] = p.changes[set];
      await OMREngine.setFiles(files);
      renderAll();
      msg("key-msg", "Saved " + describe(p) + ". The website will show the new key in about 1 to 2 minutes.", "ok");
      $("key-text").value = "";
    } catch (e) { console.error(e); msg("key-msg", e.message, "bad"); }
    finally { btn.disabled = false; }
  });

  // ---------- subjects ----------
  $("subj-add").addEventListener("click", async function () {
    var name = $("new-name").value.trim(), short = $("new-short").value.trim() || name;
    if (name.length < 3) { msg("subj-msg", "Enter the subject's full name.", "bad"); return; }
    var id = short.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 30) || "subject";
    var base = id, i = 2;
    while (S.cfg.subjects.some(function (s) { return s.id === id; })) id = base + "_" + i++;
    if (S.cfg.subjects.some(function (s) { return s.name.toLowerCase() === name.toLowerCase(); })) { msg("subj-msg", "There is already a subject with that name.", "bad"); return; }
    var btn = this; btn.disabled = true; msg("subj-msg", "Saving…");
    try {
      var latest = JSON.parse(await readFile("config.json"));   // re-read so nothing else in config is lost
      latest.subjects.push({ id: id, name: name, short: short, slug: id.replace(/_/g, "-") + "-answer-key" });
      var text = JSON.stringify(latest, null, 2) + "\n";
      await commit({ "config.json": text }, "Add subject: " + name);
      S.cfg = latest; await OMREngine.setFiles({ "config.json": text }); renderAll();
      $("new-name").value = ""; $("new-short").value = "";
      msg("subj-msg", "Added " + name + ". Now add its answer keys in the Answer keys tab. It appears on the website in about 1 to 2 minutes.", "ok");
    } catch (e) { console.error(e); msg("subj-msg", e.message, "bad"); }
    finally { btn.disabled = false; }
  });

  // ---------- bulk scan ----------
  $("bulk-files").addEventListener("change", function () {
    var n = this.files.length;
    $("bulk-pick").innerHTML = '<span class="cam" aria-hidden="true">🗂️</span>' + (n ? n + " photo" + (n > 1 ? "s" : "") + " selected. Tap to change." : "Choose photos (you can select many at once)");
  });
  function rowStatus(r) {
    if (r.scan_error) return ["bad", r.scan_error];
    if (r.error) return ["bad", r.error];
    if (OMRCrypto.digits(r.register_number).length !== 9) return ["warn", "Check the register number"];
    if (OMRCrypto.digits(r.booklet_serial).length !== 6) return ["warn", "Check the booklet number"];
    return ["ok", "Ready"];
  }
  function renderBulk() {
    var seen = {};
    bulk.forEach(function (r) { var k = OMRCrypto.digits(r.register_number) + ":" + OMRCrypto.digits(r.booklet_serial); r.dup = !!seen[k]; seen[k] = 1; });
    $("bulk-table").innerHTML = "<tr><th>#</th><th>Photo</th><th>Register no.</th><th>Booklet no.</th><th>Name</th><th>Set</th><th>Score</th><th>Status</th></tr>" +
      bulk.map(function (r, i) {
        var st = r.dup ? ["warn", "Same numbers as an earlier sheet"] : rowStatus(r);
        return "<tr><td>" + (i + 1) + "</td><td>" + esc(r.file) + "</td>" +
          '<td><input data-i="' + i + '" data-f="register_number" inputmode="numeric" value="' + esc(r.register_number || "") + '"></td>' +
          '<td><input data-i="' + i + '" data-f="booklet_serial" inputmode="numeric" value="' + esc(r.booklet_serial || "") + '"></td>' +
          '<td><input data-i="' + i + '" data-f="name" value="' + esc(r.name || "") + '" placeholder="Optional"></td>' +
          "<td>" + esc(r.version || "–") + "</td><td>" + (r.grading ? fmt(r.grading.score) + " / " + fmt(r.grading.max_score) : "–") + "</td>" +
          '<td class="' + st[0] + '">' + esc(st[1]) + "</td></tr>";
      }).join("");
    var ready = bulk.filter(function (r) { return !r.dup && rowStatus(r)[0] === "ok"; }).length;
    $("bulk-publish").disabled = !ready; $("bulk-csv").disabled = !bulk.length;
    $("bulk-publish").textContent = ready ? "Publish " + ready + " result" + (ready > 1 ? "s" : "") : "Publish results";
  }
  $("bulk-table").addEventListener("change", function (ev) {
    var t = ev.target; if (!t.dataset || t.dataset.i == null) return;
    bulk[+t.dataset.i][t.dataset.f] = t.dataset.f === "name" ? t.value.trim().slice(0, 80) : OMRCrypto.digits(t.value);
    renderBulk();
  });
  $("bulk-scan").addEventListener("click", async function () {
    var files = Array.prototype.slice.call($("bulk-files").files), subject = $("bulk-subject").value;
    if (!files.length) { msg("bulk-msg", "Choose the OMR sheet photos first.", "bad"); return; }
    var btn = this; btn.disabled = true; msg("bulk-msg", ""); bulk = []; renderBulk();
    $("bulk-progress").hidden = false; var bar = $("bulk-progress").firstElementChild; bar.style.width = "0";
    try {
      if (!OMREngine.isLoaded()) $("bulk-status").textContent = "Loading the scanner (first time only)…";
      await OMREngine.load();
      for (var i = 0; i < files.length; i++) {
        $("bulk-status").textContent = "Reading sheet " + (i + 1) + " of " + files.length + "…";
        await new Promise(function (r) { setTimeout(r, 10); });
        var r;
        try { r = await OMREngine.call("omr_run", new Uint8Array(await files[i].arrayBuffer()), subject, "", false); }
        catch (e) { console.error(e); r = { scan_error: "Could not read this photo" }; }
        r.file = files[i].name; bulk.push(r);
        bar.style.width = ((i + 1) / files.length * 100).toFixed(1) + "%";
        renderBulk();
      }
      var ok = bulk.filter(function (r) { return r.grading; }).length;
      $("bulk-status").textContent = "Read " + files.length + " sheet" + (files.length > 1 ? "s" : "") + ": " + ok + " scored, " + (files.length - ok) + " need a look.";
    } catch (e) { console.error(e); msg("bulk-msg", "The scanner could not load. Check the internet connection and try again.", "bad"); }
    finally { btn.disabled = false; }
  });
  $("bulk-csv").addEventListener("click", function () {
    var head = ["photo", "subject", "register_number", "booklet_serial", "name", "set", "score", "max_score", "correct", "wrong", "not_attempted", "blank", "multiple", "status"];
    var lines = [head.join(",")].concat(bulk.map(function (r) {
      var g = r.grading || {}, c = g.counts || {};
      return [r.file, r.subject_name, r.register_number, r.booklet_serial, r.name, r.version, g.score, g.max_score, c.correct, c.wrong, c.skipped, c.blank, c.multiple,
        r.dup ? "duplicate" : rowStatus(r)[1]].map(function (v) { v = v == null ? "" : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(",");
    }));
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + lines.join("\n")], { type: "text/csv" }));
    a.download = "omr-results-" + $("bulk-subject").value + ".csv"; document.body.appendChild(a); a.click(); a.remove();
  });
  $("bulk-publish").addEventListener("click", async function () {
    var rows = bulk.filter(function (r) { return !r.dup && rowStatus(r)[0] === "ok"; });
    if (!rows.length) return;
    var btn = this; btn.disabled = true;
    try {
      var files = {}, when = new Date().toISOString().slice(0, 10);
      for (var i = 0; i < rows.length; i++) {
        msg("bulk-msg", "Locking result " + (i + 1) + " of " + rows.length + "…");
        var r = rows[i];
        var pub = { subject: r.subject, subject_name: r.subject_name, name: r.name || "", version: r.version, register_number: r.register_number,
          booklet_serial: r.booklet_serial, register_complete: true, grading: r.grading, error: null, marking: r.marking, five: r.five, published: when };
        var sealed = await OMRCrypto.seal(pub, r.register_number, r.booklet_serial);
        files["published/results/" + sealed.id + ".json"] = sealed.body;
      }
      msg("bulk-msg", "Saving to the website…");
      await commit(files, "Publish " + rows.length + " result" + (rows.length > 1 ? "s" : "") + ": " + rows[0].subject_name);
      msg("bulk-msg", "Published " + rows.length + " result" + (rows.length > 1 ? "s" : "") + ". Candidates can look them up on the Results page in about 1 to 2 minutes.", "ok");
    } catch (e) { console.error(e); msg("bulk-msg", e.message, "bad"); }
    finally { btn.disabled = false; }
  });

  // ---------- start ----------
  $("gh-connect").addEventListener("click", connect);
  $("gh-forget").addEventListener("click", function () {
    store("omr-gh-token", null); S.token = ""; $("gh-token").value = ""; $("admin").hidden = true; this.hidden = true;
    msg("gh-status", "Disconnected. The token was removed from this device.");
  });
  var savedRepo = recall("omr-gh-repo"), savedToken = recall("omr-gh-token");
  try { $("gh-remember").checked = !!localStorage.getItem("omr-gh-token"); } catch (e) {}
  $("gh-repo").value = savedRepo || (window.OMR_SITE && window.OMR_SITE.repo) || "";
  if (savedToken) { $("gh-token").value = savedToken; connect(); }
})();
