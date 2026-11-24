// Loads the Python scanner (omr/scanner.py, omr/keys.py) into the browser with Pyodide.
// Used by the score checker (browser-scan.js) and the admin page (manage.js).
(function () {
  "use strict";
  var GLUE = [
    "import sys, json, base64, importlib, cv2",
    "sys.path.insert(0, '/omr-app')",
    "from omr import scanner as S, keys as K",
    "def omr_run(data, subject, name, want_image=True, quality=85):",
    "    c0 = K.load_config()",
    "    subj, exam = K.find_subject(c0, subject)",
    "    c = K.subject_config(c0, subject)",
    "    exam = exam or {}",
    "    if exam.get('omr_layout', 'kea_kreis') != 'kea_kreis':",
    "        return json.dumps({'scan_error': 'Reading ' + exam.get('name', '') + ' OMR sheets is coming soon. You can see the answer key on the ' + exam.get('name', '') + ' page.'})",
    "    try:",
    "        res = S.scan(bytes(data), c['num_questions'])",
    "    except S.ScanError as e:",
    "        return json.dumps({'scan_error': str(e)})",
    "    out = {'subject': subject, 'subject_name': (subj or {}).get('name', subject), 'exam': exam.get('id', ''), 'exam_short': exam.get('short', ''), 'name': name, 'version': res['version'],",
    "           'register_number': res['register_number'], 'booklet_serial': res['booklet_serial'],",
    "           'register_complete': res['register_complete'], 'serial_complete': res.get('serial_complete', True),",
    "           'grading': None, 'error': None}",
    "    out['name'] = name or res.get('candidate_name', '')",
    "    out['name_sure'] = bool(name) or res.get('name_sure', False)",
    "    if not res['version'] and K.load_key(subject, c['set_codes'][0], c):",
    "        g, counts = K.guess_set(res['answers'], subject, c)",
    "        if g:",
    "            res['version'] = out['version'] = g",
    "            out['version_guessed'] = True",
    "    if not res['version']:",
    "        out['error'] = 'Could not read the Question Booklet Version Code bubbles (' + str(res['version_note']) + '). Please check that one letter and one number are shaded.'",
    "    elif res['version'] not in c['set_codes']:",
    "        out['error'] = 'Version code ' + res['version'] + ' is not one of ' + ', '.join(c['set_codes']) + '.'",
    "    else:",
    "        key = K.load_key(subject, res['version'], c)",
    "        if key is None:",
    "            out['error'] = 'The answer key for ' + out['subject_name'] + ', set ' + res['version'] + ' is coming soon. Please check again later.'",
    "        else:",
    "            out['grading'] = K.grade(res['answers'], key, c)",
    "    out['answers_text'] = ' '.join(a['answer'] if a['status'] == 'ok' else ('*' if a['status'] == 'multiple' else '0') for a in res['answers'])",
    "    if want_image:",
    "        img = S.annotate(res, out['grading'])",
    "        ok, buf = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, int(quality)])",
    "        out['annotated_b64'] = base64.b64encode(buf.tobytes()).decode()",
    "    out['marking'] = c['marking']",
    "    out['five'] = c.get('not_attempted_option', '5')",
    "    return json.dumps(out)",
    "def omr_grade_manual(subject, set_code, text):",
    "    c0 = K.load_config()",
    "    subj, exam = K.find_subject(c0, subject)",
    "    c = K.subject_config(c0, subject)",
    "    exam = exam or {}",
    "    try:",
    "        answers = K.parse_answers(text, c['options'], c['num_questions'])",
    "    except ValueError as e:",
    "        return json.dumps({'error': str(e)})",
    "    key = K.load_key(subject, set_code, c)",
    "    if key is None:",
    "        return json.dumps({'error': 'There is no answer key for ' + (subj or {}).get('name', subject) + ', set ' + set_code + ' yet. Add it in the Answer keys tab first.'})",
    "    return json.dumps({'subject': subject, 'subject_name': (subj or {}).get('name', subject), 'exam': exam.get('id', ''), 'exam_short': exam.get('short', ''),",
    "                       'version': set_code, 'grading': K.grade(answers, key, c), 'error': None, 'marking': c['marking'], 'five': c.get('not_attempted_option', '5')})",
    "def omr_parse_table(text, subject=''):",
    "    c = K.subject_config(K.load_config(), subject) if subject else K.load_config()",
    "    try:",
    "        t = K.parse_table(text, c['set_codes'], c['options'], c['num_questions'])",
    "    except ValueError as e:",
    "        return json.dumps({'error': str(e)})",
    "    return json.dumps({'keys': {s: {str(q): a for q, a in k.items()} for s, k in t.items()}})",
    "def omr_parse_key(text, subject=''):",
    "    c = K.subject_config(K.load_config(), subject) if subject else K.load_config()",
    "    try:",
    "        k = K.parse_key(text, c['options'], c['num_questions'])",
    "    except ValueError as e:",
    "        return json.dumps({'error': str(e)})",
    "    return json.dumps({'key': {str(q): a for q, a in k.items()}})",
    "def omr_read_key_page(data, subject=''):",
    "    from omr import keyread as KR",
    "    c = K.subject_config(K.load_config(), subject) if subject else K.load_config()",
    "    try:",
    "        r = KR.read_key_page(bytes(data), len(c['set_codes']))",
    "    except KR.KeyReadError as e:",
    "        return json.dumps({'error': str(e)})",
    "    return json.dumps({'text': KR.key_text(r['rows'], c['set_codes']), 'unsure': r['unsure'], 'rows': len(r['rows'])})",
    "def omr_key_text(js):",
    "    return K.key_to_text({int(q): a for q, a in json.loads(js).items()}) + '\\n'"
  ].join("\n");

  var ready = null, overrides = {};

  function write(py, files) {
    Object.keys(files).forEach(function (path) {
      var full = "/omr-app/" + path;
      py.FS.mkdirTree(full.substring(0, full.lastIndexOf("/")));
      py.FS.writeFile(full, files[path]);
    });
  }

  function load() {
    if (ready) return ready;
    ready = (async function () {
      var py = await loadPyodide();
      var bundle = await (await fetch(window.OMR_BUNDLE)).json();
      write(py, bundle);
      write(py, overrides);
      await py.loadPackage(["numpy", "opencv-python"]);
      py.runPython(GLUE);
      return py;
    })();
    ready.catch(function () { ready = null; });
    return ready;
  }

  // Replace config.json / keys with newer copies (the admin page loads them from the repo).
  async function setFiles(files) {
    Object.assign(overrides, files);
    if (ready) write(await ready, files);
  }

  async function call(name) {
    var py = await load();
    var fn = py.globals.get(name);
    try { return JSON.parse(fn.apply(null, Array.prototype.slice.call(arguments, 1).map(function (a) { return a instanceof Uint8Array ? py.toPy(a) : a; }))); }
    finally { fn.destroy(); }
  }
  async function keyText(key) {
    var py = await load(); var fn = py.globals.get("omr_key_text");
    try { return fn(JSON.stringify(key)); } finally { fn.destroy(); }
  }

  window.OMREngine = { load: load, setFiles: setFiles, call: call, keyText: keyText, isLoaded: function () { return !!ready; } };
})();
