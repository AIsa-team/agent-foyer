import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, type AppInfo, type LocalizedMap, type SkillInfo } from '../api';
import { useI18n } from '../i18n';
import { skillInstallPrompt } from '../prompts';
import { SkillIcon } from './Skills';
import { Avatar, CopyBox, Icon, IconEditor, LinkEditor, LocalizedFields, Loading, sameLocalized, useAction, useApi, useMe } from '../ui';

interface Version { version: number; size: number; notes: string; created_at: number }

function ManageCard({ skill, reload }: { skill: SkillInfo; reload: () => void }) {
  const { t } = useI18n();
  const [localized, setLocalized] = useState<LocalizedMap>(skill.localized ?? {});
  const [confirm, setConfirm] = useState('');
  const { busy, run } = useAction();
  const nav = useNavigate();
  useEffect(() => setLocalized(skill.localized ?? {}), [skill.localized]);
  return (
    <div className="card pad">
      <h3>{t('skill.manage')}</h3>
      <LocalizedFields value={localized} onChange={setLocalized} fallback={skill} multilineDescription />
      <div className="row" style={{ justifyContent: 'space-between', marginTop: 14 }}>
        <button className="btn sm" disabled={busy} type="button"
          onClick={() => run(() => api.patch(`/skills/${skill.slug}`, { listed: !skill.listed }), skill.listed ? t('skill.hiddenToast') : t('skill.relistedToast')).then(reload)}>
          {skill.listed ? t('skill.hide') : t('skill.unhide')}
        </button>
        <button className="btn" disabled={busy || sameLocalized(localized, skill.localized)}
          onClick={() => run(() => api.patch(`/skills/${skill.slug}`, { localized }), t('common.saved')).then(reload)} type="button">{t('common.save')}</button>
      </div>
      <hr style={{ border: 0, borderTop: '1px solid var(--line)', margin: '16px 0' }} />
      <span className="label">{t('skill.deleteLabel')}</span>
      <div className="row">
        <input className="input" placeholder={t('common.confirmPlaceholder', { slug: skill.slug })} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        <button className="btn danger" disabled={busy || confirm !== skill.slug}
          onClick={() => run(() => api.del(`/skills/${skill.slug}`), t('common.deleted')).then((ok) => ok && nav('/skills'))} type="button">{t('common.delete')}</button>
      </div>
    </div>
  );
}

function AppLinkCard({ skill, reload }: { skill: SkillInfo; reload: () => void }) {
  const { t } = useI18n();
  const { data } = useApi<{ apps: AppInfo[] }>('/apps');
  return (
    <LinkEditor title={t('link.appTitle')} hint={t('link.appHint')} current={skill.relatedApp?.slug ?? null}
      options={(data?.apps ?? []).filter((a) => a.canManage).map((a) => ({ value: a.slug, label: `${a.name} · ${a.host}` }))}
      endpoint={`/skills/${skill.slug}`} field="relatedApp" onSaved={reload} />
  );
}

export function SkillDetailPage() {
  const me = useMe();
  const { t, ago } = useI18n();
  const { slug } = useParams();
  const { data, error, reload } = useApi<{ skill: SkillInfo; versions: Version[]; readme: string }>(`/skills/${slug}`);
  if (!data) return <Loading error={error} />;
  const { skill, versions, readme } = data;
  return (
    <>
      <Link to="/skills" className="row small muted" style={{ marginBottom: 12 }}><Icon name="back" size={12} /> {t('nav.skills')}</Link>
      <div className="page-head">
        <div className="row" style={{ gap: 14, alignItems: 'flex-start' }}>
          <SkillIcon skill={skill} size="lg" />
          <div>
          <h1>{skill.name}</h1>
          <div className="row small" style={{ marginTop: 6, flexWrap: 'wrap' }}>
            <span className="mono">{skill.slug}</span>
            <span className="badge">v{skill.version}</span>
            {skill.myVersion !== null && (
              <span className={`badge ${skill.hasUpdate ? 'warn' : 'ok'}`}>{skill.hasUpdate ? t('skill.youHave', { version: skill.myVersion }) : t('skill.upToDate')}</span>
            )}
            <span className="row muted"><Avatar person={skill.owner} /> {skill.owner.name}</span>
            <span className="muted">{t('skills.installs', { n: skill.installs })}</span>
          </div>
          {skill.description && <p>{skill.description}</p>}
          </div>
        </div>
        {skill.relatedApp?.canOpen && <a className="btn" href={skill.relatedApp.url} target="_blank" rel="noreferrer">{t('link.viewOnline')} · {skill.relatedApp.name} <Icon name="external" /></a>}
      </div>
      <div className="two-col">
        <div className="stack">
          <div className="card pad">
            <h3>{skill.myVersion === null ? t('skill.install') : skill.hasUpdate ? t('skill.update') : t('skill.reinstall')}</h3>
            <p className="small muted" style={{ marginTop: -6 }}>{t('skill.sendThis')}</p>
            <CopyBox text={skillInstallPrompt(me, t, skill.slug)} />
          </div>
          <div className="card pad">
            <h3>SKILL.md</h3>
            <pre className="markdown">{readme || t('skill.empty')}</pre>
          </div>
        </div>
        <div className="stack">
          <div className="card pad">
            <h3>{t('skill.versions')}</h3>
            <div className="stack" style={{ gap: 0 }}>
              {versions.map((v) => (
                <div key={v.version} className="row" style={{ borderTop: '1px solid var(--line)', padding: '8px 0', alignItems: 'baseline' }}>
                  <span className="badge">v{v.version}</span>
                  <span className="grow small">{v.notes || <span className="muted">{t('skill.noNotes')}</span>}</span>
                  <span className="small muted">{ago(v.created_at)}</span>
                </div>
              ))}
            </div>
          </div>
          {skill.canManage && (
            <>
              <IconEditor src={skill.icon} name={skill.name} endpoint={`/skills/${skill.slug}`} prompt={t('prompt.skillIcon', { hub: t('prompt.hub', { company: me.hub.companyName, mcp: me.hub.mcpName }), slug: skill.slug })} onSaved={reload} fallback={<SkillIcon skill={skill} size="lg" />} />
              <AppLinkCard skill={skill} reload={reload} />
              <ManageCard skill={skill} reload={reload} />
            </>
          )}
        </div>
      </div>
    </>
  );
}
