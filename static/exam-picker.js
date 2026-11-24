// Exam → paper → subject pickers (score checker and results search). The chosen subject id
// goes into the hidden "subject" field.
function OMRPicker(opts) {
  "use strict";
  opts = opts || {};
  var EXAMS = window.OMR_EXAMS || [];
  var $ = function (id) { return document.getElementById(id); };
  var hidden = $("subject"), note = $("exam-note"), form = hidden.form;
  var btn = form && form.querySelector("button[type=submit]");
  var cur = null;
  function setSubject(s) {
    hidden.value = s ? s.id : ""; hidden.dispatchEvent(new Event("change"));
    var msg = "";
    if (opts.check) {
      if (!cur.scan) msg = "Checking " + cur.name + " scores from a photo of the OMR sheet is coming soon. You can see the answer keys on the " + cur.name + " page.";
      else if (s && !s.key) msg = "The answer key for " + cur.short + " " + s.name + " is coming soon. Please check again later.";
    }
    if (note) { note.textContent = msg; note.hidden = !msg; }
    if (btn) btn.disabled = !!msg;
  }
  function papers() { var seen = []; cur.subjects.forEach(function (s) { if (seen.indexOf(s.paper) < 0) seen.push(s.paper); }); return seen; }
  function pickPaper(p, sid) {
    var subs = cur.subjects.filter(function (s) { return s.paper === p; });
    $("subject-pick").innerHTML = (subs.length > 1 ? '<option value="">Choose your subject</option>' : "") + subs.map(function (s) {
      return '<option value="' + s.id + '">' + s.subject + (opts.check && !s.key ? " (key coming soon)" : "") + "</option>"; }).join("");
    $("subject-wrap").hidden = subs.length < 2;
    var chosen = subs.filter(function (s) { return s.id === sid; })[0] || (subs.length === 1 ? subs[0] : null);
    $("subject-pick").value = chosen ? chosen.id : "";
    setSubject(chosen);
  }
  function pickExam(id, sid) {
    cur = EXAMS.filter(function (e) { return e.id === id; })[0] || EXAMS[0];
    Array.prototype.forEach.call(document.querySelectorAll("#exam-chips button"), function (b) { b.classList.toggle("on", b.dataset.exam === cur.id); });
    var ps = papers(), pre = cur.subjects.filter(function (s) { return s.id === sid; })[0];
    $("paper").innerHTML = ps.map(function (p) { return "<option>" + p + "</option>"; }).join("");
    $("paper").value = pre ? pre.paper : ps[0];
    pickPaper($("paper").value, sid);
  }
  $("exam-chips").addEventListener("click", function (ev) { var b = ev.target.closest("button"); if (b) pickExam(b.dataset.exam); });
  $("paper").addEventListener("change", function () { pickPaper(this.value); });
  $("subject-pick").addEventListener("change", function () {
    var v = this.value; setSubject(cur.subjects.filter(function (s) { return s.id === v; })[0]);
  });
  var q = new URLSearchParams(location.search), sid = q.get("subject") || hidden.value;
  var ex = q.get("exam") || (EXAMS.filter(function (e) { return e.subjects.some(function (s) { return s.id === sid; }); })[0] || EXAMS[0]).id;
  pickExam(ex, sid);
  return { exam: function () { return cur; } };
}
