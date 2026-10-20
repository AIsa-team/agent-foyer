export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

/** Small standalone page for server-rendered screens (login, consent, access denied). */
export function page(title: string, body: string, lang = 'en'): string {
  return `<!doctype html><html lang="${escapeHtml(lang)}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root{color-scheme:light dark;--bg:#f5f5f4;--card:#fff;--fg:#0a0a0a;--muted:#737373;--line:#e5e5e5}
  @media (prefers-color-scheme:dark){:root{--bg:#0a0a0a;--card:#171717;--fg:#fafafa;--muted:#a3a3a3;--line:#262626}}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);
    font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;padding:16px;box-sizing:border-box}
  main{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:32px;max-width:440px;width:100%;box-sizing:border-box}
  h1{font-size:20px;margin:0 0 12px}
  p{color:var(--muted);margin:0 0 20px}
  form{display:flex;gap:8px;flex-wrap:wrap}
  button,a.btn{font:inherit;padding:8px 18px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer;text-decoration:none}
  button.primary,a.btn.primary{background:var(--fg);color:var(--bg);border-color:var(--fg)}
  ul{list-style:none;padding:0;margin:0;display:grid;gap:8px}
</style></head><body><main>${body}</main></body></html>`;
}
