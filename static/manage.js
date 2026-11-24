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
    if (id === "tab-merit") {
      if (!candidates().length) {   // open on an exam that has scores
        var count = {}; S.index.forEach(function (e) { var x = subjOf(e.subject).exam || e.exam; count[x] = (count[x] || 0) + 1; });
        var best = Object.keys(count).sort(function (a, b) { return count[b] - count[a]; })[0];
        if (best && $("merit-exam").querySelector('option[value="' + best + '"]')) { $("merit-exam").value = best; renderMeritSubjects(); }
      }
      showMerit();
    }
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
    if (!text.trim()) throw new Error("No answers to save yet. Choose the key file (PDF, Excel or CSV) above and it will be read into the box, or type the answers.");
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
    if (keyPages.length > 1) { $("kp-save").click(); return; }   // keys read from a multi-subject PDF
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
    if (r.error) return ["bad", r.error + (r.answers_text && /version code/i.test(r.error) ? " Choose the set in the Set column to score it." : "")];
    if (OMRCrypto.digits(r.register_number).length !== 9) return ["warn", "Check the register number"];
    if (OMRCrypto.digits(r.booklet_serial).length !== 6) return ["warn", "Check the booklet number"];
    if (r.version_guessed) return ["ok", "Ready. The set was not shaded, so it was worked out from the answers (" + r.version + ")."];
    return ["ok", "Ready"];
  }
  function setCell(r, i) {
    if (r.grading && !r.set_chosen) return esc(r.version || "–") + (r.version_guessed ? " *" : "");
    if (!r.answers_text || !/version code/i.test(r.error || r.set_chosen || "")) return esc(r.version || "–");
    var sj = (S.cfg.subjects || []).filter(function (x) { return x.id === r.subject; })[0] || {};
    var codes = sj.set_codes || S.cfg.set_codes || ["A1", "B1", "C1", "D1"];
    return '<select data-i="' + i + '" data-f="set"><option value="">Choose…</option>' + codes.map(function (c) {
      return "<option" + (c === r.version ? " selected" : "") + ">" + esc(c) + "</option>"; }).join("") + "</select>";
  }
  function renderBulk() {
    var seen = {};
    var byReg = (S.cfg.results_lookup || "register_booklet") === "register";
    bulk.forEach(function (r) { var k = OMRCrypto.digits(r.register_number) + ":" + (byReg ? r.subject : OMRCrypto.digits(r.booklet_serial)); r.dup = !!seen[k]; seen[k] = 1; });
    $("bulk-table").innerHTML = "<tr><th>#</th><th>Photo</th><th>Register no.</th><th>Booklet no.</th><th>Name</th><th>Set</th><th>Score</th><th>Status</th></tr>" +
      bulk.map(function (r, i) {
        var st = r.dup ? ["warn", "Same register number as an earlier sheet"] : rowStatus(r);
        return "<tr><td>" + (i + 1) + "</td><td>" + (r.image ? '<a href="#" data-view="' + i + '">' + esc(r.file) + "</a>" : esc(r.file)) + "</td>" +
          '<td><input data-i="' + i + '" data-f="register_number" inputmode="numeric" value="' + esc(r.register_number || "") + '"></td>' +
          '<td><input data-i="' + i + '" data-f="booklet_serial" inputmode="numeric" value="' + esc(r.booklet_serial || "") + '"></td>' +
          '<td><input data-i="' + i + '" data-f="name" value="' + esc(r.name || "") + '" placeholder="Name"' + (r.name && !r.name_sure ? ' class="check" title="Read from the handwriting. Please check it."' : "") + '></td>' +
          "<td>" + setCell(r, i) + "</td><td>" + (r.grading ? fmt(r.grading.score) + " / " + fmt(r.grading.max_score) : "–") + "</td>" +
          '<td class="' + st[0] + '">' + esc(st[1]) + "</td></tr>";
      }).join("");
    var ready = bulk.filter(function (r) { return !r.dup && rowStatus(r)[0] === "ok"; }).length;
    $("bulk-publish").disabled = !ready; $("bulk-csv").disabled = !bulk.length;
    $("bulk-publish").textContent = ready ? "Publish " + ready + " result" + (ready > 1 ? "s" : "") : "Publish results";
  }
  $("bulk-table").addEventListener("click", function (ev) {
    var a = ev.target.closest && ev.target.closest("a[data-view]"); if (!a) return;
    ev.preventDefault();
    var r = bulk[+a.dataset.view], url = URL.createObjectURL(new Blob([r.image], { type: "image/jpeg" }));
    window.open(url, "_blank"); setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  });
  $("bulk-table").addEventListener("change", function (ev) {
    var t = ev.target; if (!t.dataset || t.dataset.i == null) return;
    var r = bulk[+t.dataset.i];
    if (t.dataset.f === "set") { chooseSet(r, t.value); return; }
    if (t.dataset.f === "name") { r.name = t.value.trim().toUpperCase().slice(0, 80); r.name_sure = true; }
    else {
      r[t.dataset.f] = OMRCrypto.digits(t.value);
      if (t.dataset.f === "register_number" && r.grading && /register/i.test(r.error || "")) r.error = null;   // fixed by hand
    }
    renderBulk();
  });
  // The version code was not shaded: the admin looks at the sheet and picks the set.
  async function chooseSet(r, code) {
    if (!r.set_chosen) r.set_chosen = r.error;
    if (!code) { r.grading = null; r.version = null; r.error = r.set_chosen; renderBulk(); return; }
    var g = await OMREngine.call("omr_grade_manual", r.subject, code, r.answers_text);
    if (g.error) { r.error = g.error; r.grading = null; }
    else { r.grading = g.grading; r.version = code; r.error = null; }
    renderBulk();
  }
  async function expandPdfs(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      if (!OMRPdf.isPdf(f)) { out.push({ name: f.name, bytes: (function (f) { return async function () { return new Uint8Array(await f.arrayBuffer()); }; })(f) }); continue; }
      $("bulk-status").textContent = "Opening " + f.name + "…";
      out = out.concat(await OMRPdf.pages(f));
    }
    return out;
  }
  // Bulk scan keeps its place: if it stops (no internet, the scanner failed to load, the
  // browser ran short of memory), Continue picks up at the next sheet and retries the sheets
  // that failed for that reason. Sheets already read are kept.
  var bulkFiles = [], bulkPos = 0, bulkSubject = "";
  async function online() {
    if (navigator.onLine === false) return false;
    try { await fetch(location.href.split("#")[0], { method: "HEAD", cache: "no-store" }); return true; } catch (e) { return false; }
  }
  async function runBulk() {
    var btn = $("bulk-scan"), cont = $("bulk-continue"); btn.disabled = true; cont.hidden = true; msg("bulk-msg", "");
    $("bulk-progress").hidden = false; var bar = $("bulk-progress").firstElementChild;
    try {
      if (!OMREngine.isLoaded()) $("bulk-status").textContent = "Loading the scanner (first time only)…";
      await OMREngine.load();
      // first the sheets that failed because the scan was interrupted
      for (var j = 0; j < bulk.length; j++) {
        if (!bulk[j].retry) continue;
        $("bulk-status").textContent = "Trying " + bulk[j].file + " again…";
        var again = await readOne(bulk[j].src);
        again.file = bulk[j].file; again.src = bulk[j].src; bulk[j] = again; renderBulk();
        if (again.retry) throw again.cause;
      }
      for (; bulkPos < bulkFiles.length; bulkPos++) {
        var i = bulkPos;
        $("bulk-status").textContent = "Reading sheet " + (i + 1) + " of " + bulkFiles.length + "…";
        await new Promise(function (r) { setTimeout(r, 10); });
        var r = await readOne(bulkFiles[i]);
        r.file = bulkFiles[i].name; r.src = bulkFiles[i]; bulk.push(r);
        bar.style.width = ((i + 1) / bulkFiles.length * 100).toFixed(1) + "%";
        renderBulk();
        if (r.retry) { bulkPos++; throw r.cause; }
      }
      var ok = bulk.filter(function (r) { return r.grading; }).length;
      $("bulk-status").textContent = "Read " + bulk.length + " sheet" + (bulk.length > 1 ? "s" : "") + ": " + ok + " scored, " + (bulk.length - ok) + " need a look.";
    } catch (e) {
      console.error(e);
      var net = !(await online());
      msg("bulk-msg", (net ? "The internet connection was lost" : "The scan stopped (" + ((e && e.message) || "the scanner had a problem") + ")") +
        " after " + bulkPos + " of " + bulkFiles.length + " sheets. The sheets already read are kept. " +
        (net ? "Check the connection, then press Continue." : "Press Continue to carry on from where it stopped; if it stops again, reload the page with Ctrl+F5 and scan the rest."), "bad");
      $("bulk-status").textContent = "Stopped at sheet " + Math.min(bulkPos + 1, bulkFiles.length) + " of " + bulkFiles.length + ".";
      cont.hidden = false;
    } finally { btn.disabled = false; }
  }
  // One sheet. A problem with the sheet itself is its result; a problem with the scanner or
  // the connection marks it for another try.
  async function readOne(f) {
    try {
      var r = await OMREngine.call("omr_run", await f.bytes(), bulkSubject, "", true, 72);
      if (r.annotated_b64) { r.image = OMRCrypto.unb64(r.annotated_b64); delete r.annotated_b64; }
      return r;
    } catch (e) {
      return { scan_error: "Not read yet: the scan was interrupted here. Press Continue to try it again.", retry: true, cause: e };
    }
  }
  $("bulk-scan").addEventListener("click", async function () {
    var files = Array.prototype.slice.call($("bulk-files").files);
    if (!files.length) { msg("bulk-msg", "Choose the OMR sheet photos first.", "bad"); return; }
    if (bulkPos < bulkFiles.length && !window.confirm("The last scan stopped at sheet " + (bulkPos + 1) + " of " + bulkFiles.length + ". Start again from the first sheet? (Press Cancel, then Continue, to carry on instead.)")) return;
    this.disabled = true; bulk = []; renderBulk(); bulkSubject = $("bulk-subject").value; bulkPos = 0;
    $("bulk-progress").firstElementChild.style.width = "0";
    try { bulkFiles = await expandPdfs(files); }   // a centre PDF from KEA becomes one sheet per page
    catch (e) { console.error(e); this.disabled = false; msg("bulk-msg", "Could not open the PDF. Check the internet connection (the PDF reader loads from the web) and try again.", "bad"); return; }
    await runBulk();
  });
  $("bulk-continue").addEventListener("click", async function () {
    if (!(await online())) { msg("bulk-msg", "Still no internet connection. Check it, then press Continue again.", "bad"); return; }
    await runBulk();
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
        S.index.push({ reg: r.register_number, booklet: r.booklet_serial, name: r.name || "", name_sure: r.name_sure !== false, subject: r.subject, subject_name: r.subject_name, exam_short: r.exam_short,
          set: r.version, score: g.score, max: g.max_score, counts: g.counts, photo: r.file, sheet: sheet, sheet_key: sk, published: when,
          centre: r.centre || "", district: r.district || "", source: r.review_path ? "kea" : "upload" });
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
    if (f && OMRPdf.isPdf(f)) {
      try {
        msg("one-msg", "Opening the PDF…");
        var pg = (await OMRPdf.pages(f))[0], blob = await pg.blob();
        f = new File([blob], f.name.replace(/\.pdf$/i, "") + ".jpg", { type: "image/jpeg" }); one.raw = f; msg("one-msg", "");
      } catch (e) { console.error(e); msg("one-msg", e.message || "This PDF could not be opened.", "bad"); f = null; one.raw = null; }
    }
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
      if (r.name && !$("one-name").value) $("one-name").value = r.name;
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
  // Scanned key PDFs (like KEA's) are pictures: each page is read by the scanner, which finds
  // the Q No / A1 B1 C1 D1 table and reads the printed digits. A PDF can hold keys for several subjects.
  var keyPages = [];
  async function readKeyPdf(f, sid) {
    var pages = await OMRPdf.pages(f), found = [];
    for (var i = 0; i < pages.length; i++) {
      msg("key-msg", "Reading page " + (i + 1) + " of " + pages.length + (OMREngine.isLoaded() ? "…" : " (loading the reader, first time only)…"));
      var blob = await pages[i].blob(), r = await OMREngine.call("omr_read_key_page", new Uint8Array(await blob.arrayBuffer()), sid);
      if (!r.error && r.rows >= 10) found.push({ page: i + 1, text: r.text, unsure: r.unsure, rows: r.rows, img: URL.createObjectURL(blob) });
    }
    return found;
  }
  function subjectSelect(id, value) {
    return '<select id="' + id + '"><option value="">Don\'t save this page</option>' + subjectOptions(null).replace('value="' + value + '"', 'value="' + value + '" selected') + "</select>";
  }
  function showKeyPages() {
    var box = $("key-pages");
    if (keyPages.length < 2) { box.innerHTML = ""; box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = "<h3>This PDF has " + keyPages.length + " answer keys</h3><p class='muted'>Choose the subject for each page (the page heading is shown), then press Save all keys (or Save to website below).</p>" +
      keyPages.map(function (k, i) {
        return '<div class="keypage"><div class="keyhead"><img alt="Heading of page ' + k.page + '" src="' + k.img + '"></div>' +
          "<p><b>Page " + k.page + "</b>: " + k.rows + " questions read" + (k.unsure.length ? ", <span class='bad'>check questions " + k.unsure.join(", ") + "</span>" : ", all clear") + "</p>" +
          subjectSelect("kp-subj-" + i, k.subject || "") + ' <button type="button" class="linkbtn" data-kp-edit="' + i + '">Show / edit this key</button></div>';
      }).join("") + '<p></p><button class="btn" type="button" id="kp-save">Save all keys</button>';
  }
  $("key-pages").addEventListener("change", function (ev) {
    var m = ev.target.id && ev.target.id.match(/^kp-subj-(\d+)$/); if (m) keyPages[+m[1]].subject = ev.target.value;
  });
  $("key-pages").addEventListener("click", async function (ev) {
    var e = ev.target.closest("[data-kp-edit]");
    if (e) {
      var k = keyPages[+e.dataset.kpEdit]; if (!k.subject) { msg("key-msg", "Choose the subject for page " + k.page + " first.", "bad"); return; }
      $("key-subject").value = k.subject; renderKeySets(); $("key-text").value = k.text;
      try { var p = await prepareKeys(); showKeyPreview(p); msg("key-msg", "Page " + k.page + " is in the box below. Press Save to save just this one, or Save all keys above.", "ok"); }
      catch (err) { msg("key-msg", err.message, "bad"); }
      $("key-text").scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if (ev.target.id !== "kp-save") return;
    var btn = ev.target; btn.disabled = true;
    try {
      var files = {}, names = [], used = {};
      for (var i = 0; i < keyPages.length; i++) {
        var kp = keyPages[i]; if (!kp.subject) continue;
        if (used[kp.subject]) throw new Error("Two pages are set to the same subject (" + subjOf(kp.subject).name + ").");
        used[kp.subject] = true;
        var t = await OMREngine.call("omr_parse_table", kp.text, kp.subject);
        if (t.error) throw new Error("Page " + kp.page + ": " + t.error + ". Use Show / edit this key to fix it.");
        for (var set in t.keys) if (Object.keys(t.keys[set]).length) {
          var merged = Object.assign({}, (S.keys[kp.subject] || {})[set] || {}, t.keys[set]);
          files["keys/" + kp.subject + "/" + set + ".txt"] = await OMREngine.keyText(merged);
          (S.keys[kp.subject] = S.keys[kp.subject] || {})[set] = merged;
        }
        names.push(subjOf(kp.subject).name);
      }
      if (!names.length) throw new Error("Choose a subject for at least one page.");
      msg("key-msg", "Saving…");
      await commit(files, "Update answer keys from PDF: " + names.join(", "));
      await OMREngine.setFiles(files); renderAll();
      msg("key-msg", "Saved the keys for " + names.join(", ") + ". The website shows them, and candidates can check their scores, in about 2 minutes.", "ok");
      keyPages = []; showKeyPages(); $("key-preview").innerHTML = "";
    } catch (err) { console.error(err); msg("key-msg", err.message, "bad"); }
    finally { btn.disabled = false; }
  });
  $("key-file").addEventListener("change", async function () {
    var f = this.files[0]; if (!f) return;
    var sid = $("key-subject").value, nsets = sc(sid).set_codes.length;
    $("key-pick").innerHTML = '<span class="cam" aria-hidden="true">📄</span>' + esc(f.name);
    msg("key-msg", "Reading " + f.name + "…"); keyPages = []; showKeyPages(); $("key-preview").innerHTML = "";
    try {
      var buf = new Uint8Array(await f.arrayBuffer()), name = f.name.toLowerCase(), rows = null, text = "", note = "";
      if (OMRPdf.isPdf(f)) {
        keyPages = await readKeyPdf(f, sid);
        if (keyPages.length > 1) {
          keyPages[0].subject = sid;
          showKeyPages();
          msg("key-msg", "Read " + keyPages.length + " answer keys from " + f.name + ". Choose the subject for each page, then press Save all keys.", "ok");
          return;
        }
        if (keyPages.length === 1) { text = keyPages[0].text; if (keyPages[0].unsure.length) note = " Questions " + keyPages[0].unsure.join(", ") + " could not be read clearly and show ?: type the right answer in the box."; keyPages = []; }
        else rows = await pdfRows(buf);   // a PDF with real text in it
      }
      else if (/\.(xlsx|xls|csv)$/.test(name)) rows = await sheetRows(buf);
      else rows = new TextDecoder().decode(buf).split(/\r?\n/).map(function (l) { return l.split(/[\s,;\t]+/); });
      if (rows) text = rowsToKeyText(rows, nsets);
      if (!text) throw new Error("No answer table was found in this file. Check it is the answer key, or type the answers in.");
      document.querySelector("input[name=key-mode][value=table]").checked = true; $("key-set-wrap").hidden = true; renderKeySets();
      $("key-text").value = text;
      try {
        var p = await prepareKeys(); showKeyPreview(p);
        msg("key-msg", "Read from " + f.name + ": " + describe(p) + ". Check the preview, then press Save." + note, "ok");
      } catch (e) { msg("key-msg", e.message + "." + note, "bad"); }
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
    try { await keaRequest(true); msg("kea-msg", "Stopping. The fetch stops after the centre it is working on. Press Continue from where it stopped to carry on.", "ok"); }
    catch (e) { msg("kea-msg", e.message, "bad"); } finally { btn.disabled = false; }
  });
  // Carry on the same fetch (same id), so the centres already done are skipped.
  $("kea-continue").addEventListener("click", async function () {
    var btn = this; btn.disabled = true;
    try {
      if (!(await online())) throw new Error("No internet connection. Check the connection, then press Continue again.");
      await loadTree();
      var old = await readFile(KEA_REQ);
      if (!old) throw new Error("No fetch has been started yet. Press Start a new fetch.");
      old = JSON.parse(old); old.stop = false; old.retry = (old.retry || 0) + 1;
      await commit({ "admin/kea-request.json": JSON.stringify(old, null, 1) + "\n" }, "Continue the KEA fetch: " + (old.kea_exam || ""));
      msg("kea-msg", "Continuing. GitHub carries on from the next centre in about a minute; the centres already done are kept.", "ok");
    } catch (e) { console.error(e); msg("kea-msg", e.message, "bad"); }
    finally { btn.disabled = false; }
  });
  $("kea-recheck").addEventListener("click", async function () {
    var btn = this; btn.disabled = true;
    try {
      if (!(await online())) throw new Error("No internet connection. Check the connection and try again.");
      await loadTree();
      var old = await readFile(KEA_REQ);
      if (!old) throw new Error("No fetch has been started yet.");
      old = JSON.parse(old); old.stop = false; old.recheck = (old.recheck || 0) + 1;
      await commit({ "admin/kea-request.json": JSON.stringify(old, null, 1) + "\n" }, "Read again the KEA centres with problems");
      msg("kea-msg", "GitHub fetches the centres that had problems again in about a minute and reads them with the newest reader. Their good sheets are published again (that only replaces them). Press Refresh progress to follow it.", "ok");
    } catch (e) { console.error(e); msg("kea-msg", e.message, "bad"); }
    finally { btn.disabled = false; }
  });
  // Sheets the fetch could not publish come to the admin (encrypted) in admin/review/. Open
  // them in the bulk table, leaving out the ones published since.
  $("kea-review").addEventListener("click", async function () {
    var btn = this; btn.disabled = true;
    try {
      await loadTree(); await loadIndex();
      var paths = Object.keys(S.tree).filter(function (p) { return /^admin\/review\/[\w.-]+\.bin$/.test(p); }).sort();
      if (!paths.length) { msg("kea-msg", "There are no fetched sheets waiting for a look.", "ok"); return; }
      var rows = [];
      for (var i = 0; i < paths.length; i++) {
        msg("kea-msg", "Opening " + (i + 1) + " of " + paths.length + "…");
        var data;
        try { data = await OMRCrypto.openForAdmin(S.priv, new TextDecoder().decode(await getBlob(S.tree[paths[i]]))); }
        catch (e) { console.error("review", paths[i], e); continue; }
        (data.rows || []).forEach(function (r) {
          var done = r.register_number && S.index.some(function (e) { return e.reg === r.register_number && e.subject === r.subject; });
          if (done) return;
          if (r.image_b64) { r.image = OMRCrypto.unb64(r.image_b64); delete r.image_b64; }
          r.review_path = paths[i]; rows.push(r);
        });
      }
      if (!rows.length) { msg("kea-msg", "All the fetched sheets that needed a look have been published.", "ok"); return; }
      bulk = rows; bulkFiles = []; bulkPos = 0; renderBulk(); openTab("tab-bulk");
      $("bulk-status").textContent = rows.length + " fetched sheet" + (rows.length > 1 ? "s" : "") + " need a look. Open a sheet with its link, choose the set or correct the numbers, then press Publish.";
      msg("kea-msg", "Opened " + rows.length + " sheets in the Bulk OMR upload tab.", "ok");
      $("bulk-table").scrollIntoView({ behavior: "smooth" });
    } catch (e) { console.error(e); msg("kea-msg", e.message, "bad"); }
    finally { btn.disabled = false; }
  });
  $("kea-refresh").addEventListener("click", async function () {
    var btn = this; btn.disabled = true; $("kea-status").innerHTML = "<p class='muted'>Loading…</p>";
    try {
      await loadTree();
      var added = await mergeInbox(); if (added) showSearch("");
      var st = await readFile(KEA_STATE), req = await readFile(KEA_REQ);
      if (!st) { $("kea-status").innerHTML = "<p class='muted'>" + (req ? "Waiting for GitHub to start." : "No fetch has been started yet.") + "</p>"; return; }
      st = JSON.parse(st); req = req ? JSON.parse(req) : {};
      if (req.id && st.request !== req.id && !req.stop) { $("kea-status").innerHTML = "<p><b>Starting</b><br>GitHub is starting the new fetch (" + esc(req.kea_exam || "") + "). Press Refresh progress again in a minute.</p>"; return; }
      var t = st.totals || {}, label = { running: "Running", paused: "Paused, carries on in the next run", blocked: "KEA is limiting requests, will try again later",
        captcha: "Stopped: KEA asked for a captcha", done: "Finished", stopped: "Stopped", error: "Stopped with a problem" }[st.status] || st.status;
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
  function hasPaper2(ex) { return (S.cfg.subjects || []).some(function (s) { return s.exam === ex && paperNo(s) === 2; }); }
  function renderMeritSubjects() {
    var ex = $("merit-exam").value, two = hasPaper2(ex), mode = $("merit-mode"), mv = mode.value;
    mode.innerHTML = two ? '<option value="both">Paper I + Paper II (grand total)</option><option value="p1">Paper I only</option><option value="p2">Paper II only</option>' : '<option value="p1">Paper I</option>';
    if (mv && mode.querySelector('option[value="' + mv + '"]')) mode.value = mv;
    var sel = $("merit-p2"), v = sel.value;
    sel.innerHTML = '<option value="">All subjects</option>' + (S.cfg.subjects || []).filter(function (s) { return s.exam === ex && paperNo(s) === 2; })
      .map(function (s) { return '<option value="' + esc(s.id) + '">' + esc(s.subject || s.name) + "</option>"; }).join("");
    if (v && sel.querySelector('option[value="' + v + '"]')) sel.value = v;
    $("merit-p2-wrap").hidden = !two || mode.value === "p1";
  }
  $("merit-exam").addEventListener("change", function () { renderMeritSubjects(); showMerit(); });
  $("merit-mode").addEventListener("change", function () { renderMeritSubjects(); showMerit(); });
  $("merit-p2").addEventListener("change", showMerit);
  $("merit-show").addEventListener("click", showMerit);
  // One row per candidate; then a ranked list for the chosen view ("both", "p1" or "p2").
  function candidates() {
    var ex = $("merit-exam").value, by = {};
    S.index.forEach(function (e) {
      var s = subjOf(e.subject); if ((s.exam || e.exam) !== ex) return;
      var n = paperNo(s), c = by[e.reg] || (by[e.reg] = { reg: e.reg, name: "", centre: "", p1: null, p2: null, p2subject: "", p2id: "" });
      if (e.name && (!c.name || (e.name_sure !== false && c.name_sure === false))) { c.name = e.name; c.name_sure = e.name_sure; }
      if (e.centre && !c.centre) c.centre = e.centre;
      if (n === 2) { c.p2 = e.score; c.p2subject = s.subject || e.subject_name; c.p2id = e.subject; }
      else c.p1 = e.score;
    });
    var exam = (S.cfg.exams || []).filter(function (e) { return e.id === ex; })[0] || {};
    return Object.keys(by).map(function (k) { var c = by[k]; c.exam = exam.short || exam.name || ex; return c; });
  }
  function ranked(mode, p2only) {
    var rows = candidates().filter(function (c) {
      if (mode === "p1") return c.p1 != null;
      if (mode === "p2") return c.p2 != null && (!p2only || c.p2id === p2only);
      return !p2only || c.p2id === p2only;
    }).map(function (c) { var r = Object.assign({}, c); r.total = mode === "p1" ? c.p1 : mode === "p2" ? c.p2 : (c.p1 || 0) + (c.p2 || 0); return r; });
    rows.sort(function (a, b) { return b.total - a.total || (b.p2 || 0) - (a.p2 || 0) || (b.p1 || 0) - (a.p1 || 0) || String(a.reg).localeCompare(String(b.reg)); });
    rows.forEach(function (r, i) { r.rank = i && rows[i - 1].total === r.total ? rows[i - 1].rank : i + 1; });
    return rows;
  }
  function meritColumns(mode) {
    var c = [["Rank", "rank"], ["Name", "name"], ["Register Number", "reg"], ["Exam", "exam"], ["Exam Centre", "centre"]];
    if (mode === "p1") return c.concat([["Paper I", "p1"]]);
    if (mode === "p2") return c.concat([["Paper II Subject", "p2subject"], ["Paper II", "p2"]]);
    return c.concat([["Paper I", "p1"], ["Paper II Subject", "p2subject"], ["Paper II", "p2"], ["Grand Total", "total"]]);
  }
  function showMerit() {
    if (!S.cfg) return;
    var mode = $("merit-mode").value || "p1", rows = ranked(mode, $("merit-p2").value), cols = meritColumns(mode);
    var label = { both: "Paper I + Paper II", p1: "Paper I", p2: "Paper II" }[mode];
    $("merit-info").className = "muted";
    $("merit-info").textContent = rows.length ? label + ": " + rows.length + " candidate" + (rows.length === 1 ? "" : "s") + ", topper first. Ties share a rank." :
      "No published scores for " + ($("merit-exam").selectedOptions[0] || {}).textContent + " (" + label + ") yet.";
    $("merit-table").innerHTML = rows.length ? "<tr>" + cols.map(function (c) { return "<th>" + c[0] + "</th>"; }).join("") + "</tr>" +
      rows.slice(0, 500).map(function (r) {
        return "<tr>" + cols.map(function (c) {
          var v = r[c[1]], num = c[1] === "p1" || c[1] === "p2" || c[1] === "total";
          return "<td>" + (num ? (v == null ? "–" : (c[1] === "total" ? "<b>" + fmt(v) + "</b>" : fmt(v))) : esc(v)) + "</td>"; }).join("") + "</tr>";
      }).join("") : "";
    if (rows.length > 500) $("merit-info").textContent += " Showing the top 500 here; the Excel file has everyone.";
  }
  $("merit-xlsx").addEventListener("click", async function () {
    var btn = this; btn.disabled = true;
    try {
      var ex = $("merit-exam").value, p2only = $("merit-p2").value, modes = hasPaper2(ex) ? ["both", "p1", "p2"] : ["p1"];
      var names = { both: "Paper I + II", p1: "Paper I", p2: "Paper II" }, wb = null, total = 0;
      await loadScript(XLSX_URL);
      wb = window.XLSX.utils.book_new();
      modes.forEach(function (m) {
        var rows = ranked(m, m === "p1" ? "" : p2only), cols = meritColumns(m); if (!rows.length) return;
        total = Math.max(total, rows.length);
        var data = [cols.map(function (c) { return c[0]; })].concat(rows.map(function (r) {
          return cols.map(function (c) { var v = r[c[1]]; return v == null ? "" : c[1] === "reg" ? String(v) : v; });
        }));
        var ws = window.XLSX.utils.aoa_to_sheet(data);
        ws["!cols"] = cols.map(function (c) { return { wch: { name: 28, centre: 40, reg: 16, p2subject: 18 }[c[1]] || 11 }; });
        window.XLSX.utils.book_append_sheet(wb, ws, names[m]);
      });
      if (!total) throw new Error("No published scores for this exam yet.");
      window.XLSX.writeFile(wb, "merit-list-" + ex + (p2only ? "-" + p2only : "") + "-" + new Date().toISOString().slice(0, 10) + ".xlsx");
      msg("merit-info", "Downloaded the merit list (" + wb.SheetNames.join(", ") + ").", "ok");
    } catch (e) { console.error(e); msg("merit-info", e.message, "bad"); }
    finally { btn.disabled = false; }
  });


  // ---------- stale page check ----------
  // Browsers may keep an old copy of this page for a while after an update. If the live page
  // links a newer manage.js than the one running, say so and offer to reload.
  (function () {
    var me = Array.prototype.filter.call(document.scripts, function (sc) { return /manage\.js/.test(sc.src); })[0];
    if (!me) return;
    var mine = (me.src.match(/[?&]v=(\w+)/) || [])[1];
    fetch(location.href.split("#")[0], { cache: "no-store" }).then(function (r) { return r.text(); }).then(function (html) {
      var live = (html.match(/manage\.js\?v=(\w+)/) || [])[1];
      if (!mine || !live || mine === live) return;
      var bar = document.createElement("div");
      bar.className = "note"; bar.style.cssText = "position:sticky;top:0;z-index:50;margin:0 0 12px;font-weight:700";
      bar.innerHTML = 'A newer version of this admin page is available. <button type="button" class="btn" style="width:auto;padding:6px 14px;margin-left:8px">Reload now</button>';
      bar.querySelector("button").addEventListener("click", function () { location.reload(); });
      var main = document.querySelector("main") || document.body; main.insertBefore(bar, main.firstChild);
    }).catch(function () {});
  })();

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
