/**
 * Avalanche Worker - serves static assets + handles tip submissions.
 * POST /tip.php and /api/tip  -> store tip (KV if bound, GitHub issue backup, always logged)
 * GET  /api/tips             -> list tips (KV)
 * Everything else            -> static asset
 *
 * One-time setup (dashboard or wrangler):
 *   1. KV: create namespace "TIPS_KV" (Workers & Pages > KV) and bind it to this worker as TIPS_KV.
 *      Without KV, tips still work via GitHub issues + logs but the admin Inbox cannot list them.
 *   2. Optional backup: `wrangler secret put GITHUB_TOKEN` with a repo-scope token.
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors() });
    }

    if (request.method === "POST" && (path === "/api/tip" || path === "/tip.php")) {
      return handleTip(request, env, ctx).then(r => { r.headers.set("Access-Control-Allow-Origin", "*"); return r; });
    }

    if (request.method === "POST" && path === "/api/subscribe") {
      return handleSubscribe(request, env).then(r => r.headers.set("Access-Control-Allow-Origin", "*") || r);
    }

    if (request.method === "GET" && path === "/api/subs") {
      return handleSubsList(env);
    }

    if (request.method === "GET" && path === "/api/tips") {
      return handleList(env).then(r => { r.headers.set("Access-Control-Allow-Origin", "*"); return r; });
    }

    // static assets
    if (env.ASSETS) {
      const asset = await env.ASSETS.fetch(request);
      if (asset.status !== 404) return asset;
      // pretty URLs: /page -> /page.html
      if (!path.endsWith("/") && !path.includes(".")) {
        const alt = new URL(path + ".html", url);
        const a2 = await env.ASSETS.fetch(new Request(alt, request));
        if (a2.status !== 404) return a2;
      }
      return asset;
    }
    return new Response("Not found", { status: 404 });
  }
};

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

async function handleTip(request, env, ctx) {
  try {
    let data = {};
    const ct = request.headers.get("content-type") || "";

    if (ct.includes("application/json")) {
      data = await request.json().catch(() => ({}));
    } else {
      const form = await request.formData();
      for (const [k, v] of form.entries()) {
        if (v instanceof File) continue; // file contents need R2; names recorded below when present
        data[k] = v;
      }
    }

    if ((data._gotcha || "").trim() || (data.website || "").trim()) {
      return json({ ok: true, id: "filtered", msg: "Thanks." });
    }

    const message = String(data.message || "").trim();
    if (!message) return json({ ok: false, error: "Message was empty." }, 400);

    // rate limit per IP: 1 / 30s (KV-backed when available)
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
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
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
  const repo = (env.GITHUB_REPO || "2aresship/seattleavalanche");
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
