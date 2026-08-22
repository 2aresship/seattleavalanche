/* Avalanche content renderer - fills pages from window.AVALANCHE_CONTENT
   (generated into js/content.js), upgraded live by content.remote.json
   when a mirror operator drops a newer copy in the site root. */
(function () {
  "use strict";

  function el(id) { return document.getElementById(id); }

  function chipClass(tag) {
    var t = String(tag).toLowerCase();
    if (/surveil|tech|camera/.test(t)) return "chip chip--surveil";
    if (/polit|city|council|court/.test(t)) return "chip chip--politics";
    if (/environ|salmon|forest|climate|smoke/.test(t)) return "chip chip--environ";
    if (/labor|strike|worker|union/.test(t)) return "chip chip--labor";
    if (/cult|music|art|book/.test(t)) return "chip chip--culture";
    if (/hous|rent|landlord/.test(t)) return "chip chip--housing";
    return "chip chip--opinion";
  }

  function tagChips(tags) {
    return (tags || []).map(function (t) {
      return '<span class="' + chipClass(t) + '">' + t + "</span>";
    }).join(" ");
  }

  function escHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* ================= render ================= */

  function render(C) {
    if (!C) return;

    var published = (C.posts || []).filter(function (p) { return p.status === "published"; });

    /* version stamp - every page footer */
    if (el("ver-stamp")) {
      el("ver-stamp").textContent = C.generated ? "content v" + C.generated : "";
    }

    /* notices ticker - replaces static fallback if site.notices exists */
    if (el("ticker-items") && C.site && C.site.notices && C.site.notices.length) {
      var html = C.site.notices.map(function (n) {
        return '<a href="submit.html">' + escHtml(n) + "</a>";
      }).join("");
      // duplicate for seamless scroll
      el("ticker-items").innerHTML = html + html;
    }

    /* homepage: published card */
    if (el("pub-slot")) {
      var slot = el("pub-slot");
      if (published.length === 0) {
        slot.innerHTML =
          '<span class="chip chip--local">Published</span>' +
          "<h2>Nothing yet.</h2>" +
          "<p>No apology here. That’s the standard. The first story lands when it’s done, not when a feed needs to be fed.</p>" +
          '<dl class="case-meta">' +
          '<div><dt>Stories</dt><dd>0</dd></div>' +
          '<div><dt>Weeks per story</dt><dd>All of them</dd></div>' +
          '<div><dt>Rushed takes</dt><dd>0, forever</dd></div>' +
          "</dl>";
      } else {
        var items = published.slice(0, 4).map(function (p) {
          return (
            '<a class="mini-story" href="article.html?p=' + encodeURIComponent(p.slug) + '">' +
            "<h4>" + escHtml(p.title) + "</h4>" +
            '<p class="byline">' + escHtml(p.date) + "</p></a>"
          );
        }).join("");
        slot.innerHTML =
          '<span class="chip chip--local">Published</span>' +
          "<h2>The record so far.</h2>" +
          '<div style="margin-top:10px">' + items + "</div>" +
          '<dl class="case-meta"><div><dt>Stories</dt><dd>' + published.length + "</dd></div></dl>";
      }
    }

    /* homepage: investigation card */
    var inv = C.site && C.site.investigation ? C.site.investigation : null;
    if (inv && el("case-num")) {
      el("case-num").textContent = "CASE №" + (inv.number || "001");
      if (el("case-stage")) el("case-stage").textContent = inv.stage || "";
      if (el("case-opened")) el("case-opened").textContent = inv.opened || "";

      var titleEl = el("case-title");
      var blurbEl = el("case-blurb");

      if (inv.title) {
        titleEl.textContent = inv.title;
        var firstPub = published[0];
        if (blurbEl) blurbEl.textContent =
          "This one went public after weeks of silent verification." +
          (firstPub ? " It was worth the wait." : "");
        if (firstPub && el("case-link")) {
          el("case-link").href = "article.html?p=" + encodeURIComponent(firstPub.slug);
        }
      } else {
        titleEl.textContent = "Title withheld until publication";
        if (blurbEl) blurbEl.textContent = inv.blurb || "";
      }
    }

    /* answers board - answers.html */
    if (el("answers-list")) {
      var list = el("answers-list");
      var countEl = el("answers-count");
      var answers = C.answers || [];
      if (countEl) countEl.textContent = answers.length ? answers.length + " replies" : "";
      if (!answers.length) {
        list.innerHTML = '<div class="module" style="padding:28px;"><p style="color:var(--muted);font-size:0.92rem;">No public answers yet - be the first to <a href="submit.html">ask something</a>.</p></div>';
      } else {
        list.innerHTML = answers.map(function (a) {
          return (
            '<article class="module" style="padding:22px;">' +
            '<div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:10px">' +
            '<span class="chip chip--local">' + escHtml(a.alias || "anonymous") + '</span>' +
            '<span style="color:var(--faint);font-size:0.78rem">' + escHtml(a.date || "") + ' · ' + escHtml(a.id || "") + "</span></div>" +
            '<p style="color:var(--text-soft);font-size:0.9rem;margin-bottom:10px"><em>Q: ' + escHtml(a.question || "") + "</em></p>" +
            '<div style="color:var(--text);line-height:1.6">' + escHtml(a.answer) + "</div></article>"
          );
        }).join("");
      }
    }

    /* mirror registry table (mirror.html) */
    if (el("mirror-table") && C.site) {
      var tbody = el("mirror-table").getElementsByTagName("tbody")[0];
      if (tbody) {
        var mirrors = (C.site.mirrors || []).map(String);
        if (mirrors.length) {
          tbody.innerHTML = mirrors.map(function (m, i) {
            var clean = m.replace(/^https?:\/\//, "").replace(/\/$/, "");
            return (
              "<tr><td>" +
              (i === 0 ? escHtml(clean) + ' <span style="color:var(--faint);">(canonical)</span>' : escHtml(clean)) +
              "</td><td>" +
              (i === 0 ? "Canonical" : "Community mirror") +
              "</td></tr>"
            );
          }).join("") +
          '<tr><td colspan="2" style="color:var(--faint);">Want your mirror listed? See step 03 above.</td></tr>';
        }
      }
    }

    /* article template (?p=slug) */
    var params;
    try { params = new URLSearchParams(window.location.search); } catch (e) { params = null; }
    var slugParam = params ? params.get("p") : null;

    if (slugParam && el("art-title")) {
      var post = null;
      for (var i = 0; i < published.length; i++) {
        if (published[i].slug === slugParam) post = published[i];
      }

      if (post) {
        document.title = post.title + " | The Seattle Avalanche";

        ["sample-banner", "sample-body"].forEach(function (id) {
          var n = el(id);
          if (n) n.remove();
        });

        el("art-title").textContent = post.title;

        var dek = el("art-dek");
        dek.textContent = post.dek || "";
        dek.style.display = post.dek ? "" : "none";

        if (el("art-date")) el("art-date").textContent = post.date;
        if (el("art-tags")) el("art-tags").innerHTML = tagChips(post.tags);

        var chipsRow = el("art-head-chips");
        if (chipsRow && post.tags && post.tags.length) {
          chipsRow.outerHTML = tagChips([post.tags[0]]);
        }

        var body = el("art-body");
        body.innerHTML = post.body_html || "";
        body.style.display = "";

        var foot = el("art-foot");
        if (foot) foot.style.display = "";
      }
      /* unknown or draft slug → labeled sample stays visible */
    }
  }

  /* ================= boot: prefer fresher remote layer ================= */

  function boot() {
    var base = window.AVALANCHE_CONTENT || null;

    var done = false;
    function finish(c) {
      if (done) return;
      done = true;
      render(c || base);
    }

    try {
      fetch("content.remote.json", { cache: "no-store" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (remote) {
          if (remote && remote.generated) {
            if (!base || !base.generated || String(remote.generated) > String(base.generated)) {
              finish(remote);
              return;
            }
          }
          finish(base);
        })
        .catch(function () { finish(base); });
      setTimeout(function () { finish(base); }, 2500);
    } catch (e) {
      finish(base);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
