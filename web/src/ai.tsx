/**
 * Admin: the AI provider apps use through /__hub/ai (bring your own key), the daily limits, and what each app used.
 * AIsa is the ready-made choice (one key for models and data APIs); any OpenAI-compatible provider works for models.
 */
import { useState } from 'react';
import { api } from './api';
import { useI18n } from './i18n';
import { Loading, useAction, useApi } from './ui';

interface Preset { id: 'aisa' | 'openai'; label: string; baseUrl: string; apisUrl: string | null; keyUrl: string | null; docsUrl: string | null }
interface Settings {
  presets: Preset[];
  provider: { preset: Preset['id']; baseUrl: string; apisUrl: string | null; checkedAt?: number; models?: string[]; keySet: boolean } | null;
  limits: { perAppPerDay: number; perPersonPerDay: number };
  disabledApps: string[];
  usage: { days: number; apps: { app: string; calls: number; failed: number; tokens: number; people: number }[] };
}

export function AiSection() {
  const { t, ago } = useI18n();
  const { data, error, reload } = useApi<Settings>('/admin/ai');
  const { busy, run } = useAction();
  const [editing, setEditing] = useState(false);
  const [preset, setPreset] = useState<Preset['id']>('aisa');
  const [baseUrl, setBaseUrl] = useState('');
  const [key, setKey] = useState('');
  const [limits, setLimits] = useState<Settings['limits'] | null>(null);
  if (!data) return <Loading error={error} />;
  const p = data.provider;
  const chosen = data.presets.find((x) => x.id === preset)!;
  const save = () => run(() => api.post('/admin/ai', { preset, baseUrl, key }), t('ai.saved')).then((ok) => { if (ok) { setKey(''); setEditing(false); reload(); } });
  const lim = limits ?? data.limits;
  const toggleApp = (slug: string) => {
    const off = new Set(data.disabledApps);
    if (off.has(slug)) off.delete(slug); else off.add(slug);
    void run(() => api.post('/admin/ai/limits', { disabledApps: [...off] }), t('ai.saved')).then(reload);
  };
  const form = (
    <div className="stack" style={{ gap: 10 }}>
      <div className="stack" style={{ gap: 6 }}>
        {data.presets.map((x) => (
          <label key={x.id} className={`option ${preset === x.id ? 'selected' : ''}`}>
            <input type="radio" name="ai-preset" checked={preset === x.id} onChange={() => setPreset(x.id)} />
            <span><b>{x.label}</b>{x.id === 'aisa' && <span className="badge" style={{ marginLeft: 6 }}>{t('ai.recommended')}</span>}<br />
              <span className="small muted">{t(x.id === 'aisa' ? 'ai.preset.aisa' : 'ai.preset.openai')}</span></span>
          </label>
        ))}
      </div>
      {preset === 'openai' && <input className="input" placeholder="https://api.example.com/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <input className="input grow" style={{ minWidth: 220 }} type="password" autoComplete="off" placeholder={p?.keySet && p.preset === preset ? t('ai.keyKeep') : t('ai.key')} value={key} onChange={(e) => setKey(e.target.value)} />
        <button className="btn primary" type="button" disabled={busy || (!key.trim() && !(p?.keySet && p.preset === preset)) || (preset === 'openai' && !baseUrl.trim())} onClick={save}>{t('ai.test')}</button>
        {p && <button className="btn ghost" type="button" onClick={() => setEditing(false)}>{t('common.cancel')}</button>}
      </div>
      {chosen.keyUrl && <p className="small muted" style={{ margin: 0 }}>{t('ai.getKey')} <a href={chosen.keyUrl} target="_blank" rel="noreferrer">{chosen.keyUrl.replace(/^https:\/\//, '')}</a></p>}
    </div>
  );
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="card pad">
        <p className="small muted" style={{ marginTop: 0 }}>{t('ai.hint')}</p>
        {!p || editing ? form : (
          <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
            <div className="grow" style={{ minWidth: 0 }}>
              <div><b>{data.presets.find((x) => x.id === p.preset)?.label}</b> <span className="badge ok">{t('ai.connected')}</span></div>
              <div className="small muted ellipsis">{p.baseUrl}{p.apisUrl ? ` · ${t('ai.dataApis')}` : ''} · {t('ai.models', { n: p.models?.length ?? 0 })}{p.checkedAt ? ` · ${t('ai.checked', { ago: ago(p.checkedAt) })}` : ''}</div>
            </div>
            <button className="btn sm" type="button" onClick={() => { setPreset(p.preset); setBaseUrl(p.preset === 'openai' ? p.baseUrl : ''); setEditing(true); }}>{t('ai.change')}</button>
            <button className="btn sm ghost danger" type="button" disabled={busy}
              onClick={() => confirm(t('ai.removeConfirm')) && run(() => api.del('/admin/ai'), t('ai.removed')).then(reload)}>{t('ai.remove')}</button>
          </div>
        )}
      </div>
      {p && (
        <div className="card pad">
          <div className="small" style={{ fontWeight: 600, marginBottom: 8 }}>{t('ai.limits')}</div>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <label className="row small" style={{ gap: 6 }}>{t('ai.perApp')}
              <input className="input" type="number" min={0} style={{ width: 100 }} value={lim.perAppPerDay} onChange={(e) => setLimits({ ...lim, perAppPerDay: Number(e.target.value) })} /></label>
            <label className="row small" style={{ gap: 6 }}>{t('ai.perPerson')}
              <input className="input" type="number" min={0} style={{ width: 100 }} value={lim.perPersonPerDay} onChange={(e) => setLimits({ ...lim, perPersonPerDay: Number(e.target.value) })} /></label>
            <button className="btn sm" type="button" disabled={busy || !limits} onClick={() => run(() => api.post('/admin/ai/limits', { limits: lim }), t('ai.saved')).then(() => { setLimits(null); reload(); })}>{t('common.save')}</button>
          </div>
          <div className="small" style={{ fontWeight: 600, margin: '16px 0 8px' }}>{t('ai.usage', { n: data.usage.days })}</div>
          {data.usage.apps.length === 0 && data.disabledApps.length === 0 ? <p className="small muted" style={{ margin: 0 }}>{t('ai.noUsage')}</p> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>{t('ai.col.app')}</th><th>{t('ai.col.calls')}</th><th className="hide-sm">{t('ai.col.failed')}</th><th className="hide-sm">{t('ai.col.tokens')}</th><th className="hide-sm">{t('ai.col.people')}</th><th /></tr></thead>
                <tbody>
                  {[...data.usage.apps, ...data.disabledApps.filter((s) => !data.usage.apps.some((a) => a.app === s)).map((s) => ({ app: s, calls: 0, failed: 0, tokens: 0, people: 0 }))].map((a) => {
                    const off = data.disabledApps.includes(a.app);
                    return (
                      <tr key={a.app}>
                        <td className="mono small">{a.app}{off && <span className="badge warn" style={{ marginLeft: 6 }}>{t('ai.off')}</span>}</td>
                        <td>{a.calls.toLocaleString()}</td>
                        <td className="hide-sm">{a.failed.toLocaleString()}</td>
                        <td className="hide-sm">{a.tokens.toLocaleString()}</td>
                        <td className="hide-sm">{a.people}</td>
                        <td style={{ textAlign: 'right' }}><button className="btn sm ghost" type="button" disabled={busy} onClick={() => toggleApp(a.app)}>{t(off ? 'ai.turnOn' : 'ai.turnOff')}</button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
