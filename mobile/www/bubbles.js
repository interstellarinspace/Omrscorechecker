// Falling OMR answer bubbles. Moving the mouse over one, or tapping it, bursts it.
// On wide screens they fall in the page background. On phones and tablets the cards fill the
// screen, so the bubbles fall faintly over the page instead. Either way the canvas never takes a
// tap or click, so buttons, forms and ads work as usual. Off for people who ask for reduced motion.
(function () {
  "use strict";
  if (!window.requestAnimationFrame || !document.createElement("canvas").getContext) return;
  var mq = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  if (mq && mq.matches) return;

  var GREEN = "#15803d", DARK = "#14532d", LIGHT = "#86efac";
  var LABELS = ["1", "2", "3", "4", "5", "A", "B", "C", "D"];
  var cv = document.createElement("canvas");
  cv.id = "bubble-sky";
  cv.setAttribute("aria-hidden", "true");
  var over = false;   // true: drawn over the page (phones), false: behind it (wide screens)
  function place() {
    over = window.innerWidth < 900 || !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
    cv.style.cssText = "position:fixed;top:0;left:0;right:0;bottom:0;width:100%;height:100%;pointer-events:none;" +
      (over ? "z-index:2147483000;" : "z-index:-1;");
  }
  place();
  document.body.insertBefore(cv, document.body.firstChild);
  var ctx = cv.getContext("2d");
  var W = 0, H = 0, dpr = 1, bubbles = [], bits = [], running = true, last = 0;

  function rand(a, b) { return a + Math.random() * (b - a); }
  function target() { return over ? Math.max(8, Math.min(14, Math.round(W * H / 30000))) : Math.max(10, Math.min(42, Math.round(W * H / 22000))); }

  function make(top) {
    var r = W < 600 ? rand(11, 17) : rand(12, 22);
    return {
      x: rand(r, W - r), y: top ? rand(-H, H) : rand(-80, -r - 4), r: r,
      vy: rand(18, 46) * (r / 16), sway: rand(6, 18), phase: rand(0, 6.28), spin: rand(0.4, 1.2),
      label: LABELS[(Math.random() * LABELS.length) | 0], shaded: Math.random() < 0.35, a: rand(0.35, 0.7)
    };
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    place();
    W = window.innerWidth; H = window.innerHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var n = target();
    while (bubbles.length < n) bubbles.push(make(true));
    if (bubbles.length > n) bubbles.length = n;
  }

  function drawBubble(b, x) {
    ctx.globalAlpha = over ? b.a * 0.6 : b.a;
    ctx.beginPath(); ctx.arc(x, b.y, b.r, 0, 6.2832);
    if (b.shaded) { ctx.fillStyle = DARK; ctx.fill(); }
    else {
      ctx.fillStyle = "#fff"; ctx.fill();
      ctx.lineWidth = Math.max(1.5, b.r / 9); ctx.strokeStyle = GREEN; ctx.stroke();
      ctx.fillStyle = GREEN;
      ctx.font = "700 " + Math.round(b.r * 1.05) + "px system-ui,-apple-system,'Segoe UI',Roboto,sans-serif";
      ctx.fillText(b.label, x, b.y + b.r * 0.06);
    }
  }

  function burst(b, x) {
    var n = 10;
    for (var i = 0; i < n; i++) {
      var ang = (i / n) * 6.2832 + rand(-0.2, 0.2), sp = rand(80, 190);
      bits.push({ k: "dot", x: x, y: b.y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, r: rand(1.6, 3.4), life: 0, max: rand(0.45, 0.7), c: i % 2 ? GREEN : LIGHT });
    }
    bits.push({ k: "ring", x: x, y: b.y, r: b.r, life: 0, max: 0.4 });
    if (b.shaded) bits.push({ k: "text", x: x, y: b.y, life: 0, max: 0.8, t: "+1" });
  }

  function hit(px, py, pad) {
    for (var i = bubbles.length - 1; i >= 0; i--) {
      var b = bubbles[i], x = b.x + Math.sin(b.phase) * b.sway, dx = px - x, dy = py - b.y, rr = b.r + (pad || 6);
      if (dx * dx + dy * dy <= rr * rr) { burst(b, x); bubbles[i] = make(false); }
    }
  }

  function frame(t) {
    if (!running) return;
    var dt = last ? Math.min((t - last) / 1000, 0.05) : 0.016;
    last = t;
    ctx.clearRect(0, 0, W, H);
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (var i = 0; i < bubbles.length; i++) {
      var b = bubbles[i];
      b.y += b.vy * dt; b.phase += b.spin * dt;
      if (b.y - b.r > H) { bubbles[i] = b = make(false); }
      drawBubble(b, b.x + Math.sin(b.phase) * b.sway);
    }
    for (var j = bits.length - 1; j >= 0; j--) {
      var p = bits[j], f;
      p.life += dt; f = p.life / p.max;
      if (f >= 1) { bits.splice(j, 1); continue; }
      ctx.globalAlpha = 1 - f;
      if (p.k === "dot") {
        p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 260 * dt;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.2832); ctx.fillStyle = p.c; ctx.fill();
      } else if (p.k === "ring") {
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (1 + f * 1.4), 0, 6.2832);
        ctx.lineWidth = 2.5 * (1 - f) + 0.5; ctx.strokeStyle = GREEN; ctx.stroke();
      } else {
        ctx.fillStyle = GREEN; ctx.font = "800 16px system-ui,-apple-system,'Segoe UI',Roboto,sans-serif";
        ctx.fillText(p.t, p.x, p.y - 10 - f * 30);
      }
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(frame);
  }

  function start() { if (!running) { running = true; last = 0; requestAnimationFrame(frame); } }
  function stop() { running = false; ctx.clearRect(0, 0, W, H); }

  window.addEventListener("resize", resize);
  // Listen on the whole page (the canvas never takes the pointer); this never blocks a click or a scroll.
  window.addEventListener("pointermove", function (e) { if (e.pointerType === "mouse" || e.buttons) hit(e.clientX, e.clientY, e.pointerType === "mouse" ? 6 : 18); }, { passive: true });
  window.addEventListener("pointerdown", function (e) { hit(e.clientX, e.clientY, e.pointerType === "mouse" ? 6 : 18); }, { passive: true });
  // Older phone browsers without pointer events
  if (!window.PointerEvent) {
    var touch = function (e) { for (var i = 0; i < e.touches.length; i++) hit(e.touches[i].clientX, e.touches[i].clientY, 18); };
    window.addEventListener("touchstart", touch, { passive: true });
    window.addEventListener("touchmove", touch, { passive: true });
  }
  document.addEventListener("visibilitychange", function () { if (document.hidden) running = false; else start(); });
  if (mq) {
    var onChange = function () { if (mq.matches) stop(); else start(); };
    if (mq.addEventListener) mq.addEventListener("change", onChange); else if (mq.addListener) mq.addListener(onChange);
  }
  resize();
  requestAnimationFrame(frame);
})();
