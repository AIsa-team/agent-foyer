/** Short descriptions of where requests come from, so someone can tell their devices and agents apart. */

/** The system and browser from a browser's User-Agent, e.g. "macOS · Chrome"; null when it says neither. */
export function deviceOf(ua: string | undefined | null): string | null {
  const s = ua ?? '';
  const os = /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? 'Android' : /CrOS/.test(s) ? 'ChromeOS'
    : /Windows NT/.test(s) ? 'Windows' : /Mac OS X|Macintosh/.test(s) ? 'macOS' : /Linux/.test(s) ? 'Linux' : null;
  const browser = /Edg(A|iOS)?\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Firefox\/|FxiOS/.test(s) ? 'Firefox'
    : /Chrome\/|CriOS/.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : null;
  return [os, browser].filter(Boolean).join(' · ') || null;
}

/** An agent's version from the User-Agent it sends, e.g. "codex-mcp-client/0.163.0" → "0.163.0". */
export function agentVersionOf(ua: string | undefined | null): string | null {
  const m = /^[\w.@-]+\/(\d[\w.+-]*)/.exec(ua ?? '');
  return m ? m[1].slice(0, 40) : null;
}
