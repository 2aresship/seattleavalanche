/* The Seattle Avalanche - no analytics, no tracking. Just UI glue. */
(function () {
  "use strict";

  var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- Masthead date ---------- */
  document.querySelectorAll("[data-date]").forEach(function (el) {
    el.textContent = new Date().toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric"
    });
  });

  /* ---------- Mobile nav ---------- */
  var toggle = document.querySelector(".nav-toggle");
  if (toggle) {
    toggle.addEventListener("click", function () {
      var open = document.body.classList.toggle("nav-open");
      toggle.setAttribute("aria-expanded", String(open));
      toggle.textContent = open ? "CLOSE ✕" : "MENU ☰";
    });
  }

  /* ---------- Ticker (duplicate content for seamless loop) ---------- */
  var tickerContent = document.querySelector(".ticker-content");
  if (tickerContent && !reducedMotion) {
    tickerContent.innerHTML += tickerContent.innerHTML;
  } else if (tickerContent) {
    tickerContent.style.animation = "none";
  }

  /* ---------- Copy buttons ---------- */
  document.querySelectorAll("[data-copy]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var text = btn.getAttribute("data-copy") || "";
      var done = function () {
        btn.classList.add("copied");
        var prev = btn.textContent;
        btn.textContent = "Copied ✓";
        setTimeout(function () {
          btn.classList.remove("copied");
          btn.textContent = prev;
        }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(function () {});
      } else {
        var ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); done(); } catch (e) {}
        document.body.removeChild(ta);
      }
    });
  });

  /* ---------- Scroll reveal ---------- */
  var revealEls = document.querySelectorAll("[data-reveal]");
  if ("IntersectionObserver" in window && !reducedMotion) {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("revealed");
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12 }
    );
    revealEls.forEach(function (el) { io.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add("revealed"); });
  }

  /* ---------- Snowfall on masthead ---------- */
  var canvas = document.getElementById("snow-canvas");
  var masthead = canvas ? canvas.closest(".masthead") : null;

  if (canvas && masthead && !reducedMotion) {
    var ctx = canvas.getContext("2d");
    var flakes = [];
    var raf = null;

    function sizeCanvas() {
      canvas.width = masthead.offsetWidth;
      canvas.height = masthead.offsetHeight;
    }

    function makeFlake(seed) {
      return {
        x: Math.random() * canvas.width,
        y: seed ? Math.random() * canvas.height : -4,
        r: 0.6 + Math.random() * 1.7,
        vy: 0.25 + Math.random() * 0.55,
        vx: -0.15 + Math.random() * 0.3,
        a: 0.12 + Math.random() * 0.45
      };
    }

    function init() {
      sizeCanvas();
      var count = Math.min(90, Math.floor(canvas.width / 14));
      flakes = [];
      for (var i = 0; i < count; i++) flakes.push(makeFlake(true));
    }

    function frame() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (var i = 0; i < flakes.length; i++) {
        var f = flakes[i];
        f.y += f.vy;
        f.x += f.vx + Math.sin(f.y / 60) * 0.08;
        if (f.y > canvas.height + 4 || f.x < -6 || f.x > canvas.width + 6) {
          flakes[i] = makeFlake(false);
          continue;
        }
        ctx.beginPath();
        ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(214, 235, 255, " + f.a + ")";
        ctx.fill();
      }
      raf = requestAnimationFrame(frame);
    }

    init();
    frame();

    window.addEventListener("resize", function () {
      cancelAnimationFrame(raf);
      init();
      frame();
    });

    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        cancelAnimationFrame(raf);
        raf = null;
      } else if (!raf) {
        frame();
      }
    });
  }
})();
