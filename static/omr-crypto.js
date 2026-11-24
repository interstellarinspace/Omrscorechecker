// Published results are stored encrypted. Each file name and its key are derived from the
// candidate's register number and booklet number, so a result can only be found and read
// by someone who knows both. There is no list of results anywhere on the site.
(function () {
  "use strict";
  var ITER = 150000, SALT = "omr-score-check/results/v1";
  var enc = new TextEncoder();
  function digits(s) { return String(s || "").replace(/\D/g, ""); }
  function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ("0" + b.toString(16)).slice(-2); }).join(""); }
  function b64(buf) { var s = "", a = new Uint8Array(buf); for (var i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000)); return btoa(s); }
  function unb64(s) { var bin = atob(s), a = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }

  async function derive(register, booklet) {
    var secret = digits(register) + ":" + digits(booklet);
    var base = await crypto.subtle.importKey("raw", enc.encode(secret), "PBKDF2", false, ["deriveBits"]);
    var bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(SALT), iterations: ITER }, base, 384);
    var id = hex(bits.slice(0, 16));
    var key = await crypto.subtle.importKey("raw", bits.slice(16, 48), "AES-GCM", false, ["encrypt", "decrypt"]);
    return { id: id, key: key };
  }
  async function seal(obj, register, booklet) {
    var d = await derive(register, booklet), iv = crypto.getRandomValues(new Uint8Array(12));
    var ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, d.key, enc.encode(JSON.stringify(obj)));
    return { id: d.id, body: JSON.stringify({ v: 1, iv: b64(iv), ct: b64(ct) }) };
  }
  async function open(fileJson, key) {
    var f = typeof fileJson === "string" ? JSON.parse(fileJson) : fileJson;
    var pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(f.iv) }, key, unb64(f.ct));
    return JSON.parse(new TextDecoder().decode(pt));
  }
  window.OMRCrypto = { derive: derive, seal: seal, open: open, digits: digits };
})();
