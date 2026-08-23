/**
 * Avalanche Worker - static assets + public tip/subscribe endpoints.
 *
 * SECURITY MODEL
 * - Public POSTs (/tip.php, /api/tip, /api/subscribe): honeypot + rate limit + size caps.
 * - Private GETs (/api/tips, /api/subs): require `Authorization: Bearer $ADMIN_KEY`.
 *   Set once: dashboard > Workers > silent-queen-3bd2 > Settings > Variables > Secrets
 *   -> add secret ADMIN_KEY. Or: npx wrangler secret put ADMIN_KEY
 * - Sensitive local files are never served (denylist below).
 *
 * Optional secrets:
 *   GITHUB_TOKEN  repo-scope token; files tips/subscribers as issues for backup.
 */
const DENY = [
  "/panel-config.json",
  "/panel.py",
  "/wrangler.toml",
  "/.gitignore",
  "/data/tips.json",
  "/data/posts/",
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors() });
    }

    // never serve private/local files, whatever the method
    const low = path.toLowerCase();
    if (DENY.some((d) => low === d || low.startsWith(d)) || low.startsWith("/.git") || low.includes("tips_files")) {
      return new Response("Not found", { status: 404 });
    }

    if (request.method === "POST" && (path === "/api/tip" || path === "/tip.php")) {
      return guarded(handleTip, request, env, ctx, 1_000_000);
    }

    if (request.method === "POST" && path === "/api/subscribe") {
      return guarded(handleSubscribe, request, env, ctx, 64_000);
    }

    if (request.method === "GET" && (path === "/api/tips" || path === "/api/subs")) {
      return authed(request, env, () => (path === "/api/subs" ? handleSubsList(env) : handleList(env)));
    }

    // static assets
    if (env.ASSETS) {
      const asset = await env.ASSETS.fetch(request);
      if (asset.status !== 404) return withSecurityHeaders(asset);
      // pretty URLs: /page -> /page.html
      if (!path.endsWith("/") && !path.includes(".")) {
        const alt = new URL(path + ".html", url);
        const a2 = await env.ASSETS.fetch(new Request(alt, request));
        if (a2.status !== 404) return withSecurityHeaders(a2);
      }
      return asset;
    }
    return new Response("Not found", { status: 404 });
  },
};

/* ---------- auth ---------- */

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function authed(request, env, fn) {
  if (!env.ADMIN_KEY) {
    return json({ ok: false, error: "Server not configured: set the ADMIN_KEY secret first." }, 501);
  }
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get("Authorization") || "");
  if (!m || !safeEqual(m[1].trim(), env.ADMIN_KEY)) {
    return json({ ok: false, error: "Unauthorized." }, 401);
  }
  try {
    return await fn();
  } catch (err) {
    console.error(err);
    return json({ ok: false, error: "Server error." }, 500);
  }
}

/* ---------- body-size guard wrapper ---------- */

async function guarded(fn, request, env, ctx, maxBytes) {
  const len = parseInt(request.headers.get("content-length") || "0", 10);
  if (len > maxBytes) {
    return json({ ok: false, error: "Too large." }, 413);
  }
  const r = await fn(request, env, ctx);
  r.headers.set("Access-Control-Allow-Origin", "*");
  return r;
}

/* ---------- headers ---------- */

function withSecurityHeaders(res) {
  const ct = res.headers.get("Content-Type") || "";
  const out = new Response(res.body, res);
  out.headers.set("X-Content-Type-Options", "nosniff");
  out.headers.set("Referrer-Policy", "no-referrer");
  out.headers.set("X-Frame-Options", "DENY");
  if (ct.includes("text/html")) {
    out.headers.set(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src https://fonts.gstatic.com",
        "script-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self' https://github.com",
      ].join("; ")
    );
  }
  return out;
}

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors() },
  });
}

/* ---------- public: submit a tip ---------- */

async function handleTip(request, env, ctx) {
  try {
    let data = {};
    const ct = request.headers.get("content-type") || "";

    if (ct.includes("application/json")) {
      data = await request.json().catch(() => ({}));
    } else {
      const form = await request.formData();
      for (const [k, v] of form.entries()) {
        if (v instanceof File) continue; // file contents need R2; not stored
        data[k] = v;
      }
    }

    if ((String(data._gotcha || "")).trim() || (String(data.website || "")).trim()) {
      return json({ ok: true, id: "filtered", msg: "Thanks." });
    }

    const message = String(data.message || "").trim();
    if (!message) return json({ ok: false, error: "Message was empty." }, 400);

    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    if (env.TIPS_KV) {
      const last = parseInt((await env.TIPS_KV.get("rate:" + ip)) || "0", 10);
      if (Date.now() - last < 30_000) {
        return json({ ok: false, error: "Easy there - one submission per 30 seconds." }, 429);
      }
      await env.TIPS_KV.put("rate:" + ip, String(Date.now()));
    }

    const id = "AV-" + new Date().toISOString().slice(0, 10).replace(/-/g, "") + "-" +
      Math.random().toString(36).slice(2, 8).toUpperCase();

    const tip = {
      id,
      received: new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC",
      topic: String(data.topic || "tip").slice(0, 60),
      alias: String(data.alias || data.handle || "").slice(0, 60),
      contact: String(data.contact || "").slice(0, 200),
      message: message.slice(0, 30000),
      allow_public: (data.allow_public === "1" || data.allow_public === 1 || data.allow_public === true) ? 1 : 0,
      files: [],
      read: false,
    };

    if (env.TIPS_KV) {
      await env.TIPS_KV.put("tip:" + id, JSON.stringify(tip));
      const idx = (await env.TIPS_KV.get("tips:index", { type: "json" })) || [];
      idx.push(id);
      await env.TIPS_KV.put("tips:index", JSON.stringify(idx.slice(-500)));
    } else {
      console.log("TIP (no KV bound):", JSON.stringify(tip));
    }

    if (env.GITHUB_TOKEN && ctx) {
      ctx.waitUntil(fileIssue(tip, env).catch(() => {}));
    }

    return json({ ok: true, id, files: 0, msg: "Received." });
  } catch (err) {
    console.error(err);
    return json({ ok: false, error: "Server error." }, 500);
  }
}

/* ---------- public: join mailing list ---------- */

async function handleSubscribe(request, env) {
  try {
    let email = "";
    const ct = request.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      const j = await request.json().catch(() => ({}));
      email = String(j.email || "").trim().toLowerCase();
      if (j._gotcha || j.website) return json({ ok: true });
    } else {
      const form = await request.formData();
      if ((form.get("_gotcha") || "").toString().trim()) return json({ ok: true });
      email = String(form.get("email") || "").trim().toLowerCase();
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) {
      return json({ ok: false, error: "That address does not look right." }, 400);
    }

    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    if (env.TIPS_KV) {
      const last = parseInt((await env.TIPS_KV.get("rate-s:" + ip)) || "0", 10);
      if (Date.now() - last < 15_000) {
        return json({ ok: false, error: "One moment - too many requests." }, 429);
      }
      await env.TIPS_KV.put("rate-s:" + ip, String(Date.now()));

      const existing = await env.TIPS_KV.get("sub:" + email);
      if (existing) return json({ ok: true, already: true });

      await env.TIPS_KV.put("sub:" + email, JSON.stringify({ email, date: new Date().toISOString().slice(0, 16) + " UTC" }));
      const idx = (await env.TIPS_KV.get("subs:index", { type: "json" })) || [];
      if (!idx.includes(email)) idx.push(email);
      await env.TIPS_KV.put("subs:index", JSON.stringify(idx.slice(-10000)));
    } else {
      console.log("SUBSCRIBER (no KV bound):", email);
    }

    if (env.GITHUB_TOKEN) {
      const repo = env.GITHUB_REPO || "2aresship/seattleavalanche";
      fetch(`https://api.github.com/repos/${repo}/issues`, {
        method: "POST",
        headers: { Authorization: "Bearer " + env.GITHUB_TOKEN, Accept: "application/vnd.github+json", "User-Agent": "avalanche-worker" },
        body: JSON.stringify({ title: `[list] new subscriber`, body: "Email: " + email + "\nDate: " + new Date().toISOString(), labels: ["mailing-list"] }),
      }).catch(() => {});
    }

    return json({ ok: true });
  } catch (err) {
    console.error(err);
    return json({ ok: false, error: "Server error." }, 500);
  }
}

/* ---------- private: lists ---------- */

async function handleSubsList(env) {
  if (!env.TIPS_KV) {
    return json({ ok: false, error: "KV not bound yet." }, 501);
  }
  const idx = (await env.TIPS_KV.get("subs:index", { type: "json" })) || [];
  const subs = [];
  for (const email of idx.slice(-5000)) {
    const raw = await env.TIPS_KV.get("sub:" + email, { type: "json" });
    subs.push(raw ? raw : { email, date: "" });
  }
  return json({ ok: true, subs });
}

async function handleList(env) {
  if (!env.TIPS_KV) {
    return json({ ok: false, error: "KV not bound. Bind a KV namespace as TIPS_KV to use the inbox." }, 501);
  }
  const idx = (await env.TIPS_KV.get("tips:index", { type: "json" })) || [];
  const tips = [];
  for (const id of idx.slice(-200)) {
    const t = await env.TIPS_KV.get("tip:" + id, { type: "json" });
    if (t) tips.push(t);
  }
  return json({ ok: true, tips });
}

async function fileIssue(tip, env) {
  const repo = env.GITHUB_REPO || "2aresship/seattleavalanche";
  const title = `[tip] ${tip.id} ${tip.topic}${tip.alias ? " from " + tip.alias : ""}`.slice(0, 90);
  const body =
    `ID: ${tip.id}\nReceived: ${tip.received}\nTopic: ${tip.topic}\n` +
    `Alias: ${tip.alias || "anonymous"}\nContact: ${tip.contact || "none"}\n` +
    `Allow public answer: ${tip.allow_public ? "yes" : "no"}\n\n---\n\n${tip.message}\n`;
  await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + env.GITHUB_TOKEN,
      Accept: "application/vnd.github+json",
      "User-Agent": "avalanche-worker",
    },
    body: JSON.stringify({ title, body, labels: ["tip"] }),
  });
}
