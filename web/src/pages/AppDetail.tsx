import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, VISIBILITY_KEYS, type AppInfo, type Feedback, type LocalizedMap, type Person, type SkillInfo, type Visibility } from '../api';
import { useI18n, type MessageKey } from '../i18n';
import { iconPrompt } from '../prompts';
import { FeedbackCard } from '../feedback';
import { CollaboratorsCard } from '../collab';
import { AppIcon, Avatar, CopyBox, Icon, IconEditor, LinkEditor, LocalizedFields, Loading, PersonPicker, sameLocalized, useAction, useApi, useMe } from '../ui';

interface Usage { days: { day: string; people: number }[]; last30: number; total: number }
interface Release { version: number; status: string; created_at: number; created_by_name: string; kind: string }
interface LarkAccess { tables: { name: string; url: string; access: 'read' | 'write' }[]; notify: { people: string[]; chats: string[]; appUsers?: boolean }; mailDrafts: boolean; mailbox: string;
  docs: { parent: string | null; share: 'view' | 'edit' | 'none' | 'wiki' } | null; consented: boolean }

/** What the app may do in Lark as the person using it, and whether this person agreed (with a way to take it back). */
function LarkCard({ lark, consentUrl, slug, reload }: { lark: LarkAccess; consentUrl: string; slug: string; reload: () => void }) {
  const { t } = useI18n();
  const { busy, run } = useAction();
  const who = [...lark.notify.people, ...lark.notify.chats];
  return (
    <div className="card pad">
      <h3>{t('appDetail.lark.title')} {lark.consented && <span className="badge ok" style={{ marginLeft: 6 }}>{t('appDetail.lark.allowed')}</span>}</h3>
      <p className="small muted" style={{ marginTop: 0 }}>{t('appDetail.lark.hint')}</p>
      <div className="stack" style={{ gap: 6 }}>
        {lark.tables.map((tb) => (
          <div key={tb.name} className="row small">
            <span className={`badge ${tb.access === 'write' ? 'warn' : ''}`}>{t(tb.access === 'write' ? 'appDetail.lark.write' : 'appDetail.lark.read')}</span>
            <span className="mono grow">{tb.name}</span>
            <a href={tb.url} target="_blank" rel="noreferrer" className="muted">{t('appDetail.lark.openTable')} <Icon name="external" size={12} /></a>
          </div>
        ))}
        {who.length > 0 && <div className="small">{t('appDetail.lark.notify', { who: who.join(t('common.listSeparator')) })}</div>}
        {lark.notify.appUsers && <div className="small">{t('appDetail.lark.notifyUsers')}</div>}
        {lark.mailDrafts && <div className="small">{t('appDetail.lark.mail', { mailbox: lark.mailbox })}</div>}
        {lark.docs && <div className="small">{t(`appDetail.lark.docs.${lark.docs.share}`)}</div>}
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        {lark.consented
          ? <button className="btn sm ghost danger" disabled={busy} onClick={() => run(() => api.del(`/apps/${slug}/lark-consent`), t('appDetail.lark.revoked')).then(reload)} type="button">{t('appDetail.lark.revoke')}</button>
          : <a className="btn sm" href={consentUrl}>{t('appDetail.lark.allow')}</a>}
      </div>
    </div>
  );
}

const BADGE: Record<string, string> = { online: 'ok', building: 'warn', failed: 'danger', stopped: '', superseded: '' };

function StatusBadge({ status }: { status: string }) {
  const { t } = useI18n();
  return <span className={`badge ${BADGE[status] ?? ''}`}>{t(`status.${status}` as MessageKey)}</span>;
}

function AccessCard({ app, reload }: { app: AppInfo; reload: () => void }) {
  const { t } = useI18n();
  const [vis, setVis] = useState<Visibility>(app.visibility);
  const [members, setMembers] = useState<Person[]>(app.members ?? []);
  const { busy, run } = useAction();
  const dirty = vis !== app.visibility || (vis === 'members' && JSON.stringify(members.map((m) => m.id).sort()) !== JSON.stringify((app.members ?? []).map((m) => m.id).sort()));
  const save = () => run(() => api.post(`/apps/${app.slug}/access`, { visibility: vis, memberIds: vis === 'members' ? members.map((m) => m.id) : undefined }), t('common.saved')).then(reload);
  return (
    <div className="card pad">
      <h3>{t('appDetail.access')}</h3>
      <div className="option-grid">
        {VISIBILITY_KEYS.map((v) => (
          <label key={v} className={`option ${vis === v ? 'selected' : ''}`}>
            <input type="radio" name="vis" checked={vis === v} onChange={() => setVis(v)} />
            <span>
              <span className="row" style={{ fontWeight: 500 }}>
                {t(`visibility.${v}` as MessageKey)}
                {app.visibility === v && <span className="badge dark">{t('appDetail.current')}</span>}
                {v === 'public' && app.visibility === 'public' && app.publicStatus === 'pending' && <span className="badge warn">{t('appDetail.pending')}</span>}
              </span>
              <small>{t(`visibility.${v}.hint` as MessageKey)}</small>
            </span>
          </label>
        ))}
      </div>
      {vis === 'members' && (
        <div style={{ marginTop: 14 }}>
          <span className="label">{t('appDetail.memberList')}</span>
          <PersonPicker value={members} onChange={setMembers} />
        </div>
      )}
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
        <button className="btn primary" disabled={!dirty || busy} onClick={save} type="button">{t('common.save')}</button>
      </div>
    </div>
  );
}

function InfoCard({ app, reload }: { app: AppInfo; reload: () => void }) {
  const { t } = useI18n();
  const [localized, setLocalized] = useState<LocalizedMap>(app.localized ?? {});
  const { busy, run } = useAction();
  useEffect(() => setLocalized(app.localized ?? {}), [app.localized]);
  return (
    <div className="card pad">
      <h3>{t('localized.title')}</h3>
      <LocalizedFields value={localized} onChange={setLocalized} fallback={app} />
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
        <button className="btn" disabled={busy || sameLocalized(localized, app.localized)}
          onClick={() => run(() => api.patch(`/apps/${app.slug}`, { localized }), t('common.saved')).then(reload)} type="button">{t('common.save')}</button>
      </div>
    </div>
  );
}

function IconCard({ app, reload }: { app: AppInfo; reload: () => void }) {
  const me = useMe();
  const { t } = useI18n();
  return <IconEditor src={app.icon} name={app.name} endpoint={`/apps/${app.slug}`} prompt={iconPrompt(me, t, app.slug)} onSaved={reload} />;
}

function SkillLinkCard({ app, reload }: { app: AppInfo; reload: () => void }) {
  const { t } = useI18n();
  const { data } = useApi<{ skills: SkillInfo[] }>('/skills');
  return (
    <LinkEditor title={t('link.skillTitle')} hint={t('link.skillHint')} current={app.relatedSkill?.slug ?? null}
      options={(data?.skills ?? []).filter((s) => s.listed).map((s) => ({ value: s.slug, label: `${s.name} · ${s.slug}` }))}
      endpoint={`/apps/${app.slug}`} field="relatedSkill" onSaved={reload} />
  );
}

function RunCard({ app, reload }: { app: AppInfo; reload: () => void }) {
  const { t } = useI18n();
  const { busy, run } = useAction();
  const running = app.status === 'online';
  return (
    <div className="card pad">
      <h3>{t('appDetail.run')}</h3>
      <div className="row">
        <button className="btn sm" disabled={busy || app.status === 'building' || !app.version}
          onClick={() => run(() => api.post(`/apps/${app.slug}/running`, { running: !running }), running ? t('appDetail.stoppedToast') : t('appDetail.startedToast')).then(reload)} type="button">
          {running ? <><Icon name="x" /> {t('appDetail.stop')}</> : t('appDetail.start')}
        </button>
        <span className="small muted">{running ? t('appDetail.runningHint') : t('appDetail.stoppedHint')}</span>
      </div>
      {app.envKeys && app.envKeys.length > 0 && (
        <p className="small muted" style={{ marginBottom: 0 }}>{t('appDetail.env', { keys: app.envKeys.join(t('common.listSeparator')) })}</p>
      )}
    </div>
  );
}

function DeleteCard({ app }: { app: AppInfo }) {
  const { t } = useI18n();
  const [confirm, setConfirm] = useState('');
  const { busy, run } = useAction();
  const nav = useNavigate();
  return (
    <div className="card pad">
      <h3>{t('appDetail.unpublish')}</h3>
      <p className="small muted" style={{ marginTop: -6 }}>{t('appDetail.unpublishHint')}</p>
      <div className="row">
        <input className="input" placeholder={t('common.confirmPlaceholder', { slug: app.slug })} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        <button className="btn danger" disabled={busy || confirm !== app.slug}
          onClick={() => run(() => api.del(`/apps/${app.slug}`, { confirm }), t('appDetail.unpublished')).then((ok) => ok && nav('/apps'))} type="button">{t('appDetail.unpublish')}</button>
      </div>
    </div>
  );
}

function Releases({ app, releases }: { app: AppInfo; releases: Release[] }) {
  const { t, ago } = useI18n();
  const [open, setOpen] = useState<number | null>(null);
  const [log, setLog] = useState('');
  const toggle = async (v: number) => {
    if (open === v) return setOpen(null);
    setOpen(v);
    setLog(t('common.loading'));
    setLog((await api.get<{ log: string }>(`/apps/${app.slug}/releases/${v}/log`)).log || t('appDetail.noLog'));
  };
  return (
    <div className="card pad">
      <h3>{t('appDetail.releases')}</h3>
      {releases.length === 0 && <p className="muted small">{t('appDetail.noReleases')}</p>}
      <div className="stack" style={{ gap: 0 }}>
        {releases.map((r) => (
          <div key={r.version} style={{ borderTop: '1px solid var(--line)', padding: '10px 0' }}>
            <button className="row" style={{ width: '100%', border: 0, background: 'none', cursor: 'pointer', padding: 0 }} onClick={() => toggle(r.version)} type="button">
              <Icon name={open === r.version ? 'x' : 'plus'} size={12} />
              <span className="grow" style={{ textAlign: 'left' }}>
                {t('appDetail.release', { version: r.version, who: r.created_by_name, ago: ago(r.created_at) })}
                <span className="muted"> · {t(`kind.${r.kind}` as MessageKey)}</span>
              </span>
              <StatusBadge status={r.status} />
            </button>
            {open === r.version && <pre className="log">{log}</pre>}
          </div>
        ))}
      </div>
    </div>
  );
}

/** For the owner: how many colleagues opened the app, per day over the last 30 days. */
function UsageCard({ usage }: { usage: Usage }) {
  const { t, fmtDate } = useI18n();
  const max = Math.max(1, ...usage.days.map((d) => d.people));
  return (
    <div className="card pad">
      <h3>{t('usage.title')}</h3>
      <p className="small muted" style={{ marginTop: 0 }}>{t('usage.summary', { n: usage.last30, total: usage.total })}</p>
      <div className="usage-bars" role="img" aria-label={t('usage.summary', { n: usage.last30, total: usage.total })}>
        {usage.days.map((d) => (
          <span key={d.day} title={`${fmtDate(new Date(d.day + 'T00:00:00Z').getTime())} · ${t('usage.people', { n: d.people })}`}
            style={{ height: `${Math.max(d.people ? 8 : 2, (d.people / max) * 100)}%` }} className={d.people ? '' : 'is-zero'} />
        ))}
      </div>
    </div>
  );
}

export function AppDetailPage() {
  const { t } = useI18n();
  const { slug } = useParams();
  const { data, error, reload } = useApi<{ app: AppInfo; releases: Release[]; lark: LarkAccess | null; larkConsentUrl: string; feedback: Feedback[]; usage: Usage | null }>(`/apps/${slug}`);
  // poll while a deployment is running
  useEffect(() => {
    if (data?.app.status !== 'building') return;
    const timer = setInterval(reload, 3000);
    return () => clearInterval(timer);
  }, [data?.app.status]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return <Loading error={error} />;
  const { app, releases } = data;
  return (
    <>
      <Link to="/apps" className="row small muted" style={{ marginBottom: 12 }}><Icon name="back" size={12} /> {t('nav.apps')}</Link>
      <div className="page-head">
        <div className="row" style={{ gap: 14 }}>
          <AppIcon src={app.icon} name={app.name} size="lg" />
          <div>
            <h1>{app.name}</h1>
            <div className="row small" style={{ marginTop: 4, flexWrap: 'wrap' }}>
              <span className="mono">{app.host}</span>
              <StatusBadge status={app.status} />
              <span className="badge">{t(`kind.${app.kind}` as MessageKey)}</span>
              <span className="row muted"><Avatar person={app.owner} /> {app.owner?.name}</span>
              {app.collaborators.length > 0 && <span className="muted">{t('collab.with', { names: app.collaborators.map((p) => p.name).join(t('common.listSeparator')) })}</span>}
            </div>
          </div>
        </div>
        <div className="row">
          {app.relatedSkill && <Link to={`/skills/${app.relatedSkill.slug}`} className="btn"><Icon name="skill" /> {t('link.skillBadge')} · {app.relatedSkill.name}</Link>}
          {app.canOpen && <a className="btn primary" href={app.url} target="_blank" rel="noreferrer">{t('appDetail.open')} <Icon name="external" /></a>}
        </div>
      </div>
      {!app.canManage ? (
        <div className="stack">
          <div className="card pad"><p style={{ margin: 0 }}>{app.description || t('common.noDescription')}</p></div>
          {data.lark && <LarkCard lark={data.lark} consentUrl={data.larkConsentUrl} slug={app.slug} reload={reload} />}
          <FeedbackCard kind="app" slug={app.slug} canSend={app.canOpen} canManage={app.canManage} button={app.feedbackButton} items={data.feedback} reload={reload} />
        </div>
      ) : (
        <div className="two-col">
          <div className="stack">
            <AccessCard app={app} reload={reload} />
            <FeedbackCard kind="app" slug={app.slug} canSend={app.canOpen} canManage={app.canManage} button={app.feedbackButton} items={data.feedback} reload={reload} />
            {data.usage && <UsageCard usage={data.usage} />}
            <Releases app={app} releases={releases} />
          </div>
          <div className="stack">
            <RunCard app={app} reload={reload} />
            <InfoCard app={app} reload={reload} />
            <IconCard app={app} reload={reload} />
            {data.lark && <LarkCard lark={data.lark} consentUrl={data.larkConsentUrl} slug={app.slug} reload={reload} />}
            <CollaboratorsCard kind="app" slug={app.slug} owner={app.owner} collaborators={app.collaborators} canAdminister={app.canAdminister} reload={reload} />
            <SkillLinkCard app={app} reload={reload} />
            {app.canAdminister && <DeleteCard app={app} />}
          </div>
        </div>
      )}
    </>
  );
}
