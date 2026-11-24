// Loads the Python scanner (omr/scanner.py, omr/keys.py) into the browser with Pyodide.
// Used by the score checker (browser-scan.js) and the admin page (manage.js).
(function () {
  "use strict";
  var GLUE = [
    "import sys, json, base64, importlib, cv2",
    "sys.path.insert(0, '/omr-app')",
    "from omr import scanner as S, keys as K",
    "def omr_run(data, subject, name, want_image=True, quality=85):",
    "    c = K.load_config()",
    "    names = {s['id']: s['name'] for s in c['subjects']}",
    "    try:",
    "        res = S.scan(bytes(data), c['num_questions'])",
    "    except S.ScanError as e:",
    "        return json.dumps({'scan_error': str(e)})",
    "    out = {'subject': subject, 'subject_name': names.get(subject, subject), 'name': name, 'version': res['version'],",
    "           'register_number': res['register_number'], 'booklet_serial': res['booklet_serial'],",
    "           'register_complete': res['register_complete'], 'serial_complete': res.get('serial_complete', True),",
    "           'grading': None, 'error': None}",
    "    if not res['version']:",
    "        out['error'] = 'Could not read the Question Booklet Version Code bubbles (' + str(res['version_note']) + '). Please check that one letter and one number are shaded.'",
    "    elif res['version'] not in c['set_codes']:",
    "        out['error'] = 'Version code ' + res['version'] + ' is not one of ' + ', '.join(c['set_codes']) + '.'",
    "    else:",
    "        key = K.load_key(subject, res['version'], c)",
    "        if key is None:",
    "            out['error'] = 'The answer key for this subject and set ' + res['version'] + ' has not been added yet.'",
    "        else:",
    "            out['grading'] = K.grade(res['answers'], key, c)",
    "    if want_image:",
    "        img = S.annotate(res, out['grading'])",
    "        ok, buf = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, int(quality)])",
    "        out['annotated_b64'] = base64.b64encode(buf.tobytes()).decode()",
    "    out['marking'] = c['marking']",
    "    out['five'] = c.get('not_attempted_option', '5')",
    "    return json.dumps(out)",
    "def omr_parse_table(text):",
    "    c = K.load_config()",
    "    try:",
    "        t = K.parse_table(text, c['set_codes'], c['options'], c['num_questions'])",
    "    except ValueError as e:",
    "        return json.dumps({'error': str(e)})",
    "    return json.dumps({'keys': {s: {str(q): a for q, a in k.items()} for s, k in t.items()}})",
    "def omr_parse_key(text):",
    "    c = K.load_config()",
    "    try:",
    "        k = K.parse_key(text, c['options'], c['num_questions'])",
    "    except ValueError as e:",
    "        return json.dumps({'error': str(e)})",
    "    return json.dumps({'key': {str(q): a for q, a in k.items()}})",
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
