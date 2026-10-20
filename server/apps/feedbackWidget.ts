/**
 * The 「feedback」 button the gateway adds to app pages (unless the owner turned it off): a small pill in the corner
 * that opens a form and posts to /__hub/feedback as the signed-in person. It lives in a shadow root so the app's
 * styles and the button's never touch.
 */
import { tr } from '../i18n/index.ts';

export const WIDGET_TAG = '<script src="/__hub/feedback.js" defer></script>';

/** Adds the script tag before the last </body>, or at the end when there is none. */
export function injectWidget(html: string): string {
  const at = html.toLowerCase().lastIndexOf('</body>');
  return at === -1 ? html + WIDGET_TAG : html.slice(0, at) + WIDGET_TAG + html.slice(at);
}

export function widgetJs(locale: string): string {
  const s = Object.fromEntries((['fb.button', 'fb.title', 'fb.hint', 'fb.placeholder', 'fb.send', 'fb.cancel', 'fb.sent', 'fb.hide', 'fb.failed'] as const)
    .map((k) => [k.slice(3), tr(locale, k)]));
  return `(${widget.toString()})(${JSON.stringify(s)});`;
}

// Runs in the app page. Plain browser JS: no imports, nothing from the outer module.
function widget(s: Record<string, string>) {
  if (window.top !== window || document.getElementById('hub-feedback')) return;
  try {
    if (sessionStorage.getItem('hub-feedback-hidden')) return;
  } catch { /* storage blocked: keep the button */ }
  const host = document.createElement('div');
  host.id = 'hub-feedback';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
  :host { all: initial; }
  * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  .wrap { --bg: #fff; --fg: #1a1a18; --muted: #6b6a66; --line: rgba(26, 26, 24, .14); --ink: #1a1a18; --on-ink: #fff; }
  @media (prefers-color-scheme: dark) { .wrap { --bg: #22221f; --fg: #f3f1ec; --muted: #a9a69e; --line: rgba(243, 241, 236, .16); --ink: #f3f1ec; --on-ink: #1a1a18; } }
  .pill { position: fixed; right: 16px; bottom: 16px; z-index: 2147483000; display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px;
    border: 1px solid var(--line); border-radius: 999px; background: var(--bg); color: var(--fg); font-size: 13px; line-height: 1; cursor: pointer;
    box-shadow: 0 2px 10px rgba(0, 0, 0, .12); opacity: .92; transition: opacity .15s, box-shadow .15s; }
  .pill:hover, .pill:focus-visible { opacity: 1; box-shadow: 0 4px 16px rgba(0, 0, 0, .16); }
  .pill svg { width: 15px; height: 15px; }
  .panel { position: fixed; right: 16px; bottom: 58px; z-index: 2147483000; width: min(340px, calc(100vw - 32px)); padding: 16px; border: 1px solid var(--line);
    border-radius: 14px; background: var(--bg); color: var(--fg); box-shadow: 0 12px 40px rgba(0, 0, 0, .18); font-size: 13px; }
  .panel[hidden], .pill[hidden] { display: none; }
  h2 { margin: 0 0 4px; font-size: 15px; font-weight: 600; }
  p { margin: 0 0 10px; color: var(--muted); line-height: 1.5; }
  textarea { width: 100%; min-height: 96px; resize: vertical; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: transparent;
    color: var(--fg); font-size: 13px; line-height: 1.5; outline: none; }
  textarea:focus { border-color: var(--fg); }
  .row { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
  .grow { flex: 1; }
  button { font-size: 13px; cursor: pointer; }
  .ghost { border: 0; background: none; color: var(--muted); padding: 6px 4px; }
  .ghost:hover { color: var(--fg); }
  .btn { height: 30px; padding: 0 12px; border: 1px solid var(--line); border-radius: 999px; background: transparent; color: var(--fg); }
  .primary { background: var(--ink); color: var(--on-ink); border-color: var(--ink); }
  .primary:disabled { opacity: .45; cursor: default; }
  .msg { margin: 8px 0 0; color: var(--muted); }
  @media print { .pill, .panel { display: none; } }
</style>
<div class="wrap">
  <button class="pill" type="button" aria-haspopup="dialog"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><span></span></button>
  <div class="panel" role="dialog" hidden>
    <h2></h2><p class="hint"></p>
    <textarea maxlength="2000"></textarea>
    <p class="msg" hidden></p>
    <div class="row"><button class="ghost hide" type="button"></button><span class="grow"></span><button class="btn cancel" type="button"></button><button class="btn primary send" type="button" disabled></button></div>
  </div>
</div>`;
  const $ = <T extends Element>(q: string) => root.querySelector(q) as T;
  const pill = $<HTMLButtonElement>('.pill');
  const panel = $<HTMLDivElement>('.panel');
  const text = $<HTMLTextAreaElement>('textarea');
  const send = $<HTMLButtonElement>('.send');
  const msg = $<HTMLParagraphElement>('.msg');
  $('.pill span').textContent = s.button;
  $('h2').textContent = s.title;
  $('.hint').textContent = s.hint;
  text.placeholder = s.placeholder;
  panel.setAttribute('aria-label', s.title);
  send.textContent = s.send;
  $('.cancel').textContent = s.cancel;
  $('.hide').textContent = s.hide;
  const open = (on: boolean) => {
    panel.hidden = !on;
    pill.setAttribute('aria-expanded', String(on));
    if (on) text.focus();
  };
  pill.addEventListener('click', () => open(panel.hidden === true));
  $('.cancel').addEventListener('click', () => open(false));
  $('.hide').addEventListener('click', () => {
    try {
      sessionStorage.setItem('hub-feedback-hidden', '1');
    } catch { /* only for this page then */ }
    host.remove();
  });
  root.addEventListener('keydown', (e) => (e as KeyboardEvent).key === 'Escape' && open(false));
  text.addEventListener('input', () => {
    send.disabled = text.value.trim().length < 2;
  });
  send.addEventListener('click', async () => {
    send.disabled = true;
    msg.hidden = true;
    try {
      const r = await fetch('/__hub/feedback', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-hub-feedback': '1' },
        body: JSON.stringify({ body: text.value, page: location.pathname + location.search + location.hash }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || s.failed);
      text.value = '';
      msg.textContent = s.sent;
      msg.hidden = false;
      setTimeout(() => { msg.hidden = true; open(false); }, 2500);
    } catch (e) {
      msg.textContent = (e as Error).message || s.failed;
      msg.hidden = false;
      send.disabled = false;
    }
  });
  document.body.appendChild(host);
}
