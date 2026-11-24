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

  // ---- admin vault: OMR sheet images and the admin's results index, locked with the admin passphrase ----
  var VAULT_ITER = 310000, CHECK = "omr-admin-vault-ok";
  async function vaultKey(passphrase, saltB64) {
    var base = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: unb64(saltB64), iterations: VAULT_ITER }, base,
      { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  async function sealBytes(key, bytes) {
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, bytes));
    var out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12); return out;
  }
  async function openBytes(key, bytes) {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12) }, key, bytes.subarray(12)));
  }
  async function newVault(passphrase) {
    var salt = b64(crypto.getRandomValues(new Uint8Array(16)));
    var key = await vaultKey(passphrase, salt);
    return { key: key, file: JSON.stringify({ v: 1, salt: salt, check: b64(await sealBytes(key, enc.encode(CHECK))) }) };
  }
  async function unlockVault(fileText, passphrase) {
    var f = JSON.parse(fileText), key = await vaultKey(passphrase, f.salt);
    try { if (new TextDecoder().decode(await openBytes(key, unb64(f.check))) === CHECK) return key; } catch (e) {}
    return null;
  }
  // A fresh key for one OMR sheet image. The key is stored inside the candidate's encrypted
  // result and in the admin's encrypted list, so both can open the same single copy.
  async function newSheetKey() {
    var raw = crypto.getRandomValues(new Uint8Array(32));
    return { raw: b64(raw), key: await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]) };
  }
  function sheetKey(rawB64) { return crypto.subtle.importKey("raw", unb64(rawB64), "AES-GCM", false, ["decrypt"]); }
  async function openSheet(url, rawB64) {
    var res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    var bytes = await openBytes(await sheetKey(rawB64), new Uint8Array(await res.arrayBuffer()));
    return URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
  }

  // ---- admin key pair: lets the GitHub fetch job add entries to the admin's list without the passphrase ----
  var OAEP = { name: "RSA-OAEP", hash: "SHA-256" };
  async function newAdminKeys(vault) {
    var kp = await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["encrypt", "decrypt"]);
    var pub = new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey));
    var priv = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
    return { pub: b64(pub), priv: b64(await sealBytes(vault, priv)) };
  }
  async function adminPrivate(vault, privB64) {
    return crypto.subtle.importKey("pkcs8", await openBytes(vault, unb64(privB64)), OAEP, false, ["decrypt"]);
  }
  async function openForAdmin(priv, text) {
    var f = JSON.parse(text);
    var raw = await crypto.subtle.decrypt(OAEP, priv, unb64(f.k));
    var key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
    return JSON.parse(new TextDecoder().decode(await openBytes(key, unb64(f.data))));
  }
  window.OMRCrypto = { derive: derive, seal: seal, open: open, digits: digits, b64: b64, unb64: unb64,
    newSheetKey: newSheetKey, sheetKey: sheetKey, openSheet: openSheet,
    sealBytes: sealBytes, openBytes: openBytes, newVault: newVault, unlockVault: unlockVault,
    newAdminKeys: newAdminKeys, adminPrivate: adminPrivate, openForAdmin: openForAdmin };
})();
