// Motivational quotes under the header, a new one (and a new colour) every 10 seconds.
(function () {
  "use strict";
  var box = document.getElementById("quote");
  if (!box) return;
  var Q = [
    ["Arise, awake, and stop not till the goal is reached.", "Swami Vivekananda"],
    ["Dream, dream, dream. Dreams transform into thoughts, and thoughts result in action.", "A. P. J. Abdul Kalam"],
    ["Success is the sum of small efforts, repeated day in and day out.", "Robert Collier"],
    ["It always seems impossible until it's done.", "Nelson Mandela"],
    ["The secret of getting ahead is getting started.", "Mark Twain"],
    ["Education is the most powerful weapon which you can use to change the world.", "Nelson Mandela"],
    ["Believe you can and you're halfway there.", "Theodore Roosevelt"],
    ["Strength does not come from winning. Your struggles develop your strengths.", "Arnold Schwarzenegger"],
    ["Don't watch the clock; do what it does. Keep going.", "Sam Levenson"],
    ["Learning never exhausts the mind.", "Leonardo da Vinci"],
    ["Live as if you were to die tomorrow. Learn as if you were to live forever.", "Mahatma Gandhi"],
    ["You have to dream before your dreams can come true.", "A. P. J. Abdul Kalam"],
    ["The expert in anything was once a beginner.", "Helen Hayes"],
    ["Hard work beats talent when talent doesn't work hard.", "Tim Notke"],
    ["Every mark you check today is a step towards the next exam.", ""],
    ["One exam does not define you. Keep learning, keep growing.", ""],
    ["Your score is a starting line, not a finish line.", ""],
    ["Small steps every day add up to big results.", ""],
    ["Effort is the first step to success.", ""],
    ["There is no end to learning.", ""]
  ];
  var COLORS = [
    "linear-gradient(120deg,#14532d,#15803d)", "linear-gradient(120deg,#15803d,#16a34a)", "linear-gradient(120deg,#166534,#22c55e)",
    "linear-gradient(120deg,#14532d,#16a34a)"
  ];
  var i = Math.floor(Math.random() * Q.length), c = Math.floor(Math.random() * COLORS.length);
  var text = box.querySelector(".q-text"), who = box.querySelector(".q-who");
  function show() {
    var q = Q[i % Q.length];
    box.style.backgroundImage = COLORS[c % COLORS.length];
    text.textContent = "“" + q[0] + "”";
    who.textContent = q[1] ? "— " + q[1] : "";
    box.classList.remove("q-in"); void box.offsetWidth; box.classList.add("q-in");
  }
  show();
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) box.classList.add("q-still");
  setInterval(function () { if (document.hidden) return; i++; c++; show(); }, 10000);
})();
