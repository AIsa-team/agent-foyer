import { useState } from 'react';
import { Link } from 'react-router';
import type { Agent, SkillInfo } from '../api';
import { useI18n } from '../i18n';
import { skillSharePrompt, skillUpdatePrompt, skillWritePrompt } from '../prompts';
import { AgentStep, AppIcon, Avatar, CopyBox, CopyButton, Dialog, Icon, Loading, Step, useApi, useMe } from '../ui';

/** The Skill's own icon, or a neutral puzzle tile. */
export function SkillIcon({ skill, size = '' }: { skill: Pick<SkillInfo, 'icon' | 'name'>; size?: '' | 'sm' | 'lg' }) {
  if (skill.icon) return <AppIcon src={skill.icon} name={skill.name} size={size} />;
  return <span className={`app-icon ${size} skill-icon`}><Icon name="skill" size={size === 'lg' ? 22 : size === 'sm' ? 14 : 18} /></span>;
}

export function SkillCard({ skill }: { skill: SkillInfo }) {
  const { t, ago } = useI18n();
  return (
    <Link to={`/skills/${skill.slug}`} className="card app-card">
      <div className="head">
        <SkillIcon skill={skill} />
        <div className="grow">
          <div className="title ellipsis">{skill.name}</div>
          <span className="host mono">{skill.slug}</span>
        </div>
        {skill.hasUpdate ? <span className="badge warn">{t('skills.canUpdate')}</span> : <span className="badge">v{skill.version}</span>}
      </div>
      <div className="desc">{skill.description || <span className="muted">{t('common.noDescription')}</span>}</div>
      <div className="foot">
        <span className="row"><Avatar person={skill.owner} /> {skill.owner.name}</span>
        <span>{t('skills.installs', { n: skill.installs })} · {t('common.updatedAgo', { ago: ago(skill.updatedAt) })}{!skill.listed && ` · ${t('skills.hidden')}`}</span>
      </div>
    </Link>
  );
}

function ShareDialog({ onClose }: { onClose: () => void }) {
  const me = useMe();
  const { t } = useI18n();
  const profile = useApi<{ agents: Agent[] }>('/profile');
  return (
    <Dialog title={t('share.title')} subtitle={t('share.subtitle')} onClose={onClose}>
      <div className="steps">
        <AgentStep agents={profile.data?.agents ?? null} />
        <Step n={2} title={t('share.step2.title')}>
          <p>{t('share.step2.body')}</p>
          <CopyBox text={skillWritePrompt(t)} />
        </Step>
        <Step n={3} title={t('share.step3.title')}>
          <p>{t('share.step3.intro')}</p>
          <CopyBox text={skillSharePrompt(me, t)} />
          <p style={{ marginTop: 10 }}>{t('share.step3.after')}</p>
        </Step>
      </div>
    </Dialog>
  );
}

/** Banner shown when installed Skills have newer versions. */
export function SkillUpdatesBanner({ skills }: { skills: SkillInfo[] }) {
  const me = useMe();
  const { t } = useI18n();
  if (!skills.length) return null;
  const prompt = skillUpdatePrompt(me, t);
  return (
    <div className="banner">
      <span className="grow">{t('skills.updatesBanner', { names: skills.map((s) => s.name).join(t('common.listSeparator')), prompt })}</span>
      <CopyButton text={prompt} />
    </div>
  );
}

export function SkillsPage() {
  const { t } = useI18n();
  const { data, error } = useApi<{ skills: SkillInfo[] }>('/skills');
  const [sharing, setSharing] = useState(false);
  if (!data) return <Loading error={error} />;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('skills.title')}</h1>
          <p>{t('skills.intro')}</p>
        </div>
        <button className="btn" onClick={() => setSharing(true)} type="button">{t('skills.share')}</button>
      </div>
      <SkillUpdatesBanner skills={data.skills.filter((s) => s.hasUpdate)} />
      {data.skills.length ? (
        <div className="grid">{data.skills.map((s) => <SkillCard key={s.slug} skill={s} />)}</div>
      ) : (
        <div className="card"><div className="empty"><b>{t('skills.none')}</b><span className="small">{t('skills.noneHint')}</span></div></div>
      )}
      {sharing && <ShareDialog onClose={() => setSharing(false)} />}
    </>
  );
}
