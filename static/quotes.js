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
    ["ಪ್ರಯತ್ನವೇ ಯಶಸ್ಸಿನ ಮೊದಲ ಮೆಟ್ಟಿಲು.", "Effort is the first step to success"],
    ["ಕಲಿಕೆಗೆ ಕೊನೆಯಿಲ್ಲ.", "There is no end to learning"]
  ];
  var COLORS = [
    "linear-gradient(120deg,#f97316,#db2777)", "linear-gradient(120deg,#7c3aed,#0ea5e9)", "linear-gradient(120deg,#10b981,#0ea5e9)",
    "linear-gradient(120deg,#db2777,#7c3aed)", "linear-gradient(120deg,#eab308,#f97316)", "linear-gradient(120deg,#0ea5e9,#10b981)",
    "linear-gradient(120deg,#e11d48,#f59e0b)", "linear-gradient(120deg,#6366f1,#ec4899)"
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
