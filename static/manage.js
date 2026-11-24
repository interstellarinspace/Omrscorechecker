// Admin page for the GitHub Pages site. Everything is saved as commits to the site's GitHub
// repository (using the admin's own access token), and the Pages workflow republishes the site.
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var API = "https://api.github.com";
  var S = { repo: "", token: "", branch: "main", cfg: null, keys: {}, vault: null, index: [], tree: {} };
  // keys: {subject: {set: {q: ans}}}; vault: AES key from the admin passphrase; index: admin's list of published sheets
  var INDEX = "admin/index.bin", VAULT = "admin/vault.json";
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
      var text = "GitHub said " + res.status + (detail ? ": " + detail : "");
      if (res.status === 403 && /not accessible by (personal access|integration)/i.test(detail))
        text = (opts.method && opts.method !== "GET")
          ? "Your token can read the repository but is not allowed to save to it. Edit the token on GitHub and set Repository permissions › Contents to \"Read and write\" (and make sure this repository is selected), then sign in again."
          : "Your token has no access to this repository. Edit the token on GitHub: under Repository access choose \"Only select repositories\" and add " + S.repo + ", set Contents to \"Read and write\", then sign in again.";
      var err = new Error(text); err.status = res.status; throw err;
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
        var f = files[p];
        return f == null ? { path: p, mode: "100644", type: "blob", sha: null }
          : typeof f === "string" ? { path: p, mode: "100644", type: "blob", content: f } : { path: p, mode: "100644", type: "blob", sha: f.sha };
      }) } });
      var c = await gh("/git/commits", { method: "POST", body: { message: message, tree: tree.sha, parents: [ref.object.sha] } });
      try { await gh("/git/refs/heads/" + S.branch, { method: "PATCH", body: { sha: c.sha } }); return c.sha; }
      catch (e) { if (e.status !== 422 || attempt === 2) throw e; }   // someone else committed meanwhile: retry on top
    }
  }

  async function putBlob(bytes) {
    return { sha: (await gh("/git/blobs", { method: "POST", body: { content: OMRCrypto.b64(bytes), encoding: "base64" } })).sha };
  }
  async function getBlob(sha) { return OMRCrypto.unb64((await gh("/git/blobs/" + sha)).content.replace(/\n/g, "")); }
  async function loadTree() {
    var t = await gh("/git/trees/" + S.branch + "?recursive=1"); S.tree = {};
    t.tree.forEach(function (e) { if (e.type === "blob") S.tree[e.path] = e.sha; });
  }
  async function loadIndex() {
    S.index = S.tree[INDEX] ? JSON.parse(new TextDecoder().decode(await OMRCrypto.openBytes(S.vault, await getBlob(S.tree[INDEX])))) : [];
  }

  // ---------- connect ----------
  async function connect() {
    S.repo = $("gh-repo").value.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
    S.token = $("gh-token").value.trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(S.repo)) { msg("gh-status", "Enter the repository as owner/name.", "bad"); return; }
    if (!S.token) { msg("gh-status", "Paste your GitHub access token.", "bad"); return; }
    var pass = $("vault-pass").value;
    if (!pass) { msg("gh-status", "Enter the admin passphrase.", "bad"); return; }
    $("gh-connect").disabled = true; msg("gh-status", "Connecting…");
    try {
      var info = await gh("");
      if (info.permissions && !info.permissions.push) throw new Error("This token can read the repository but not change it. Give it Contents: Read and write.");
      S.branch = info.default_branch || "main";
      // Check now that the token may save (creates a tiny unused blob), so a missing permission shows at sign-in.
      await gh("/git/blobs", { method: "POST", body: { content: "omr-admin-write-check", encoding: "utf-8" } });
      await loadTree();
      if (!S.tree[VAULT]) {
        if ($("vault-new").hidden) { $("vault-new").hidden = false; msg("gh-status", "Choose your admin passphrase below, then press Sign in again.", "warn"); return; }
        if (pass.length < 10) throw new Error("Use at least 10 characters for the passphrase.");
        if (pass !== $("vault-pass2").value) throw new Error("The two passphrases are different.");
        var v = await OMRCrypto.newVault(pass);
        await commit({ "admin/vault.json": v.file }, "Set up the admin passphrase");
        S.vault = v.key; $("vault-new").hidden = true; await loadTree();
      } else {
        msg("gh-status", "Unlocking…");
        S.vault = await OMRCrypto.unlockVault(utf8b64decode((await gh("/git/blobs/" + S.tree[VAULT])).content), pass);
        if (!S.vault) throw new Error("Wrong admin passphrase.");
      }
      $("vault-pass").value = ""; $("vault-pass2").value = "";
      await ensureAdminKeys();
      await loadData();
      await loadIndex();
      await mergeInbox();
      showSearch("");
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

  // The KEA fetch job (GitHub Actions) has no passphrase. It encrypts the entries it adds to
  // admin/inbox/ with the admin's public key; they are merged into the admin's list here.
  async function ensureAdminKeys() {
    var v = JSON.parse(utf8b64decode((await gh("/git/blobs/" + S.tree[VAULT])).content));
    if (!v.pub || !v.priv) {
      var k = await OMRCrypto.newAdminKeys(S.vault); v.pub = k.pub; v.priv = k.priv;
      await commit({ "admin/vault.json": JSON.stringify(v) }, "Set up the admin key for automatic KEA fetches");
      await loadTree();
    }
    S.priv = await OMRCrypto.adminPrivate(S.vault, v.priv);
  }
  async function mergeInbox() {
    var paths = Object.keys(S.tree).filter(function (p) { return /^admin\/inbox\/[\w.-]+\.bin$/.test(p); }).sort();
    if (!paths.length || !S.priv) return 0;
    await loadIndex();
    var byRegister = (S.cfg.results_lookup || "register_booklet") === "register", files = {}, added = 0;
    for (var i = 0; i < paths.length; i++) {
      var data;
      try { data = await OMRCrypto.openForAdmin(S.priv, new TextDecoder().decode(await getBlob(S.tree[paths[i]]))); }
      catch (e) { console.error("inbox", paths[i], e); continue; }   // made for another key: leave it
      (data.entries || []).forEach(function (n) {
        S.index = S.index.filter(function (e) {
          var same = e.reg === n.reg && e.subject === n.subject && (byRegister || e.booklet === n.booklet);
          if (same && e.sheet && e.sheet !== n.sheet && S.tree[e.sheet]) files[e.sheet] = null;
          return !same;
        });
        S.index.push(n); added++;
      });
      files[paths[i]] = null;
    }
    if (!Object.keys(files).length) return 0;
    files[INDEX] = await putBlob(await OMRCrypto.sealBytes(S.vault, new TextEncoder().encode(JSON.stringify(S.index))));
    await commit(files, "Add " + added + " sheet" + (added === 1 ? "" : "s") + " fetched from KEA to the admin list");
    await loadTree();
    return added;
  }

  async function loadData() {
    S.cfg = JSON.parse(await readFile("config.json"));
    var paths = Object.keys(S.tree).filter(function (p) { return /^keys\/[\w-]+\/[\w-]+\.txt$/.test(p); }).map(function (p) { return { path: p, sha: S.tree[p] }; });
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

  var SETTINGS = ["num_questions", "options", "not_attempted_option", "set_codes", "marking"];
  function examOf(sid) {
    var s = S.cfg.subjects.filter(function (x) { return x.id === sid; })[0] || {};
    return (S.cfg.exams || []).filter(function (e) { return e.id === s.exam; })[0] || (S.cfg.exams || [])[0] || {};
  }
  function sc(sid) { var e = examOf(sid), o = {}; SETTINGS.forEach(function (k) { o[k] = k in e ? e[k] : S.cfg[k]; }); return o; }
  function subjectOptions(filter) {
    return (S.cfg.exams || []).map(function (e) {
      var subs = S.cfg.subjects.filter(function (s) { return s.exam === e.id && (!filter || filter(e, s)); });
      return subs.length ? '<optgroup label="' + esc(e.short || e.name) + '">' + subs.map(function (s) {
        return '<option value="' + esc(s.id) + '">' + esc(e.name + " · " + s.name) + "</option>"; }).join("") + "</optgroup>" : "";
    }).join("");
  }
  function keyCount(sid) {
    var codes = sc(sid).set_codes; return codes.map(function (code) { return Object.keys((S.keys[sid] || {})[code] || {}).length; });
  }
  function renderAll() {
    var c = S.cfg;
    [["key-subject", null], ["one-subject", null], ["bulk-subject", null]].forEach(function (x) {
      var sel = $(x[0]), v = sel.value;
      sel.innerHTML = subjectOptions(x[1]);
      if (v && sel.querySelector('option[value="' + v + '"]')) sel.value = v;
    });
    renderKeySets(); renderOne(); renderBulkLayout();
    $("keys-status").innerHTML = (c.exams || []).map(function (e) {
      var subs = c.subjects.filter(function (s) { return s.exam === e.id; }); if (!subs.length) return "";
      var codes = sc(subs[0].id).set_codes, n = sc(subs[0].id).num_questions;
      return "<tr><th style='text-align:left'>" + esc(e.short || e.name) + "</th>" + codes.map(function (s) { return "<th>" + esc(s) + "</th>"; }).join("") + "</tr>" +
        subs.map(function (s) {
          return "<tr><td style='text-align:left'>" + esc(s.name) + "</td>" + keyCount(s.id).map(function (k) {
            return '<td class="' + (k >= n ? "ok" : k ? "warn" : "bad") + '">' + (k || "–") + "</td>"; }).join("") + "</tr>";
        }).join("");
    }).join("");
    ["kea-exam", "merit-exam"].forEach(function (id) {
      var sel = $(id), v = sel.value;
      sel.innerHTML = (c.exams || []).map(function (e) { return '<option value="' + esc(e.id) + '">' + esc(e.short || e.name) + "</option>"; }).join("");
      if (v && sel.querySelector('option[value="' + v + '"]')) sel.value = v;
    });
    renderMeritSubjects();
    $("new-exam").innerHTML = (c.exams || []).map(function (e) { return '<option value="' + esc(e.id) + '">' + esc(e.short || e.name) + "</option>"; }).join("");
    $("subj-list").innerHTML = (c.exams || []).map(function (e) {
      var subs = c.subjects.filter(function (s) { return s.exam === e.id; });
      return '<div class="exam-block"><h3>' + esc(e.name) + ' <span class="muted" style="font-weight:500">' + esc(e.full || "") + "</span></h3>" +
        '<p class="muted" style="margin:0 0 6px">' + (e.omr_layout === "kea_kreis" ? "OMR photo checking: on" : "OMR photo checking: off. " +
          '<button type="button" class="linkbtn" data-layout="' + esc(e.id) + '">Turn on (sheet is the same KEA OMR sheet as KREIS)</button>') + "</p>" +
        (subs.map(function (s) {
          var has = keyCount(s.id).some(function (k) { return k > 0; });
          var counts = keyCount(s.id), codes = sc(s.id).set_codes, full = counts.filter(function (k) { return k >= sc(s.id).num_questions; }).length;
          return '<div class="subj-line"><span>' + esc(s.name) + " " + (has ? '<span class="badge ready">key: ' + full + " of " + codes.length + " sets</span>" : '<span class="badge soon">no key yet</span>') + "</span><span>" +
            '<button type="button" class="linkbtn" data-key="' + esc(s.id) + '">' + (has ? "Edit / upload key" : "Add / upload key") + "</button>" +
            (has ? "" : ' <button type="button" class="linkbtn" data-remove="' + esc(s.id) + '">Remove</button>') + "</span></div>";
        }).join("") || '<p class="muted">No subjects yet.</p>') + "</div>";
    }).join("");
  }
  function renderKeySets() {
    var sid = $("key-subject").value; if (!sid) return;
    var codes = sc(sid).set_codes, v = $("key-set").value;
    $("key-set").innerHTML = codes.map(function (s) { return "<option>" + esc(s) + "</option>"; }).join("");
    if (codes.indexOf(v) >= 0) $("key-set").value = v;
    if (keyMode() === "table") $("key-help").textContent = "One row per question: question number, then the answer for each set (" + codes.join(" ") + "), as in the published key PDF. Rows you leave out keep their saved answer. Use 23 when two options are accepted and X for a dropped question.";
  }
  $("key-subject").addEventListener("change", renderKeySets);

  // ---------- tabs ----------
  function openTab(id) {
    Array.prototype.forEach.call(document.querySelectorAll(".tabbar button"), function (x) { x.classList.toggle("on", x.dataset.tab === id); });
    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (t) { t.hidden = t.id !== id; });
    if (id === "tab-merit") showMerit();
  }
  Array.prototype.forEach.call(document.querySelectorAll(".tabbar button"), function (b) {
    b.addEventListener("click", function () { openTab(b.dataset.tab); });
  });

  // ---------- answer keys ----------
  function keyMode() { return document.querySelector("input[name=key-mode]:checked").value; }
  Array.prototype.forEach.call(document.querySelectorAll("input[name=key-mode]"), function (r) {
    r.addEventListener("change", function () {
      $("key-set-wrap").hidden = keyMode() !== "one";
      $("key-help").textContent = keyMode() === "one"
        ? "The answers for one set: either one digit per question in order (3342212…), or one numbered answer per line (1 3, 2 4, …). Saving replaces this set's whole key. Use 23 when two options are accepted and X for a dropped question."
        : "";
      if (keyMode() === "table") renderKeySets();
    });
  });
  async function prepareKeys() {
    var subject = $("key-subject").value, text = $("key-text").value;
    if (!text.trim()) throw new Error("Paste the answers first.");
    msg("key-msg", OMREngine.isLoaded() ? "Checking…" : "Loading the checker (first time only)…");
    var changes = {};
    if (keyMode() === "table") {
      var t = await OMREngine.call("omr_parse_table", text, subject);
      if (t.error) throw new Error(t.error);
      Object.keys(t.keys).forEach(function (set) {
        if (!Object.keys(t.keys[set]).length) return;
        changes[set] = Object.assign({}, (S.keys[subject] || {})[set] || {}, t.keys[set]);
      });
    } else {
      var k = await OMREngine.call("omr_parse_key", text, subject);
      if (k.error) throw new Error(k.error);
      if (!Object.keys(k.key).length) throw new Error("No answers found.");
      changes[$("key-set").value] = k.key;
    }
    return { subject: subject, changes: changes };
  }
  function describe(p) {
    var n = sc(p.subject).num_questions;
    return Object.keys(p.changes).map(function (set) { var c = Object.keys(p.changes[set]).length; return set + ": " + c + " of " + n + " answers"; }).join(" · ");
  }
  $("key-check").addEventListener("click", async function () {
    try { var p = await prepareKeys(); msg("key-msg", "Looks good. Check the preview, then press Save. After saving: " + describe(p) + ".", "ok"); showKeyPreview(p); }
    catch (e) { msg("key-msg", e.message, "bad"); $("key-preview").innerHTML = ""; }
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
      $("key-text").value = ""; $("key-preview").innerHTML = "";
    } catch (e) { console.error(e); msg("key-msg", e.message, "bad"); }
    finally { btn.disabled = false; }
  });

  // ---------- exams and subjects ----------
  function slugify(t) { return t.toLowerCase().replace(/&/g, " ").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
  async function saveConfig(change, message, msgId) {
    var latest = JSON.parse(await readFile("config.json"));   // re-read so nothing else in config is lost
    var result = change(latest);
    var text = JSON.stringify(latest, null, 2) + "\n";
    await commit({ "config.json": text }, message);
    S.cfg = latest; await OMREngine.setFiles({ "config.json": text }); renderAll();
    return result;
  }
  $("subj-add").addEventListener("click", async function () {
    var exam = $("new-exam").value, paper = $("new-paper").value.trim(), subject = $("new-subject").value.trim();
    var short = $("new-short").value.trim() || subject;
    if (!paper) { msg("subj-msg", "Enter the paper, for example Paper II.", "bad"); return; }
    if (subject.length < 2) { msg("subj-msg", "Enter the subject name.", "bad"); return; }
    var name = paper + ": " + subject;
    if (S.cfg.subjects.some(function (s) { return s.exam === exam && s.name.toLowerCase() === name.toLowerCase(); })) { msg("subj-msg", "This exam already has " + name + ".", "bad"); return; }
    var btn = this; btn.disabled = true; msg("subj-msg", "Saving…");
    try {
      await saveConfig(function (c) {
        var base = (exam === "kreis" ? "" : exam + "_") + slugify(paper === "Paper I" || paper === "Paper II" ? (exam === "kreis" ? subject : paper + " " + subject) : paper + " " + subject).replace(/-/g, "_").slice(0, 40);
        var id = base || "subject", i = 2; while (c.subjects.some(function (s) { return s.id === id; })) id = base + "_" + i++;
        var slug = slugify((exam === "kreis" ? "" : paper + " ") + subject) + "-answer-key", j = 2, sl = slug;
        while (c.subjects.some(function (s) { return s.exam === exam && s.slug === sl; })) sl = slug.replace(/-answer-key$/, "-" + j++ + "-answer-key");
        c.subjects.push({ id: id, exam: exam, paper: paper, subject: subject, name: name, short: short, slug: sl });
      }, "Add subject: " + exam.toUpperCase() + " " + name);
      $("new-subject").value = ""; $("new-short").value = "";
      msg("subj-msg", "Added " + name + ". Add its answer key in the Answer keys tab. It shows on the website in about 1 to 2 minutes.", "ok");
    } catch (e) { console.error(e); msg("subj-msg", e.message, "bad"); }
    finally { btn.disabled = false; }
  });
  // Exams set by KEA often use the same OMR sheet as KREIS. Turning this on lets the scanner read them.
  async function useKeaSheet(examId, msgId) {
    var e = (S.cfg.exams || []).filter(function (x) { return x.id === examId; })[0]; if (!e) return;
    if (!window.confirm("Read " + e.name + " sheets with the KEA OMR sheet layout (100 questions, options 1 to 5, sets A1 to D1, 9-digit register number)? Only do this if " + e.name + " uses that same sheet.")) return;
    msg(msgId, "Saving…");
    try {
      await saveConfig(function (c) { c.exams.forEach(function (x) { if (x.id === examId) x.omr_layout = "kea_kreis"; }); }, "Read " + e.name + " sheets with the KEA OMR layout");
      msg(msgId, "OMR photo checking is on for " + e.name + ". Check one sheet's score by hand before publishing many.", "ok");
    } catch (err) { console.error(err); msg(msgId, err.message, "bad"); }
  }
  function renderBulkLayout() {
    var sid = $("bulk-subject").value; if (!sid) return;
    var e = examOf(sid), on = e.omr_layout === "kea_kreis";
    $("bulk-layout").hidden = on; $("bulk-scan").disabled = !on;
    if (!on) $("bulk-layout-text").textContent = "The website cannot read " + e.name + " OMR sheets yet. If " + e.name + " uses the same KEA OMR sheet as KREIS (100 questions, options 1 to 5, sets A1 to D1), turn it on below. Otherwise send a photo of a filled " + e.name + " sheet so its layout can be added, or use Add one sheet to type the answers.";
  }
  $("bulk-subject").addEventListener("change", renderBulkLayout);
  $("bulk-layout-on").addEventListener("click", function () { var sid = $("bulk-subject").value; if (sid) useKeaSheet(examOf(sid).id, "bulk-msg"); });
  $("subj-list").addEventListener("click", async function (ev) {
    var lb = ev.target.closest("button[data-layout]");
    if (lb) { useKeaSheet(lb.dataset.layout, "subj-msg"); return; }
    var kb = ev.target.closest("button[data-key]");
    if (kb) { openTab("tab-keys"); $("key-subject").value = kb.dataset.key; renderKeySets(); $("key-subject").scrollIntoView({ behavior: "smooth" }); return; }
    var b = ev.target.closest("button[data-remove]"); if (!b) return;
    var sid = b.dataset.remove, s = S.cfg.subjects.filter(function (x) { return x.id === sid; })[0];
    if (!s || !window.confirm("Remove " + s.name + "? It has no answer key yet.")) return;
    b.disabled = true;
    try {
      await saveConfig(function (c) { c.subjects = c.subjects.filter(function (x) { return x.id !== sid; }); }, "Remove subject: " + s.name);
      msg("subj-msg", "Removed " + s.name + ".", "ok");
    } catch (e) { console.error(e); msg("subj-msg", e.message, "bad"); b.disabled = false; }
  });
  $("exam-add").addEventListener("click", async function () {
    var name = $("exam-name").value.trim(), short = $("exam-short").value.trim() || name, full = $("exam-full").value.trim() || short;
    if (name.length < 2) { msg("exam-msg", "Enter the exam's tab name.", "bad"); return; }
    if ((S.cfg.exams || []).some(function (e) { return e.name.toLowerCase() === name.toLowerCase(); })) { msg("exam-msg", "There is already an exam called " + name + ".", "bad"); return; }
    var btn = this; btn.disabled = true; msg("exam-msg", "Saving…");
    try {
      await saveConfig(function (c) {
        c.exams = c.exams || [];
        var id = slugify(name).replace(/-/g, "_") || "exam", base = id, i = 2;
        while (c.exams.some(function (e) { return e.id === id; })) id = base + "_" + i++;
        var slug = slugify(short) || id, reserved = ["exams", "results", "published", "static", "app", "api", "admin", "privacy"];
        while (reserved.indexOf(slug) >= 0 || c.exams.some(function (e) { return e.slug === slug; })) slug += "-exam";
        c.exams.push({ id: id, name: name, short: short, full: full, slug: slug, omr_layout: $("exam-same-sheet").checked ? "kea_kreis" : "" });
      }, "Add exam: " + name);
      $("exam-name").value = ""; $("exam-short").value = ""; $("exam-full").value = ""; $("exam-same-sheet").checked = false;
      msg("exam-msg", "Added " + name + ". Now add its papers and subjects above.", "ok");
    } catch (e) { console.error(e); msg("exam-msg", e.message, "bad"); }
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
    var byReg = (S.cfg.results_lookup || "register_booklet") === "register";
    bulk.forEach(function (r) { var k = OMRCrypto.digits(r.register_number) + ":" + (byReg ? r.subject : OMRCrypto.digits(r.booklet_serial)); r.dup = !!seen[k]; seen[k] = 1; });
    $("bulk-table").innerHTML = "<tr><th>#</th><th>Photo</th><th>Register no.</th><th>Booklet no.</th><th>Name</th><th>Set</th><th>Score</th><th>Status</th></tr>" +
      bulk.map(function (r, i) {
        var st = r.dup ? ["warn", "Same register number as an earlier sheet"] : rowStatus(r);
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
  async function expandPdfs(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      if (!(/\.pdf$/i.test(f.name) || f.type === "application/pdf")) {
        out.push({ name: f.name, bytes: (function (f) { return async function () { return new Uint8Array(await f.arrayBuffer()); }; })(f) });
        continue;
      }
      $("bulk-status").textContent = "Opening " + f.name + "…";
      await loadScript(PDFJS);
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      var doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(await f.arrayBuffer()) }).promise;
      for (var p = 1; p <= doc.numPages; p++) out.push({ name: f.name + " page " + p, bytes: (function (doc, p) { return async function () {
        var page = await doc.getPage(p), v = page.getViewport({ scale: 1 }), scale = 2200 / Math.max(v.width, v.height);
        v = page.getViewport({ scale: scale });
        var cv = document.createElement("canvas"); cv.width = Math.round(v.width); cv.height = Math.round(v.height);
        var ctx = cv.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
        await page.render({ canvasContext: ctx, viewport: v }).promise;
        var blob = await new Promise(function (ok) { cv.toBlob(ok, "image/jpeg", 0.9); });
        return new Uint8Array(await blob.arrayBuffer());
      }; })(doc, p) });
    }
    return out;
  }
  $("bulk-scan").addEventListener("click", async function () {
    var files = Array.prototype.slice.call($("bulk-files").files), subject = $("bulk-subject").value;
    if (!files.length) { msg("bulk-msg", "Choose the OMR sheet photos first.", "bad"); return; }
    var btn = this; btn.disabled = true; msg("bulk-msg", ""); bulk = []; renderBulk();
    $("bulk-progress").hidden = false; var bar = $("bulk-progress").firstElementChild; bar.style.width = "0";
    try {
      if (!OMREngine.isLoaded()) $("bulk-status").textContent = "Loading the scanner (first time only)…";
      await OMREngine.load();
      files = await expandPdfs(files);   // a centre PDF from KEA becomes one sheet per page
      for (var i = 0; i < files.length; i++) {
        $("bulk-status").textContent = "Reading sheet " + (i + 1) + " of " + files.length + "…";
        await new Promise(function (r) { setTimeout(r, 10); });
        var r;
        try {
          r = await OMREngine.call("omr_run", await files[i].bytes(), subject, "", true, 72);
          if (r.annotated_b64) { r.image = OMRCrypto.unb64(r.annotated_b64); delete r.annotated_b64; }
        }
        catch (e) { console.error(e); r = { scan_error: "Could not read this sheet" }; }
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
  // Publish graded sheets: each candidate's encrypted result file, each marked sheet image, and the admin list.
  async function publishRows(rows, msgId) {
      await loadTree(); await loadIndex();   // start from the latest saved list
      var byRegister = (S.cfg.results_lookup || "register_booklet") === "register";
      var files = {}, lists = {}, when = new Date().toISOString().slice(0, 10), done = 0;
      // The candidate's result file holds every paper published for the same lookup numbers.
      async function listFor(r) {
        var d = await OMRCrypto.derive(r.register_number, byRegister ? "" : r.booklet_serial);
        if (!lists[d.id]) {
          var path = "published/results/" + d.id + ".json", old = [];
          if (S.tree[path]) {
            try { var data = await OMRCrypto.open(new TextDecoder().decode(await getBlob(S.tree[path])), d.key); old = data.results || [data]; } catch (e) { old = []; }
          }
          lists[d.id] = { path: path, results: old };
        }
        return lists[d.id];
      }
      async function one(r) {
        var g = r.grading, sheet = null, sk = null;
        if (r.image) {
          var k = await OMRCrypto.newSheetKey(); sk = k.raw;
          sheet = "published/sheets/" + Array.prototype.map.call(crypto.getRandomValues(new Uint8Array(12)), function (x) { return ("0" + x.toString(16)).slice(-2); }).join("") + ".bin";
          files[sheet] = await putBlob(await OMRCrypto.sealBytes(k.key, r.image));
        }
        var pub = { subject: r.subject, subject_name: r.subject_name, exam: r.exam, exam_short: r.exam_short, name: r.name || "", version: r.version, register_number: r.register_number,
          booklet_serial: r.booklet_serial, register_complete: true, grading: g, error: null, marking: r.marking, five: r.five, published: when,
          sheet: sheet, sheet_key: sk };
        var L = await listFor(r);
        L.results = L.results.filter(function (e) { return !(e.subject === r.subject && (byRegister || e.booklet_serial === r.booklet_serial)); });
        L.results.push(pub);
        // replace an older entry for the same sheet (same register, booklet and subject)
        S.index = S.index.filter(function (e) {
          var same = e.reg === r.register_number && e.subject === r.subject && (byRegister || e.booklet === r.booklet_serial);
          if (same && e.sheet && e.sheet !== sheet && S.tree[e.sheet]) files[e.sheet] = null;
          return !same;
        });
        S.index.push({ reg: r.register_number, booklet: r.booklet_serial, name: r.name || "", subject: r.subject, subject_name: r.subject_name, exam_short: r.exam_short,
          set: r.version, score: g.score, max: g.max_score, counts: g.counts, photo: r.file, sheet: sheet, sheet_key: sk, published: when });
        done++; msg(msgId, "Saving sheet " + done + " of " + rows.length + "…");
      }
      for (var i = 0; i < rows.length; i++) await one(rows[i]);   // in order, so papers of one candidate merge correctly
      for (var id in lists) {
        var L = lists[id], first = L.results[0];
        files[L.path] = (await OMRCrypto.seal({ v: 2, results: L.results }, first.register_number, byRegister ? "" : first.booklet_serial)).body;
      }
      msg(msgId, "Saving the results list…");
      files[INDEX] = await putBlob(await OMRCrypto.sealBytes(S.vault, new TextEncoder().encode(JSON.stringify(S.index))));
      await commit(files, "Publish " + rows.length + " result" + (rows.length > 1 ? "s" : "") + ": " + rows[0].subject_name);
      await loadTree();
      showSearch("");
  }
  $("bulk-publish").addEventListener("click", async function () {
    var rows = bulk.filter(function (r) { return !r.dup && rowStatus(r)[0] === "ok"; });
    if (!rows.length) return;
    var btn = this; btn.disabled = true;
    try {
      await publishRows(rows, "bulk-msg");
      msg("bulk-msg", "Published " + rows.length + " result" + (rows.length > 1 ? "s" : "") + " with their OMR sheets. Candidates can look them up on the Search by Register No. & Exam page in about 1 to 2 minutes. You can find them now under Search by register no.", "ok");
    } catch (e) { console.error(e); msg("bulk-msg", e.message, "bad"); }
    finally { btn.disabled = false; }
  });

  // ---------- add one sheet ----------
  var one = { image: null, photo: "", annotated: false };
  function renderOne() {
    var sid = $("one-subject").value; if (!sid) return;
    var codes = sc(sid).set_codes, v = $("one-set").value;
    $("one-set").innerHTML = codes.map(function (s) { return "<option>" + esc(s) + "</option>"; }).join("");
    if (codes.indexOf(v) >= 0) $("one-set").value = v;
    $("one-read").hidden = !(one.image && !one.annotated && examOf(sid).omr_layout === "kea_kreis");
  }
  $("one-subject").addEventListener("change", renderOne);
  function compress(file) {
    return new Promise(function (ok, fail) {
      var img = new Image(); img.onerror = fail;
      img.onload = function () {
        var sc2 = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight)), cv = document.createElement("canvas");
        cv.width = Math.round(img.naturalWidth * sc2); cv.height = Math.round(img.naturalHeight * sc2);
        cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
        cv.toBlob(function (b) { b.arrayBuffer().then(function (a) { ok(new Uint8Array(a)); }); }, "image/jpeg", 0.75);
      };
      img.src = URL.createObjectURL(file);
    });
  }
  $("one-photo").addEventListener("change", async function () {
    var f = this.files[0]; one.raw = f || null; one.photo = f ? f.name : ""; one.annotated = false; one.image = null;
    if (f) {
      try { one.image = await compress(f); } catch (e) { msg("one-msg", "This photo could not be opened.", "bad"); }
      $("one-pick").innerHTML = '<img alt="Sheet photo" src="' + URL.createObjectURL(f) + '">';
    } else $("one-pick").innerHTML = '<span class="cam" aria-hidden="true">📷</span>Choose a photo of the sheet';
    renderOne();
  });
  $("one-read").addEventListener("click", async function () {
    var btn = this, sid = $("one-subject").value; btn.disabled = true;
    msg("one-msg", OMREngine.isLoaded() ? "Reading the sheet…" : "Loading the scanner (first time only)…");
    try {
      var r = await OMREngine.call("omr_run", new Uint8Array(await one.raw.arrayBuffer()), sid, "", true, 72);
      if (r.scan_error) throw new Error(r.scan_error);
      $("one-answers").value = r.answers_text || "";
      if (r.version && sc(sid).set_codes.indexOf(r.version) >= 0) $("one-set").value = r.version;
      if (r.register_number && !$("one-reg").value) $("one-reg").value = r.register_number;
      if (r.booklet_serial && !$("one-booklet").value) $("one-booklet").value = r.booklet_serial;
      if (r.annotated_b64) { one.image = OMRCrypto.unb64(r.annotated_b64); one.annotated = true; }
      msg("one-msg", "Filled in from the photo" + (r.version ? " (set " + r.version + ")" : "") + ". Check the numbers and answers, then press Check score.", "ok");
      renderOne();
    } catch (e) { console.error(e); msg("one-msg", e.message || "Could not read this photo.", "bad"); }
    finally { btn.disabled = false; }
  });
  async function gradeOne() {
    var sid = $("one-subject").value, reg = OMRCrypto.digits($("one-reg").value), bk = OMRCrypto.digits($("one-booklet").value);
    if (!sid) throw new Error("Choose the exam and subject.");
    if (reg.length < 5) throw new Error("Enter the candidate's register number.");
    if ((S.cfg.results_lookup || "register_booklet") !== "register" && bk.length < 4) throw new Error("Enter the booklet number (candidates need it to find their result).");
    msg("one-msg", OMREngine.isLoaded() ? "Scoring…" : "Loading the checker (first time only)…");
    var r = await OMREngine.call("omr_grade_manual", sid, $("one-set").value, $("one-answers").value);
    if (r.error) throw new Error(r.error);
    r.register_number = reg; r.booklet_serial = bk; r.name = $("one-name").value.trim().slice(0, 80);
    r.image = one.image; r.file = one.photo || "typed by admin";
    return r;
  }
  function scoreLine(r) {
    var g = r.grading, c = g.counts;
    return "Score " + fmt(g.score) + " / " + fmt(g.max_score) + ": " + c.correct + " correct, " + c.wrong + " wrong, " + c.skipped + " option " + r.five + ", " + c.blank + " blank, " + c.multiple + " multiple.";
  }
  $("one-check").addEventListener("click", async function () {
    try { msg("one-msg", scoreLine(await gradeOne()), "ok"); } catch (e) { msg("one-msg", e.message, "bad"); }
  });
  $("one-save").addEventListener("click", async function () {
    var btn = this; btn.disabled = true;
    try {
      var r = await gradeOne();
      await publishRows([r], "one-msg");
      msg("one-msg", "Published. " + scoreLine(r) + " The candidate can see it in about 1 to 2 minutes.", "ok");
      $("one-answers").value = ""; $("one-reg").value = ""; $("one-booklet").value = ""; $("one-name").value = ""; $("one-photo").value = "";
      one = { image: null, photo: "", annotated: false }; $("one-pick").innerHTML = '<span class="cam" aria-hidden="true">📷</span>Choose a photo of the sheet'; renderOne();
    } catch (e) { console.error(e); msg("one-msg", e.message, "bad"); }
    finally { btn.disabled = false; }
  });

  // ---------- search by register number ----------
  function showSearch(q) {
    q = String(q || "").trim().toLowerCase();
    var digits = OMRCrypto.digits(q), list;
    if (!q) list = S.index.slice(-20).reverse();
    else list = S.index.filter(function (e) {
      return digits && digits.length >= 3 ? String(e.reg).indexOf(digits) >= 0 || String(e.booklet) === digits : (e.name || "").toLowerCase().indexOf(q) >= 0;
    });
    $("search-info").textContent = S.index.length + " sheet" + (S.index.length === 1 ? "" : "s") + " saved. " +
      (q ? list.length + " match" + (list.length === 1 ? "" : "es") + "." : list.length ? "Showing the latest " + list.length + "." : "");
    $("search-results").innerHTML = list.slice(0, 50).map(function (e) {
      var i = S.index.indexOf(e), c = e.counts || {};
      return '<div class="cand"><div class="cand-head"><div><b>' + esc(e.name || "Register " + e.reg) + "</b><br><span class='muted'>" + esc((e.exam_short ? e.exam_short + " · " : "") + e.subject_name) +
        " · Set " + esc(e.set) + "</span></div><div class='cand-score'>" + fmt(e.score) + "<small> / " + fmt(e.max) + "</small></div></div>" +
        '<div class="facts" style="justify-content:flex-start"><span>Register <b>' + esc(e.reg) + "</b></span><span>Booklet <b>" + esc(e.booklet) +
        "</b></span><span>Published " + esc(e.published) + "</span><span>Photo " + esc(e.photo) + "</span></div>" +
        '<div class="stats"><div class="s-correct"><b>' + c.correct + '</b>Correct</div><div class="s-wrong"><b>' + c.wrong + '</b>Wrong</div><div class="s-skipped"><b>' +
        c.skipped + '</b>Option 5</div><div class="s-blank"><b>' + c.blank + '</b>Blank</div><div class="s-multiple"><b>' + c.multiple + "</b>Multiple</div></div>" +
        (e.sheet ? '<div class="row2" style="margin-top:10px"><button type="button" class="btn secondary" data-show="' + i + '">Show OMR sheet</button>' +
          '<button type="button" class="btn secondary" data-tab-open="' + i + '">Open in new tab</button></div><div class="cand-img" id="img-' + i + '"></div>' : "") + "</div>";
    }).join("") || (q ? "<p class='muted'>No saved sheet matches. Check the number, or the sheet may not have been published yet.</p>" : "");
  }
  var sheetCache = {};
  async function sheetUrl(e) {
    if (sheetCache[e.sheet]) return sheetCache[e.sheet];
    if (!S.tree[e.sheet]) await loadTree();
    if (!S.tree[e.sheet]) throw new Error("This OMR sheet file is missing from the repository.");
    var bytes = await OMRCrypto.openBytes(e.sheet_key ? await OMRCrypto.sheetKey(e.sheet_key) : S.vault, await getBlob(S.tree[e.sheet]));
    return (sheetCache[e.sheet] = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" })));
  }
  $("search-form").addEventListener("submit", function (ev) { ev.preventDefault(); showSearch($("search-q").value); });
  $("search-results").addEventListener("click", async function (ev) {
    var b = ev.target.closest("button"); if (!b) return;
    var i = b.dataset.show != null ? +b.dataset.show : b.dataset.tabOpen != null ? +b.dataset.tabOpen : -1; if (i < 0) return;
    var e = S.index[i], newTab = b.dataset.tabOpen != null, w = newTab ? window.open("", "_blank") : null;
    var box = $("img-" + i), label = b.textContent; b.disabled = true; b.textContent = "Opening…";
    try {
      var url = await sheetUrl(e);
      if (newTab) {
        if (w) { w.document.title = "OMR sheet " + e.reg; w.document.body.style.margin = "0"; w.document.body.innerHTML = '<img style="width:100%" alt="OMR sheet" src="' + url + '">'; }
      } else if (box.firstChild) { box.innerHTML = ""; label = "Show OMR sheet"; }
      else { box.innerHTML = '<img class="sheet" style="margin-top:10px" alt="Marked OMR sheet of register ' + esc(e.reg) + '" src="' + url + '">'; label = "Hide OMR sheet"; }
    } catch (err) { console.error(err); if (w) w.close(); box.innerHTML = '<p class="bad">' + esc(err.message) + "</p>"; }
    finally { b.disabled = false; b.textContent = label; }
  });

  // ---------- answer key files: PDF, Excel or CSV ----------
  var PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
  var PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  var XLSX_URL = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
  var scripts = {};
  function loadScript(url) {
    return scripts[url] || (scripts[url] = new Promise(function (ok, fail) {
      var el = document.createElement("script"); el.src = url; el.onload = ok;
      el.onerror = function () { delete scripts[url]; fail(new Error("Could not load a helper from the internet. Check the connection and try again.")); };
      document.head.appendChild(el);
    }));
  }
  // Rows of numbers / answers. A line with two or more question blocks side by side is split up.
  function rowsToKeyText(rows, nsets) {
    var out = [], width = nsets + 1;
    rows.forEach(function (cells) {
      cells = cells.map(function (c) { return String(c == null ? "" : c).trim(); }).filter(function (c) { return c !== ""; });
      if (!cells.length || !/^\d{1,3}$/.test(cells[0])) return;   // headings and notes
      if (cells.length > width && cells.length % width === 0) {
        for (var i = 0; i < cells.length; i += width) if (/^\d{1,3}$/.test(cells[i])) out.push(cells.slice(i, i + width).join(" "));
      } else out.push(cells.join(" "));
    });
    return out.join("\n");
  }
  async function pdfRows(buf) {
    await loadScript(PDFJS);
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    var doc = await window.pdfjsLib.getDocument({ data: buf }).promise, rows = [];
    for (var p = 1; p <= doc.numPages; p++) {
      var items = (await (await doc.getPage(p)).getTextContent()).items, lines = [];
      items.forEach(function (it) {
        if (!it.str.trim()) return;
        var y = it.transform[5], x = it.transform[4], line = null;
        for (var i = 0; i < lines.length; i++) if (Math.abs(lines[i].y - y) < 3) { line = lines[i]; break; }
        if (!line) lines.push(line = { y: y, parts: [] });
        line.parts.push({ x: x, t: it.str.trim() });
      });
      lines.sort(function (a, b) { return b.y - a.y; }).forEach(function (l) {
        rows.push(l.parts.sort(function (a, b) { return a.x - b.x; }).map(function (q) { return q.t; }).join(" ").split(/\s+/));
      });
    }
    return rows;
  }
  async function sheetRows(buf) {
    await loadScript(XLSX_URL);
    var wb = window.XLSX.read(buf, { type: "array" }), rows = [];
    wb.SheetNames.forEach(function (n) { rows = rows.concat(window.XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false })); });
    return rows;
  }
  $("key-file").addEventListener("change", async function () {
    var f = this.files[0]; if (!f) return;
    var sid = $("key-subject").value, nsets = sc(sid).set_codes.length;
    $("key-pick").innerHTML = '<span class="cam" aria-hidden="true">📄</span>' + esc(f.name);
    msg("key-msg", "Reading " + f.name + "…");
    try {
      var buf = new Uint8Array(await f.arrayBuffer()), name = f.name.toLowerCase(), rows;
      if (/\.pdf$/.test(name) || f.type === "application/pdf") rows = await pdfRows(buf);
      else if (/\.(xlsx|xls|csv)$/.test(name)) rows = await sheetRows(buf);
      else rows = new TextDecoder().decode(buf).split(/\r?\n/).map(function (l) { return l.split(/[\s,;\t]+/); });
      var text = rowsToKeyText(rows, nsets);
      if (!text) throw new Error("No answer rows were found in this file. If it is a scanned picture, type the answers in instead.");
      document.querySelector("input[name=key-mode][value=table]").checked = true; $("key-set-wrap").hidden = true; renderKeySets();
      $("key-text").value = text;
      var p = await prepareKeys();
      showKeyPreview(p);
      msg("key-msg", "Read from " + f.name + ": " + describe(p) + ". Check the preview against the key, correct the box if needed, then press Save.", "ok");
    } catch (e) { console.error(e); msg("key-msg", e.message || "Could not read this file.", "bad"); $("key-preview").innerHTML = ""; }
    finally { this.value = ""; }
  });
  function showKeyPreview(p) {
    var sets = Object.keys(p.changes).sort(), n = sc(p.subject).num_questions, html = "<table class='grid-keys'><tr><th>Q</th>" +
      sets.map(function (s) { return "<th>" + esc(s) + "</th>"; }).join("") + "</tr>";
    for (var q = 1; q <= n; q++) html += "<tr><td>" + q + "</td>" + sets.map(function (s) {
      var a = p.changes[s][q] != null ? p.changes[s][q] : p.changes[s][String(q)];
      return a == null ? "<td class='bad'>–</td>" : "<td>" + esc(a) + "</td>"; }).join("") + "</tr>";
    $("key-preview").innerHTML = html + "</table>";
  }

  // ---------- fetch from a KEA link ----------
  var KEA_REQ = "admin/kea-request.json", KEA_STATE = "admin/kea-state.json";
  async function keaRequest(stop) {
    var url = $("kea-url").value.trim();
    if (!stop && !/^https:\/\/([\w-]+\.)*karnataka\.gov\.in\//i.test(url)) throw new Error("Paste a KEA link starting with https:// on karnataka.gov.in.");
    var req = { id: new Date().toISOString(), url: url, exam: $("kea-exam").value, kea_exam: $("kea-code").value,
      districts: $("kea-districts").value.split(/[,;\n]+/).map(function (d) { return d.trim().toUpperCase(); }).filter(Boolean), stop: !!stop };
    if (stop) { var old = await readFile(KEA_REQ); if (old) { old = JSON.parse(old); old.stop = true; req = old; } }
    await commit({ "admin/kea-request.json": JSON.stringify(req, null, 1) + "\n" }, stop ? "Stop the KEA fetch" : "Start a KEA fetch: " + req.kea_exam);
  }
  // Which KEA exam each exam on this site usually is. Picking the exam picks the KEA exam too.
  var KEA_CODES = { kreis: "KREISREC26", warder: "PDP26" };
  $("kea-exam").addEventListener("change", function () {
    var ex = (S.cfg.exams || []).filter(function (e) { return e.id === $("kea-exam").value; })[0] || {};
    var code = ex.kea_code || KEA_CODES[ex.id]; if (code && $("kea-code").querySelector('option[value="' + code + '"]')) $("kea-code").value = code;
  });
  $("kea-start").addEventListener("click", async function () {
    var btn = this; btn.disabled = true;
    try {
      var ex = (S.cfg.exams || []).filter(function (e) { return e.id === $("kea-exam").value; })[0] || {};
      if (ex.omr_layout !== "kea_kreis") {
        await useKeaSheet(ex.id, "kea-msg");
        ex = (S.cfg.exams || []).filter(function (e) { return e.id === $("kea-exam").value; })[0] || {};
        if (ex.omr_layout !== "kea_kreis") throw new Error("Photo reading must be on for " + ex.name + " before its sheets can be fetched.");
      }
      var keyless = S.cfg.subjects.filter(function (s) { return s.exam === ex.id && !keyCount(s.id).some(function (k) { return k > 0; }); });
      if (keyless.length) msg("kea-msg", "Note: no answer key yet for " + keyless.map(function (s) { return s.name; }).join(", ") + ". Those subjects wait until their key is added.", "warn");
      await keaRequest(false);
      msg("kea-msg", (keyless.length ? "Started (subjects without a key will wait). " : "Started. ") + "GitHub begins in about a minute. Press Refresh progress from time to time; you can also close this page.", "ok");
    } catch (e) { console.error(e); msg("kea-msg", e.message, "bad"); }
    finally { btn.disabled = false; }
  });
  $("kea-stop").addEventListener("click", async function () {
    var btn = this; btn.disabled = true;
    try { await keaRequest(true); msg("kea-msg", "Stopping. The fetch stops after the centre it is working on. Start again to carry on.", "ok"); }
    catch (e) { msg("kea-msg", e.message, "bad"); } finally { btn.disabled = false; }
  });
  $("kea-refresh").addEventListener("click", async function () {
    var btn = this; btn.disabled = true; $("kea-status").innerHTML = "<p class='muted'>Loading…</p>";
    try {
      await loadTree();
      var added = await mergeInbox(); if (added) showSearch("");
      var st = await readFile(KEA_STATE), req = await readFile(KEA_REQ);
      if (!st) { $("kea-status").innerHTML = "<p class='muted'>" + (req ? "Waiting for GitHub to start." : "No fetch has been started yet.") + "</p>"; return; }
      st = JSON.parse(st); req = req ? JSON.parse(req) : {};
      var t = st.totals || {}, label = { running: "Running", paused: "Paused, carries on in the next run", blocked: "KEA is limiting requests, will try again later",
        captcha: "Stopped: KEA asked for a captcha", done: "Finished", error: "Stopped with a problem" }[st.status] || st.status;
      if (req.stop) label += " (stop requested)";
      var fails = (st.failures || []).slice(-15).reverse();
      $("kea-status").innerHTML = "<p><b>" + esc(label) + "</b><br>" + esc(st.message || "") + "</p>" +
        '<div class="facts" style="justify-content:flex-start"><span>Exam <b>' + esc(st.kea_exam_name || req.kea_exam || "") + "</b></span><span>Centres done <b>" + (t.centres || 0) +
        "</b></span><span>Sheets published <b>" + (t.published || 0) + "</b></span><span>Could not read <b>" + (t.failed || 0) + "</b></span><span>Updated <b>" + esc((st.updated || "").replace("T", " ").replace("Z", " UTC")) + "</b></span></div>" +
        (added ? "<p class='ok'>Added " + added + " new sheets to Search by register no. and the Merit list.</p>" : "") +
        (fails.length ? "<details><summary>Latest problems (" + (st.failures || []).length + ")</summary><ul>" + fails.map(function (f) { return "<li>" + esc(f) + "</li>"; }).join("") + "</ul></details>" : "");
    } catch (e) { console.error(e); $("kea-status").innerHTML = "<p class='bad'>" + esc(e.message) + "</p>"; }
    finally { btn.disabled = false; }
  });

  // ---------- merit list ----------
  function subjOf(id) { return (S.cfg.subjects || []).filter(function (s) { return s.id === id; })[0] || {}; }
  function paperNo(s) { var p = String(s.paper || "").toLowerCase().replace(/\s+/g, ""); return /paper(i|1)$/.test(p) ? 1 : /paper(ii|2)$/.test(p) ? 2 : 0; }
  function renderMeritSubjects() {
    var sel = $("merit-p2"), v = sel.value, ex = $("merit-exam").value;
    sel.innerHTML = '<option value="">All subjects</option>' + (S.cfg.subjects || []).filter(function (s) { return s.exam === ex && paperNo(s) === 2; })
      .map(function (s) { return '<option value="' + esc(s.id) + '">' + esc(s.subject || s.name) + "</option>"; }).join("");
    if (v && sel.querySelector('option[value="' + v + '"]')) sel.value = v;
  }
  $("merit-exam").addEventListener("change", function () { renderMeritSubjects(); showMerit(); });
  $("merit-p2").addEventListener("change", showMerit);
  $("merit-show").addEventListener("click", showMerit);
  function meritRows() {
    var ex = $("merit-exam").value, p2only = $("merit-p2").value, by = {};
    S.index.forEach(function (e) {
      var s = subjOf(e.subject); if ((s.exam || e.exam) !== ex) return;
      var n = paperNo(s), c = by[e.reg] || (by[e.reg] = { reg: e.reg, name: "", centre: "", p1: null, p2: null, p2subject: "" });
      if (e.name && !c.name) c.name = e.name;
      if (e.centre && !c.centre) c.centre = e.centre;
      if (n === 1) c.p1 = e.score;
      else if (n === 2 || n === 0) { c.p2 = e.score; c.p2subject = s.subject || e.subject_name; c.p2id = e.subject; }
    });
    var exam = (S.cfg.exams || []).filter(function (e) { return e.id === ex; })[0] || {};
    var rows = Object.keys(by).map(function (k) { var c = by[k]; c.total = (c.p1 || 0) + (c.p2 || 0); c.exam = exam.short || exam.name || ex; return c; })
      .filter(function (c) { return !p2only || c.p2id === p2only; });
    rows.sort(function (a, b) { return b.total - a.total || (b.p2 || 0) - (a.p2 || 0) || (b.p1 || 0) - (a.p1 || 0) || String(a.reg).localeCompare(String(b.reg)); });
    rows.forEach(function (r, i) { r.rank = i && rows[i - 1].total === r.total ? rows[i - 1].rank : i + 1; });
    return rows;
  }
  function showMerit() {
    if (!S.cfg) return;
    var rows = meritRows(), n1 = 0, n2 = 0;
    rows.forEach(function (r) { if (r.p1 != null) n1++; if (r.p2 != null) n2++; });
    $("merit-info").textContent = rows.length ? rows.length + " candidates (" + n1 + " with Paper I, " + n2 + " with Paper II). Ties share a rank." : "No published scores for this exam yet.";
    $("merit-table").innerHTML = rows.length ? "<tr><th>Rank</th><th>Name</th><th>Register No.</th><th>Exam</th><th>Centre</th><th>Paper I</th><th>Paper II subject</th><th>Paper II</th><th>Grand total</th></tr>" +
      rows.slice(0, 500).map(function (r) {
        return "<tr><td>" + r.rank + "</td><td>" + esc(r.name) + "</td><td>" + esc(r.reg) + "</td><td>" + esc(r.exam) + "</td><td>" + esc(r.centre) + "</td><td>" +
          (r.p1 == null ? "–" : fmt(r.p1)) + "</td><td>" + esc(r.p2subject) + "</td><td>" + (r.p2 == null ? "–" : fmt(r.p2)) + "</td><td><b>" + fmt(r.total) + "</b></td></tr>";
      }).join("") : "";
    if (rows.length > 500) $("merit-info").textContent += " Showing the top 500 here; the Excel file has everyone.";
  }
  $("merit-xlsx").addEventListener("click", async function () {
    var btn = this; btn.disabled = true;
    try {
      var rows = meritRows(); if (!rows.length) throw new Error("No published scores for this exam yet.");
      await loadScript(XLSX_URL);
      var data = [["Rank", "Name", "Register Number", "Exam", "Exam Centre", "Paper I", "Paper II Subject", "Paper II", "Grand Total"]].concat(rows.map(function (r) {
        return [r.rank, r.name, String(r.reg), r.exam, r.centre, r.p1 == null ? "" : r.p1, r.p2subject, r.p2 == null ? "" : r.p2, r.total];
      }));
      var ws = window.XLSX.utils.aoa_to_sheet(data), wb = window.XLSX.utils.book_new();
      ws["!cols"] = [{ wch: 6 }, { wch: 28 }, { wch: 16 }, { wch: 12 }, { wch: 40 }, { wch: 9 }, { wch: 18 }, { wch: 9 }, { wch: 11 }];
      window.XLSX.utils.book_append_sheet(wb, ws, "Merit list");
      var p2 = $("merit-p2").value ? "-" + $("merit-p2").value : "";
      window.XLSX.writeFile(wb, "merit-list-" + $("merit-exam").value + p2 + "-" + new Date().toISOString().slice(0, 10) + ".xlsx");
      msg("merit-info", "Downloaded " + rows.length + " candidates.", "ok");
    } catch (e) { console.error(e); msg("merit-info", e.message, "bad"); }
    finally { btn.disabled = false; }
  });

  // ---------- start ----------
  $("gh-connect").addEventListener("click", connect);
  $("gh-forget").addEventListener("click", function () {
    store("omr-gh-token", null); S.token = ""; S.vault = null; S.index = []; $("search-results").innerHTML = ""; $("gh-token").value = ""; $("admin").hidden = true; this.hidden = true;
    msg("gh-status", "Disconnected. The token was removed from this device.");
  });
  var savedRepo = recall("omr-gh-repo"), savedToken = recall("omr-gh-token");
  try { $("gh-remember").checked = !!localStorage.getItem("omr-gh-token"); } catch (e) {}
  $("gh-repo").value = savedRepo || (window.OMR_SITE && window.OMR_SITE.repo) || "";
  if (savedToken) $("gh-token").value = savedToken;
})();
