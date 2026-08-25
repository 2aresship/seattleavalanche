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

  /* ---------- Theme toggle (light/dark) ---------- */
  (function(){
    var KEY='av_theme';
    var rootEl=document.documentElement;
    var saved=null; try{ saved=localStorage.getItem(KEY);}catch(e){}
    var prefersLight=window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    var theme=saved || (prefersLight ? 'light' : 'dark');
    rootEl.setAttribute('data-theme', theme);
    function updateBtn(t){
      document.querySelectorAll('.theme-toggle').forEach(function(b){
        b.setAttribute('aria-label','Switch to '+(t==='dark'?'light':'dark')+' mode');
        b.setAttribute('title','Switch to '+(t==='dark'?'light':'dark')+' mode');
        var k=b.querySelector('.theme-toggle-knob');
        if(k) k.textContent= t==='light' ? '\u2600' : '\u263E';
      });
    }
    function toggle(){
      var cur=rootEl.getAttribute('data-theme') || 'dark';
      var next= cur==='dark' ? 'light' : 'dark';
      rootEl.setAttribute('data-theme', next);
      try{ localStorage.setItem(KEY,next);}catch(e){}
      updateBtn(next);
    }
    // apply immediately on parse, and wire after DOM ready
    updateBtn(theme);
    document.addEventListener('DOMContentLoaded', function(){
      updateBtn(theme);
      document.querySelectorAll('.theme-toggle').forEach(function(b){
        b.addEventListener('click', toggle);
      });
    });
    // also wire if script is deferred and DOM already ready
    if(document.readyState!=='loading'){
      document.querySelectorAll('.theme-toggle').forEach(function(b){
        b.addEventListener('click', toggle);
      });
    }
  })();

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

    // subtle easter egg: triple-click logo intensifies snow briefly
    var logo = document.querySelector(".logo-mark");
    var clicks = 0; var clickTimer = null;
    if (logo && !reducedMotion) {
      logo.style.cursor = "pointer";
      logo.setAttribute("title", "❄");
      logo.addEventListener("click", function(){
        clicks++;
        clearTimeout(clickTimer);
        clickTimer = setTimeout(function(){ clicks=0; }, 900);
        if (clicks===3){
          clicks=0;
          // burst: add 40 extra flakes for 3s
          for(var i=0;i<40;i++) flakes.push(makeFlake(false));
          logo.style.filter = "drop-shadow(0 0 22px rgba(125,215,255,0.85))";
          setTimeout(function(){ logo.style.filter = ""; }, 1800);
        }
      });
    }
  }

  /* ---------- Subtle easter eggs (professional) ---------- */
  // Konami on main site: very subtle - masthead title shivers like snow
  (function(){
    if (reducedMotion) return;
    var seq=["ArrowUp","ArrowUp","ArrowDown","ArrowDown","ArrowLeft","ArrowRight","ArrowLeft","ArrowRight","b","a"];
    var p=0;
    window.addEventListener("keydown", function(e){
      if(e.key===seq[p]) p++; else p=0;
      if(p===seq.length){
        p=0;
        var t=document.querySelector(".masthead-title span");
        if(t){
          t.style.transition="filter .2s";
          t.style.filter="brightness(1.25) drop-shadow(0 0 10px rgba(125,215,255,0.45))";
          setTimeout(function(){ t.style.filter=""; }, 1200);
        }
        // also brief snow gust if canvas exists
        var cv=document.getElementById("snow-canvas");
        if(cv) cv.style.opacity="1";
        setTimeout(function(){ if(cv) cv.style.opacity="0.75"; }, 1500);
      }
      // ? hint
      if(e.key==="?" && !e.ctrlKey && !e.metaKey){
        var el=document.getElementById("easter");
        if(el) el.style.opacity="1";
      }
    });
  })();
})();
