import { useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { useI18n, type MessageKey } from '../i18n';
import { Empty, Loading, useApi } from '../ui';
import { barChart, lineChart, statTile } from '../brand/aisa-charts.js';

interface Dashboard {
  on: boolean; setUp: boolean; timezone: string; lastCheck: number | null; stalled: boolean;
  week: { conversations: number; predictions: number; accuracy: number | null; closeness: number | null };
  memories: number | null; toReview: number;
  days: { day: string; predictions: number; accuracy: number | null }[];
  scenarios: { name: string; n: number; accuracy: number }[];
  calls: { replyReplied: number; replyNone: number; noReplyReplied: number; noReplyNone: number };
  closeness: number[];
  forms: { text: number; reaction: number; guessed: number; right: number };
  sources: { live: number; replay: number };
  changes: { doc: 'profile' | 'style'; state: string; at: number }[];
}

type Mount = (host: HTMLElement, cfg: Record<string, unknown>) => { destroy(): void };

/** One chart from the brand library; it owns the inside of its box and redraws when its numbers change. */
function Chart({ fn, cfg }: { fn: Mount; cfg: Record<string, unknown> }) {
  const ref = useRef<HTMLDivElement>(null);
  const key = JSON.stringify(cfg);
  useEffect(() => {
    if (!ref.current) return;
    const h = fn(ref.current, cfg);
    return () => h.destroy();
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div ref={ref} />;
}

/**
 * The person's AI twin in numbers: how much it looked at, how often it guessed right whether they would reply, per
 * day and per scenario, how close its replies came, and what changed in its documents. Only they see it; it shows
 * counts the hub keeps, never message text.
 */
export function TwinPage() {
  const { t, locale } = useI18n();
  const { data } = useApi<Dashboard>('/lark/twin/dashboard');
  if (!data) return <Loading />;
  const time = (ms: number) => new Intl.DateTimeFormat(locale, { timeZone: data.timezone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
  const short = (day: string) => day.slice(5).replace('-', '/');
  const any = data.days.some((d) => d.predictions);
  const c = data.calls;
  const settled = c.replyReplied + c.replyNone + c.noReplyReplied + c.noReplyNone;
  const share = (n: number) => (settled ? `${Math.round((n / settled) * 100)}%` : '—');
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('twin.dash.title')}</h1>
          <p>{t('twin.dash.intro')} <Link to="/me" style={{ textDecoration: 'underline' }}>{t('twin.dash.settings')}</Link></p>
        </div>
      </div>

      {!data.setUp ? <div className="card"><Empty title={t('twin.dash.notSetUp')} hint={t('me.twin.startBody')} /></div> : (
        <div className="stack" style={{ gap: 16 }}>
          <div className={`card pad twin-patrol ${data.stalled || !data.on ? 'is-off' : ''}`}>
            <span className="twin-patrol__dot" />
            <span>
              {!data.on ? t('twin.dash.off')
                : !data.lastCheck ? t('twin.dash.neverChecked')
                : data.stalled ? t('twin.dash.stalled', { time: time(data.lastCheck) })
                : t('twin.dash.patrolling', { time: time(data.lastCheck) })}
            </span>
          </div>

          <div className="twin-tiles">
            <div className="card pad"><Chart fn={statTile} cfg={{ label: t('twin.dash.conversations'), value: data.week.conversations, format: { decimals: 0 } }} /></div>
            <div className="card pad"><Chart fn={statTile} cfg={{ label: t('twin.dash.predictions'), value: data.week.predictions, format: { decimals: 0 }, trend: data.days.slice(-14).map((d) => d.predictions) }} /></div>
            <div className="card pad"><Chart fn={statTile} cfg={{ label: t('twin.dash.accuracy'), value: data.week.accuracy ?? '—', format: { style: 'percent', decimals: 0 } }} /></div>
            <div className="card pad"><Chart fn={statTile} cfg={{ label: t('twin.dash.closeness'), value: data.week.closeness ?? '—', format: { decimals: 1 } }} /></div>
            <div className="card pad"><Chart fn={statTile} cfg={{ label: t('twin.dash.memories'), value: data.memories ?? '—', format: { decimals: 0 } }} /></div>
            <div className="card pad"><Chart fn={statTile} cfg={{ label: t('twin.dash.toReview'), value: data.toReview, format: { decimals: 0 } }} /></div>
          </div>
          <p className="small muted" style={{ margin: '-6px 0 0' }}>{t('twin.dash.weekNote', { live: data.sources.live, replay: data.sources.replay })}</p>

          {!any ? <div className="card"><Empty title={t('twin.dash.noPredictions')} hint={t('twin.dash.noPredictionsBody')} /></div> : <>
            <div className="grid wide">
              <div className="card pad">
                <Chart fn={lineChart} cfg={{
                  title: t('twin.dash.accuracyByDay'), subtitle: t('twin.dash.accuracyByDaySub'), height: 220,
                  labels: data.days.map((d) => short(d.day)), series: [{ name: t('twin.dash.accuracy'), values: data.days.map((d) => d.accuracy) }],
                  format: { style: 'percent', decimals: 0 },
                }} />
              </div>
              <div className="card pad">
                <Chart fn={barChart} cfg={{
                  title: t('twin.dash.volumeByDay'), height: 220,
                  categories: data.days.map((d) => short(d.day)), series: [{ name: t('twin.dash.predictions'), values: data.days.map((d) => d.predictions) }],
                  format: { decimals: 0 },
                }} />
              </div>
            </div>

            <div className="grid wide">
              <div className="card pad">
                {data.scenarios.length ? (
                  <Chart fn={barChart} cfg={{
                    title: t('twin.dash.byScenario'), subtitle: t('twin.dash.byScenarioSub'), orientation: 'horizontal', height: Math.max(160, data.scenarios.length * 36),
                    categories: data.scenarios.map((s) => `${s.name} · ${s.n}`), series: [{ name: t('twin.dash.accuracy'), values: data.scenarios.map((s) => s.accuracy) }],
                    format: { style: 'percent', decimals: 0 },
                  }} />
                ) : <p className="small muted">{t('twin.dash.noScenarios')}</p>}
              </div>
              <div className="card pad">
                <h3 className="twin-card-title">{t('twin.dash.calls')}</h3>
                <p className="small muted" style={{ margin: '0 0 10px' }}>{t('twin.dash.callsSub', { n: settled })}</p>
                <table className="twin-calls">
                  <thead><tr><th /><th>{t('twin.dash.youReplied')}</th><th>{t('twin.dash.youDidNot')}</th></tr></thead>
                  <tbody>
                    <tr><th>{t('twin.dash.itSaidReply')}</th><td className="is-right"><b>{c.replyReplied}</b> <span className="muted">{share(c.replyReplied)}</span></td><td><b>{c.replyNone}</b> <span className="muted">{share(c.replyNone)}</span><div className="small muted">{t('twin.dash.extra')}</div></td></tr>
                    <tr><th>{t('twin.dash.itSaidNo')}</th><td><b>{c.noReplyReplied}</b> <span className="muted">{share(c.noReplyReplied)}</span><div className="small muted">{t('twin.dash.missed')}</div></td><td className="is-right"><b>{c.noReplyNone}</b> <span className="muted">{share(c.noReplyNone)}</span></td></tr>
                  </tbody>
                </table>
                {data.forms.text + data.forms.reaction > 0 && (
                  <p className="small" style={{ margin: '14px 0 0' }}>
                    {t('twin.dash.forms', { n: data.forms.text + data.forms.reaction, reaction: data.forms.reaction, share: `${Math.round((data.forms.reaction / (data.forms.text + data.forms.reaction)) * 100)}%` })}
                    {data.forms.guessed > 0 && <>{t('twin.dash.formsRight', { share: `${Math.round((data.forms.right / data.forms.guessed) * 100)}%` })}</>}
                  </p>
                )}
              </div>
            </div>

            <div className="grid wide">
              <div className="card pad">
                <Chart fn={barChart} cfg={{
                  title: t('twin.dash.closenessDist'), subtitle: t('twin.dash.closenessSub'), height: 200,
                  categories: ['1', '2', '3', '4', '5'], series: [{ name: t('twin.dash.predictions'), values: data.closeness }], format: { decimals: 0 },
                }} />
              </div>
              <div className="card pad">
                <h3 className="twin-card-title">{t('twin.dash.changes')}</h3>
                {data.changes.length ? (
                  <ul className="twin-changes">
                    {data.changes.map((ch) => (
                      <li key={`${ch.at}-${ch.doc}`}>
                        <span className="muted mono small">{time(ch.at)}</span>
                        <span>{t(ch.doc === 'profile' ? 'me.twin.profile' : 'me.twin.style')}</span>
                        <span className={`twin-change twin-change--${ch.state}`}>{t(`twin.dash.state.${ch.state}` as MessageKey)}</span>
                      </li>
                    ))}
                  </ul>
                ) : <p className="small muted">{t('twin.dash.noChanges')}</p>}
              </div>
            </div>
          </>}
        </div>
      )}
    </>
  );
}
