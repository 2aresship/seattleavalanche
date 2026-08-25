#!/usr/bin/env python3
"""
AVALANCHE CONTROL PANEL - private local admin for The Seattle Avalanche.
Binds to 127.0.0.1 ONLY. Password is PBKDF2-SHA256 in panel-config.json (never packaged).

Usage:
    python panel.py                # first run asks for password
    python panel.py --password X   # set/reset non-interactively
    python panel.py --port 8787

Then open http://127.0.0.1:8787
"""

import argparse
import hashlib
import hmac
import html as html_mod
import io
import json
import mimetypes
import os
import re
import secrets
import sys
import time
import urllib.parse as urllib_parse
import zipfile
from datetime import date, datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
POSTS_DIR = DATA_DIR / "posts"
SITE_CFG = DATA_DIR / "site.json"
PANEL_CFG = ROOT / "panel-config.json"
TIPS_LOCAL = DATA_DIR / "tips.json"
TIPS_FILES_DIR = DATA_DIR / "tips_files"
DOWNLOAD_PAGE = ROOT / "download.html"
ZIP_PATH = ROOT / "seattle-avalanche-site.zip"
HOST, PORT = "127.0.0.1", 8787

# ---------------------------------------------------------------- config ----

def load_panel_cfg():
    return json.loads(PANEL_CFG.read_text(encoding="utf-8"))

def make_panel_cfg(password):
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), 200_000).hex()
    cfg = {"salt": salt, "iterations": 200_000, "hash": digest, "secret": secrets.token_hex(32), "created": str(date.today())}
    PANEL_CFG.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    return cfg

def verify_password(cfg, password):
    test = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(cfg["salt"]), int(cfg["iterations"]))
    return hmac.compare_digest(test.hex(), cfg["hash"])

# ---------------------------------------------------------------- session ----

def session_token(cfg):
    exp = str(int(time.time()) + 60 * 60 * 12)
    sig = hmac.new(bytes.fromhex(cfg["secret"]), exp.encode(), hashlib.sha256).hexdigest()[:32]
    return f"{exp}.{sig}"

def session_valid(cfg, cookie_value):
    try:
        exp, sig = cookie_value.split(".", 1)
        if int(exp) < int(time.time()):
            return False
        good = hmac.new(bytes.fromhex(cfg["secret"]), exp.encode(), hashlib.sha256).hexdigest()[:32]
        return hmac.compare_digest(sig, good)
    except Exception:
        return False

# ---------------------------------------------------------------- content ----

DEFAULT_SITE = {
    "motto": "Truth falls like snow",
    "tagline": "Independent · Anonymous",
    "investigation": {
        "number": "001",
        "title": "",
        "stage": "Sourcing & verification",
        "opened": "August 2026",
        "blurb": "An investigation is currently underway. The subject stays secret on purpose - announcing targets too early burns sources and evidence."
    },
    "notices": [
        "Investigation №001 is underway - it publishes when it’s ready",
        "This site collects nothing: no cookies, no analytics, no server logs",
        "Questions welcome - ask anonymously through the drop box",
    ],
    "mirrors": ["https://seattleavalanche.online/"],
    "network": [{"city": "The Seattle Avalanche", "domain": "seattleavalanche.online", "status": "Official · Active", "since": "Aug 2026"}],
    "banned_ips": [],
}

def load_site_cfg():
    if SITE_CFG.exists():
        try:
            data = json.loads(SITE_CFG.read_text(encoding="utf-8"))
            out = DEFAULT_SITE.copy()
            # deep merge for investigation
            if "investigation" in data:
                out["investigation"] = {**DEFAULT_SITE["investigation"], **data["investigation"]}
                data.pop("investigation")
            out.update(data)
            # ensure keys exist
            out.setdefault("notices", DEFAULT_SITE["notices"])
            out.setdefault("mirrors", DEFAULT_SITE["mirrors"])
            out.setdefault("network", DEFAULT_SITE["network"])
            out.setdefault("banned_ips", [])
            # migrate old ct.ws mirrors
            if any("ct.ws" in m for m in out.get("mirrors", [])):
                out["mirrors"]=["https://seattleavalanche.online/"]
                out["network"]=[{"city": "The Seattle Avalanche", "domain": "seattleavalanche.online", "status": "Official · Active", "since": "Aug 2026"}]
            if out.get("motto","").endswith("accumulates"):
                out["motto"]="Truth falls like snow"
            if "Unstoppable" in out.get("tagline",""):
                out["tagline"]="Independent · Anonymous"
            return out
        except Exception:
            pass
    return json.loads(json.dumps(DEFAULT_SITE))

def save_site_cfg(data):
    DATA_DIR.mkdir(exist_ok=True)
    SITE_CFG.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")

def load_posts():
    POSTS_DIR.mkdir(parents=True, exist_ok=True)
    posts = []
    for p in sorted(POSTS_DIR.glob("*.json")):
        try:
            posts.append(json.loads(p.read_text(encoding="utf-8")))
        except Exception:
            pass
    return posts

def load_tips():
    if not TIPS_LOCAL.exists():
        # also check old above-root json-lines fallback (for migrated hosts)
        above = ROOT.parent / "tips-dropbox.json"
        if above.exists():
            try:
                lines = [json.loads(l) for l in above.read_text(encoding="utf-8").splitlines() if l.strip()]
                if lines:
                    # migrate to new location
                    TIPS_LOCAL.write_text(json.dumps(lines, indent=2, ensure_ascii=False), encoding="utf-8")
                    return lines
            except Exception:
                pass
        return []
    try:
        raw = TIPS_LOCAL.read_text(encoding="utf-8").strip()
        if not raw:
            return []
        if raw.startswith("["):
            return json.loads(raw)
        # json-lines fallback
        return [json.loads(l) for l in raw.splitlines() if l.strip()]
    except Exception:
        return []

def save_tips(tips):
    DATA_DIR.mkdir(exist_ok=True)
    TIPS_LOCAL.write_text(json.dumps(tips, indent=2, ensure_ascii=False), encoding="utf-8")

def tips_add(topic, alias, contact, message, files=None, handle=None, allow_public=False):
    tips = load_tips()
    tip_id = "AV-" + datetime.utcnow().strftime("%Y%m%d") + "-" + secrets.token_hex(3).upper()[:6]
    entry = {
        "id": tip_id,
        "received": datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC"),
        "topic": topic or "tip",
        "alias": alias or handle or "",
        "contact": contact or "",
        "message": message,
        "allow_public": 1 if allow_public else 0,
        "files": files or [],
        "read": False,
    }
    tips.append(entry)
    save_tips(tips)
    return entry

def esc(s):
    return html_mod.escape(str(s), quote=True)

def body_to_html(body_text):
    parts = re.split(r"\n\s*\n", body_text.strip())
    out = []
    for part in parts:
        t = esc(part.replace("\n", " ").strip())
        t = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", t)
        t = re.sub(r"(?<!\*)\*([^*]+?)\*(?!\*)", r"<em>\1</em>", t)
        t = re.sub(r"\[([^\]]+)\]\((https?://[^)\s]+)\)", r'<a href="\2" target="_blank" rel="noopener noreferrer">\1</a>', t)
        out.append(f"<p>{t}</p>")
    return "\n          ".join(out)

def slugify(text):
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return s[:60] or f"post-{int(time.time())}"

def rebuild_content_js():
    """Regenerate js/content.js so static site shows current data."""
    tips = load_tips()
    answers = []
    for t in tips:
        r = t.get("reply")
        if r and r.get("published") and r.get("text"):
            answers.append({
                "id": t["id"],
                "alias": t.get("alias") or "anonymous",
                "question": (t.get("message") or "")[:220],
                "answer": r["text"],
                "date": r.get("date") or t.get("received",""),
            })
    payload = {
        "generated": time.strftime("%Y-%m-%d %H:%M"),
        "site": load_site_cfg(),
        "posts": sorted(load_posts(), key=lambda p: p.get("date", ""), reverse=True),
        "answers": answers,
    }
    (ROOT / "js" / "content.js").write_text(
        "// Generated by the Avalanche control panel - do not edit by hand.\n"
        "window.AVALANCHE_CONTENT = " + json.dumps(payload, ensure_ascii=False, indent=2) + ";\n",
        encoding="utf-8",
    )
    # also write a plain remote json for mirrors that fetch content.remote.json
    try:
        (ROOT / "content.remote.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass

MANIFEST_FILES = [
    ("index.html",),
    ("about.html",),
    ("submit.html",),
    ("answers.html",),
    ("library.html",),
    ("article.html",),
    ("download.html",),
    ("mirror.html",),
    ("css/styles.css",),
    ("js/script.js",),
    ("js/site.js",),
    ("js/content.js",),
]

def rebuild_package():
    """Recompute checksums into download.html and rebuild zip."""
    rows = []
    for (rel,) in MANIFEST_FILES:
        fpath = ROOT / rel
        if not fpath.exists():
            continue
        import hashlib as _h
        digest = _h.sha256(fpath.read_bytes()).hexdigest()
        kb = round(fpath.stat().st_size / 1024, 1)
        rows.append(f"            <tr><td>{esc(rel)}</td><td>{kb} KB</td>" + f'<td class="hash-cell"><code>{digest}</code></td></tr>')
    # inject into download.html if markers exist
    try:
        page = DOWNLOAD_PAGE.read_text(encoding="utf-8")
        if "<!-- MANIFEST:ROWS:START -->" in page and "<!-- MANIFEST:ROWS:END -->" in page:
            start = page.index("<!-- MANIFEST:ROWS:START -->") + len("<!-- MANIFEST:ROWS:START -->")
            end = page.index("<!-- MANIFEST:ROWS:END -->")
            built = time.strftime("%b %d, %Y")
            page = page[:start] + "\n" + "\n".join(rows) + "\n            " + page[end:]
            page = re.sub(r"Built [A-Z][a-z]{2} \d{1,2}, \d{4}", f"Built {built}", page)
            DOWNLOAD_PAGE.write_text(page, encoding="utf-8")
    except Exception as e:
        print(f"[panel] manifest inject skipped: {e}")
    exclude = {"seattle-avalanche-site.zip", "panel-config.json", "__pycache__", "tips-dropbox.json", "content.remote.json"}
    if ZIP_PATH.exists():
        ZIP_PATH.unlink()
    with zipfile.ZipFile(ZIP_PATH, "w", zipfile.ZIP_DEFLATED) as zf:
        for base, dirs, files in os.walk(ROOT):
            # prune
            dirs[:] = [d for d in dirs if d not in exclude and not d.startswith(".")]
            for name in files:
                if name in exclude or name.startswith("."):
                    continue
                # skip private tips
                if "tips.json" in name or "tips_files" in base:
                    continue
                full = Path(base) / name
                # skip panel-config
                if full.name == "panel-config.json":
                    continue
                zf.write(full, full.relative_to(ROOT))
    return len(rows)

# ---------------------------------------------------------------- ui ----

CSS = """
  :root{--bg:#0a0e14;--s:#141b27;--l:rgba(255,255,255,.09);--t:#e9edf4;--ts:#b7c1d1;--ice:#7dd7ff;--red:#ff5d5d;--grn:#6fe0a8}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--t);font:15px/1.6 system-ui,sans-serif;padding-bottom:60px}
  .wrap{max-width:980px;margin:0 auto;padding:24px}
  header{display:flex;justify-content:space-between;align-items:center;padding:14px 0;border-bottom:1px solid var(--l);margin-bottom:26px}
  .logo{font-weight:800;font-size:18px}.logo span{color:var(--ice)}
  .pill{font-size:11px;color:var(--grn);border:1px solid var(--grn);border-radius:99px;padding:3px 10px;letter-spacing:.08em}
  h1{font-size:22px;margin-bottom:6px}h2{font-size:16px;margin:26px 0 10px;color:var(--ice)}
  .sub{color:#8494ab;font-size:13px}
  .card{background:var(--s);border:1px solid var(--l);border-radius:12px;padding:20px;margin-top:16px}
  label{display:block;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#8494ab;margin:14px 0 5px}
  input[type=text],input[type=password],textarea,select{width:100%;background:#10151f;border:1px solid rgba(255,255,255,.18);border-radius:8px;color:var(--t);font:inherit;padding:10px 12px}
  textarea{min-height:220px;font-family:Consolas,monospace;font-size:13px}
  input:focus,textarea:focus{outline:2px solid var(--ice);outline-offset:1px;border-color:transparent}
  .btn{display:inline-block;background:linear-gradient(135deg,#7dd7ff,#38b6e8);color:#04121b;font-weight:800;font-size:13px;border:0;border-radius:8px;padding:11px 20px;cursor:pointer;text-decoration:none;margin-top:14px}
  .btn:hover{filter:brightness(1.1)}
  .btn.ghost{background:none;border:1px solid rgba(255,255,255,.25);color:var(--ts)}
  .btn.danger{background:none;border:1px solid var(--red);color:var(--red)}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--l)}
  th{font-size:10px;letter-spacing:.14em;color:#8494ab;text-transform:uppercase}
  .tag{font-size:10px;font-weight:800;letter-spacing:.1em;border-radius:99px;padding:2px 8px;text-transform:uppercase}
  .pub{color:var(--grn);border:1px solid var(--grn)}.draft{color:#ffd166;border:1px solid #ffd166}
  .flash{background:rgba(111,224,168,.08);border:1px solid var(--grn);color:var(--grn);border-radius:8px;padding:10px 14px;margin-top:14px;font-size:13px}
  .err{background:rgba(255,93,93,.08);border-color:var(--red);color:var(--red)}
  a{color:var(--ice)}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:0 18px}
  @media(max-width:700px){.grid2{grid-template-columns:1fr}}
  .tip{border:1px solid var(--l);border-radius:10px;padding:14px;margin-top:12px;background:rgba(255,255,255,.02)}
  .tip.unread{border-color:rgba(125,215,255,.4);background:rgba(125,215,255,.06)}
"""

def shell(title, inner, flash="", logged_in=False, err=False):
    nav_extra = '<a href="/tips">Inbox</a> · <a href="/logout">Log out</a>' if logged_in else ""
    # tips badge
    tips = load_tips() if logged_in else []
    unread = sum(1 for t in tips if not t.get("read"))
    badge = f' <span style="background:var(--ice);color:#04121b;border-radius:99px;padding:2px 7px;font-size:11px;">{unread} new</span>' if unread else ""
    if logged_in and "/tips" not in nav_extra:
        pass
    fl = f'<div class="flash{" err" if err else ""}">{flash}</div>' if flash else ""
    nav_html = f'<div style="display:flex;gap:14px;align-items:center">{nav_extra}{badge}</div>' if logged_in else ""
    return f"""<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>{esc(title)} - Avalanche Control Panel</title>
<style>{CSS}</style></head><body><div class="wrap">
<header><div class="logo">❄ The Seattle <span>Avalanche</span> - Control Panel</div>
{nav_html}</header>
{fl}{inner}</div></body></html>"""

LOGIN_FORM = """
<div class="card" style="max-width:420px;margin:60px auto 0">
  <h1>Private entrance</h1>
  <p class="sub">This panel exists only on this machine (127.0.0.1). 3 wrong attempts = 30s lockout.</p>
  <form method="post" action="/login">
    <label>Password</label>
    <input type="password" name="password" autofocus autocomplete="current-password">
    <button class="btn" type="submit">Unlock →</button>
  </form>
  <p class="sub" style="margin-top:12px">First run? Start with <code>python panel.py --password YOURPASS</code></p>
</div>"""

def dash(site, posts, flash=""):
    inv = site.get("investigation", {})
    notices = site.get("notices", [])
    mirrors = site.get("mirrors", [])
    tips = load_tips()
    unread = sum(1 for t in tips if not t.get("read"))
    rows = "".join(
        f"""<tr><td><a href="/edit?p={esc(p['slug'])}">{esc(p['title'])}</a><br>
        <span class="sub">/{esc(p['slug'])}</span></td>
        <td>{esc(p.get('date',''))}</td>
        <td><span class="tag {'pub' if p.get('status')=='published' else 'draft'}">{esc(p.get('status','draft'))}</span></td>
        <td><a href="/edit?p={esc(p['slug'])}">Edit</a> · <a href="/toggle?p={esc(p['slug'])}">Toggle</a> · <a href="#" onclick="if(confirm('Delete &quot;{esc(p['slug'])}&quot;?'))location='/delete?p='+encodeURIComponent('{esc(p['slug'])}')">Delete</a></td></tr>"""
        for p in sorted(posts, key=lambda x: x.get("date",""), reverse=True)
    ) or '<tr><td colspan="4" class="sub">No posts yet - create your first story below.</td></tr>'
    return shell("Dashboard", f"""
<h1>Mission control</h1>
<p class="sub">Edits write straight to files in this folder. Rebuild after changes. Tips inbox: <a href="/tips">{len(tips)} total, {unread} unread</a> · <a href="/backup">Download backup JSON</a></p>

<h2>Current investigation</h2>
<div class="card">
<form method="post" action="/settings">
  <div class="grid2">
    <div><label>Case number</label><input type="text" name="inv_number" value="{esc(inv.get('number','001'))}"></div>
    <div><label>Stage (shown on homepage)</label><input type="text" name="inv_stage" value="{esc(inv.get('stage',''))}"></div>
  </div>
  <label>Title - leave blank to keep it withheld</label>
  <input type="text" name="inv_title" value="{esc(inv.get('title',''))}" placeholder="(withheld until publication)">
  <label>Opened</label>
  <input type="text" name="inv_opened" value="{esc(inv.get('opened',''))}">
  <label>Status blurb</label>
  <textarea name="inv_blurb" style="min-height:90px">{esc(inv.get('blurb',''))}</textarea>
  <label>Motto (under masthead)</label>
  <input type="text" name="motto" value="{esc(site.get('motto',''))}">
  <label>Notices ticker (one per line - shows on homepage)</label>
  <textarea name="notices" style="min-height:90px">{esc(chr(10).join(notices))}</textarea>
  <label>Mirrors (one URL per line)</label>
  <textarea name="mirrors" style="min-height:70px">{esc(chr(10).join(mirrors))}</textarea>
  <button class="btn" type="submit">Save settings & rebuild</button>
</form>
</div>

<h2>Stories ({len(posts)})</h2>
<div class="card">
<table><tr><th>Title</th><th>Date</th><th>Status</th><th></th></tr>{rows}</table>
<a class="btn" href="/new">＋ New story</a>
<form id="rebuild" method="post" action="/rebuild" style="display:inline"><button class="btn ghost" type="submit">⟳ Rebuild package & checksums</button></form>
<a class="btn ghost" href="/tips">Open inbox ({unread} new)</a>
</div>
""", flash=flash, logged_in=True)

def post_form(post=None, flash="", err=False):
    p = post or {}
    return shell("Edit story", f"""
<h1>{"Edit story" if post else "New story"}</h1>
<form method="post" action="/save">
<input type="hidden" name="orig_slug" value="{esc(p.get('slug',''))}">
<label>Headline</label>
<input type="text" name="title" value="{esc(p.get('title',''))}" required>
<label>Dek / standfirst</label>
<textarea name="dek" style="min-height:70px">{esc(p.get('dek',''))}</textarea>
<div class="grid2">
  <div><label>Date (YYYY-MM-DD)</label><input type="text" name="date" value="{esc(p.get('date', str(date.today())))}"></div>
  <div><label>Status</label>
    <select name="status">
      <option value="draft" {'selected' if p.get('status')!='published' else ''}>draft - hidden</option>
      <option value="published" {'selected' if p.get('status')=='published' else ''}>published - live</option>
    </select></div>
</div>
<label>Tags (comma separated)</label>
<input type="text" name="tags" value="{esc(', '.join(p.get('tags', [])))}">
<label>Body - blank line between paragraphs · **bold** · *italic* · [link](https://…)</label>
<textarea name="body" required>{esc(p.get('_raw_body',''))}</textarea>
<button class="btn" type="submit">Save & rebuild</button>
<a class="btn ghost" href="/">Cancel</a>
</form>""", flash=flash, logged_in=True, err=err)

def tips_page(flash=""):
    tips = load_tips()
    # newest first
    tips_sorted = list(reversed(tips))
    if not tips_sorted:
        body = '<div class="card"><p class="sub">No submissions yet. Share your <code>submit.html</code> link to get tips.</p></div>'
    else:
        rows = ""
        for t in tips_sorted:
            files_html = ""
            for fname in t.get("files", []):
                safe = esc(fname)
                rows_files = f'<a href="/file?id={esc(t["id"])}&name={safe}" target="_blank">{safe}</a>'
                files_html += rows_files + " "
            reply = t.get("reply", {})
            reply_text = esc(reply.get("text",""))
            published = reply.get("published")
            unread_cls = " unread" if not t.get("read") else ""
            alias = esc(t.get("alias") or "anonymous")
            contact = esc(t.get("contact") or "")
            contact_line = f'<br><span class="sub">Reply to: {contact}</span>' if contact else '<br><span class="sub">No reply address - use answers board</span>'
            allow_pub = t.get("allow_public")
            consent_badge = '<span class="tag pub" style="margin-left:8px">allows public anonymized post</span>' if allow_pub else '<span class="tag draft" style="margin-left:8px">private only</span>'
            rows += f"""
<div class="tip{unread_cls}">
  <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap">
    <div><b>{esc(t["id"])}</b> · {esc(t.get("topic","tip"))} · {esc(t.get("received",""))} · <b>{alias}</b>{consent_badge}{contact_line}</div>
    <div><span class="tag {'pub' if t.get("read") else 'draft'}">{'read' if t.get("read") else 'new'}</span></div>
  </div>
  <div style="margin-top:10px;white-space:pre-wrap;background:rgba(255,255,255,.04);padding:10px;border-radius:8px">{esc(t.get("message",""))}</div>
  <div style="margin-top:8px;font-size:13px">{files_html or '<span class="sub">No files</span>'} · <a href="/tips/read?id={esc(t["id"])}">Mark read</a> · <a href="/tips/del?id={esc(t["id"])}" onclick="return confirm('Delete?')">Delete</a></div>
  <form method="post" action="/tips/reply" style="margin-top:12px">
    <input type="hidden" name="id" value="{esc(t["id"])}">
    <label>Reply (stored; publish = appears on public answers board)</label>
    <textarea name="reply_text" style="min-height:90px">{reply_text}</textarea>
    <label style="display:flex;gap:8px;align-items:center;margin-top:8px;font-size:13px"><input type="checkbox" name="published" value="1" {'checked' if published else ''}> Publish publicly</label>
    <button class="btn" type="submit">Save reply & rebuild</button>
  </form>
</div>"""
        body = rows + f'<p class="sub" style="margin-top:14px"><a href="/tips/clear">Mark all read</a></p>'
    return shell("Inbox", f"""
<h1>Dropbox inbox - {len(tips)} messages</h1>
<p class="sub">Private. Only visible here on 127.0.0.1. Replies with “Publish” appear on <a href="/../answers.html" target="_blank">answers.html</a> after rebuild.</p>
{body}
<p><a class="btn ghost" href="/">← Dashboard</a> <a class="btn ghost" href="/backup">Export backup</a></p>
""", flash=flash, logged_in=True)

# ---------------------------------------------------------------- server ----

class Handler(BaseHTTPRequestHandler):
    cfg = None
    def log_message(self, fmt, *args):
        sys.stderr.write("[panel] %s\n" % (fmt % args))
    def _send(self, code, body, ctype="text/html; charset=utf-8", extra=""):
        raw = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("X-Robots-Tag", "noindex")
        if extra:
            self.send_header("Set-Cookie", extra)
        self.end_headers()
        self.wfile.write(raw)
    def _redirect(self, loc, extra=""):
        self.send_response(303)
        self.send_header("Location", loc)
        if extra:
            self.send_header("Set-Cookie", extra)
        self.end_headers()
    def _authed(self):
        cookies = self.headers.get("Cookie", "")
        m = re.search(r"av_session=([^;]+)", cookies)
        return bool(m and session_valid(self.cfg, m.group(1)))
    def _form(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length).decode("utf-8", errors="ignore")
        return {k: v[0] for k, v in urllib_parse.parse_qs(raw, keep_blank_values=True).items()}
    def _json(self, obj, code=200):
        raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)
    # -- routes
    def do_GET(self):
        route = urllib_parse.urlparse(self.path)
        path, query = route.path, urllib_parse.parse_qs(route.query)
        if path == "/logout":
            self._redirect("/login", "av_session=; Max-Age=0; Path=/")
            return
        if path == "/login":
            self._send(200, shell("Login", LOGIN_FORM))
            return
        # public API for local PHP-less testing: POST /api/tip is handled in POST, but allow GET for probe
        if path == "/api/tip":
            self._send(405, shell("Method not allowed", "<p>POST only</p>", logged_in=False))
            return
        if path == "/backup":
            if not self._authed():
                self._redirect("/login"); return
            data = {"site": load_site_cfg(), "posts": load_posts(), "tips": load_tips(), "generated": time.strftime("%Y-%m-%d %H:%M")}
            raw = json.dumps(data, indent=2, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Disposition", "attachment; filename=avalanche-backup.json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        # file serving for tip attachments
        if path == "/file":
            if not self._authed():
                self._redirect("/login"); return
            tid = (query.get("id") or [""])[0]
            name = (query.get("name") or [""])[0]
            # sanitize
            if not re.match(r"^AV-[0-9-]+$", tid) or "/" in name or "\\" in name or ".." in name:
                self._send(400, shell("Bad request", "<p>Invalid file reference</p>", logged_in=True)); return
            fpath = TIPS_FILES_DIR / tid / name
            if not fpath.exists() or not fpath.is_file():
                # also check above-root legacy
                alt = Path(__file__).resolve().parent.parent / "tips-files" / tid / name
                if alt.exists():
                    fpath = alt
                else:
                    self._send(404, shell("Not found", "<p>No such file</p>", logged_in=True)); return
            ctype = mimetypes.guess_type(str(fpath))[0] or "application/octet-stream"
            raw = fpath.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Disposition", f'inline; filename="{name}"')
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        if not self._authed():
            self._redirect("/login"); return
        if path in ("/", "/dashboard"):
            self._send(200, dash(load_site_cfg(), load_posts()))
        elif path == "/new":
            self._send(200, post_form())
        elif path == "/edit":
            slug = (query.get("p") or [""])[0]
            match = next((p for p in load_posts() if p["slug"] == slug), None)
            if match:
                # reconstruct raw body from html for editing? Store original if available
                raw_candidates = []
                if "_raw_body" in match:
                    raw_candidates.append(match["_raw_body"])
                # try to find .txt counterpart? fallback to stripped html
                try:
                    # crude html -> text: strip tags
                    txt = re.sub(r"<[^>]+>", "", match.get("body_html",""))
                    match["_raw_body"] = txt.strip()
                except Exception:
                    match["_raw_body"] = ""
                self._send(200, post_form(match))
            else:
                self._send(404, shell("Not found", "<h1>No such story.</h1>", logged_in=True))
        elif path == "/delete":
            slug = (query.get("p") or [""])[0]
            target = POSTS_DIR / f"{slug}.json"
            if slug and target.exists():
                target.unlink()
                rebuild_content_js()
                self._redirect("/")
            else:
                self._send(404, shell("Not found", "<h1>No such story.</h1>", logged_in=True))
        elif path == "/toggle":
            slug = (query.get("p") or [""])[0]
            target = POSTS_DIR / f"{slug}.json"
            if target.exists():
                data = json.loads(target.read_text(encoding="utf-8"))
                data["status"] = "draft" if data.get("status")=="published" else "published"
                target.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
                rebuild_content_js()
                self._redirect("/")
            else:
                self._send(404, shell("Not found", "<h1>Not found</h1>", logged_in=True))
        elif path == "/tips":
            self._send(200, tips_page())
        elif path == "/tips/read":
            tid = (query.get("id") or [""])[0]
            tips = load_tips()
            for t in tips:
                if t["id"]==tid:
                    t["read"]=True
            save_tips(tips)
            self._redirect("/tips")
        elif path == "/tips/clear":
            tips = load_tips()
            for t in tips: t["read"]=True
            save_tips(tips)
            self._redirect("/tips")
        elif path == "/tips/del":
            tid = (query.get("id") or [""])[0]
            tips = [t for t in load_tips() if t["id"]!=tid]
            save_tips(tips)
            # also delete files dir
            try:
                import shutil
                shutil.rmtree(TIPS_FILES_DIR / tid, ignore_errors=True)
            except Exception:
                pass
            rebuild_content_js()
            self._redirect("/tips")
        else:
            self._send(404, shell("404", "<h1>Nothing here.</h1>", logged_in=True))

    def do_POST(self):
        path = urllib_parse.urlparse(self.path).path
        if path == "/login":
            pw = self._form().get("password", "")
            if verify_password(self.cfg, pw):
                Handler._fails = []
                self._redirect("/", f"av_session={session_token(self.cfg)}; HttpOnly; SameSite=Strict; Path=/")
            else:
                Handler._fails = getattr(Handler, "_fails", [])
                Handler._fails.append(time.time())
                recent = [t for t in Handler._fails if time.time()-t < 120]
                if len(recent) >= 3:
                    Handler._fails = recent
                    self._send(429, shell("Locked", LOGIN_FORM, flash="Too many failures. Wait 30 seconds.", err=True))
                else:
                    self._send(401, shell("Login", LOGIN_FORM, flash="Wrong password.", err=True))
            return
        # Public tip API (no auth) for local dropbox without PHP
        if path == "/api/tip":
            # accept JSON or form
            length = int(self.headers.get("Content-Length", 0) or 0)
            raw = self.rfile.read(length) if length else b""
            ctype = self.headers.get("Content-Type","")
            data = {}
            try:
                if "application/json" in ctype:
                    data = json.loads(raw.decode("utf-8") or "{}")
                else:
                    data = {k: v[0] for k, v in urllib_parse.parse_qs(raw.decode("utf-8"), keep_blank_values=True).items()}
            except Exception:
                data = {}
            message = (data.get("message") or "").strip()
            if not message:
                self._json({"ok": False, "error": "Message empty"}, 400); return
            honey = data.get("_gotcha") or data.get("website")
            if honey:
                self._json({"ok": True, "id": "filtered"}); return
            alias = data.get("alias") or data.get("handle") or ""
            contact = data.get("contact") or ""
            topic = data.get("topic") or "tip"
            allow_public = bool(data.get("allow_public"))
            entry = tips_add(topic, alias, contact, message, files=[], handle=alias, allow_public=allow_public)
            rebuild_content_js()
            self._json({"ok": True, "id": entry["id"], "files": 0})
            return
        if not self._authed():
            self._redirect("/login"); return
        form = self._form()
        if path == "/settings":
            site = load_site_cfg()
            site["investigation"] = {
                "number": form.get("inv_number","").strip(),
                "title": form.get("inv_title","").strip(),
                "stage": form.get("inv_stage","").strip(),
                "opened": form.get("inv_opened","").strip(),
                "blurb": form.get("inv_blurb","").strip(),
            }
            site["motto"] = form.get("motto","").strip()
            # notices: split lines, strip empty
            notices = [l.strip() for l in form.get("notices","").splitlines() if l.strip()]
            if notices:
                site["notices"] = notices
            else:
                site["notices"] = DEFAULT_SITE["notices"]
            mirrors = [l.strip() for l in form.get("mirrors","").splitlines() if l.strip()]
            if mirrors:
                site["mirrors"] = mirrors
            save_site_cfg(site)
            rebuild_content_js()
            self._send(200, dash(site, load_posts(), flash="Settings saved - content regenerated."))
        elif path == "/save":
            title = form.get("title","").strip() or "Untitled"
            orig = form.get("orig_slug","").strip()
            new_slug = orig if (orig and orig != "None" and orig != "") else slugify(title)
            tags = [t.strip() for t in form.get("tags","").split(",") if t.strip()]
            # keep original raw body for re-edit
            raw_body = form.get("body","")
            post = {"slug": new_slug, "title": title, "dek": form.get("dek","").strip(), "date": form.get("date", str(date.today())), "status": form.get("status","draft"), "tags": tags, "body_html": body_to_html(raw_body), "_raw_body": raw_body}
            if orig and orig != new_slug and (POSTS_DIR / f"{orig}.json").exists():
                (POSTS_DIR / f"{orig}.json").unlink()
            POSTS_DIR.mkdir(parents=True, exist_ok=True)
            (POSTS_DIR / f"{new_slug}.json").write_text(json.dumps(post, indent=2, ensure_ascii=False), encoding="utf-8")
            rebuild_content_js()
            self._send(200, post_form(post, flash="Saved - js/content.js regenerated."))
        elif path == "/rebuild":
            n = rebuild_package()
            self._send(200, dash(load_site_cfg(), load_posts(), flash=f"Package rebuilt: {n} files checksummed, ZIP refreshed."))
        elif path == "/tips/reply":
            tid = form.get("id","").strip()
            text = form.get("reply_text","").strip()
            published = form.get("published") == "1"
            tips = load_tips()
            for t in tips:
                if t["id"]==tid:
                    if text:
                        t["reply"] = {"text": text, "date": time.strftime("%Y-%m-%d %H:%M UTC"), "published": published}
                    else:
                        t.pop("reply", None)
                    t["read"]=True
            save_tips(tips)
            rebuild_content_js()
            self._send(200, tips_page(flash="Reply saved and content rebuilt." if published else "Reply saved (private)."))
        else:
            self._send(404, shell("404", "<h1>Nothing here.</h1>", logged_in=True))

# already imported at top

def main():
    ap = argparse.ArgumentParser(description="Avalanche control panel")
    ap.add_argument("--password", help="set/replace the panel password non-interactively")
    ap.add_argument("--port", type=int, default=PORT)
    args = ap.parse_args()
    if args.password:
        cfg = make_panel_cfg(args.password)
        print("[panel] Password updated.")
    elif PANEL_CFG.exists():
        cfg = load_panel_cfg()
    else:
        print("[panel] First run - choose a password for your control panel.")
        while True:
            pw = input("  password: ").strip()
            if len(pw) >= 8:
                break
            print("  use at least 8 characters.")
        cfg = make_panel_cfg(pw)
    DATA_DIR.mkdir(exist_ok=True)
    POSTS_DIR.mkdir(parents=True, exist_ok=True)
    if not SITE_CFG.exists():
        save_site_cfg(DEFAULT_SITE)
    # ensure tips files dir exists
    TIPS_FILES_DIR.mkdir(parents=True, exist_ok=True)
    rebuild_content_js()
    Handler.cfg = cfg
    server = HTTPServer((HOST, args.port), Handler)
    url = f"http://{HOST}:{args.port}"
    print("="*56)
    print(" AVALANCHE CONTROL PANEL")
    print(f"   Local only : {url}")
    print("   Tips inbox : /tips")
    print("   Config     : panel-config.json  (keep private)")
    print("   Stop       : Ctrl+C")
    print("="*56)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[panel] Shutting down.")

if __name__ == "__main__":
    main()
