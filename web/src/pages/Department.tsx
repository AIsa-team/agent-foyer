import { Link, useParams } from 'react-router';
import type { AppInfo, SkillInfo } from '../api';
import { useI18n } from '../i18n';
import { Avatar, CopyBox, Empty, Icon, Loading, useApi, useMe } from '../ui';
import { AppCard } from './Apps';
import { SkillCard } from './Skills';
import { moduleKindName } from './Home';

interface Person { id: string; name: string; enName: string | null; email: string | null; avatar: string | null; joined: boolean }
interface DeptPage {
  department: { id: string; name: string; parent: { id: string; name: string } | null; children: { id: string; name: string; members: number }[]; leaders: string[] };
  people: Person[];
  canEdit: boolean;
  home: { updatedAt: number; modules: { type: string; title: string | null }[] } | null;
  boards: { id: string; title: string; modules: number; updatedAt: number }[];
  apps: AppInfo[];
  skills: SkillInfo[];
}

/**
 * A department's page: where it sits, who is in it, the home page its members get, its boards, and what its members
 * made. Leaders (and admins) get the words to send their agent to set up the home page or a board.
 */
export function DepartmentPage() {
  const { id = '' } = useParams();
  const { t, ago } = useI18n();
  const me = useMe();
  const { data, error } = useApi<DeptPage>(`/org/departments/${encodeURIComponent(id)}`);
  if (!data) return <Loading error={error} />;
  const d = data.department;
  const hub = t('prompt.hub', { company: me.hub.companyName, mcp: me.hub.mcpName });
  const leaders = data.people.filter((p) => d.leaders.includes(p.id));
  return (
    <>
      <nav className="aisa-breadcrumb" aria-label={t('org.title')}>
        <Link to="/org">{t('org.title')}</Link>
        {d.parent && <Link to={`/org/${encodeURIComponent(d.parent.id)}`}>{d.parent.name}</Link>}
        <span aria-current="page">{d.name}</span>
      </nav>
      <div className="page-head">
        <div>
          <h1>{d.name}</h1>
          <p>{t('dept.intro', { n: data.people.length })}{leaders.length ? ` · ${t('dept.ledBy', { names: leaders.map((p) => p.name).join(t('common.listSeparator')) })}` : ''}</p>
        </div>
      </div>
      {!leaders.length && <p className="small muted dept-noleader"><Icon name="user" size={13} /> {t(me.hub.features.directory ? 'dept.noLeader' : 'dept.noLeaderHub')}</p>}
      {d.children.length > 0 && (
        <div className="dept-children">
          {d.children.map((c) => <Link key={c.id} to={`/org/${encodeURIComponent(c.id)}`} className="chip dept-chip">{c.name} <span className="muted">{c.members}</span></Link>)}
        </div>
      )}

      <div className="two-col dept-cols">
        <div className="stack">
          <div className="card pad">
            <h3>{t('dept.home')}</h3>
            {data.home ? (
              <>
                <p className="small muted" style={{ marginTop: -6 }}>{t('dept.homeSet', { n: data.home.modules.length, ago: ago(data.home.updatedAt) })}</p>
                <div className="dept-modules">
                  {data.home.modules.map((m, i) => <span key={i} className="chip dept-chip">{m.title || moduleKindName(t, m.type)}</span>)}
                </div>
              </>
            ) : <p className="small muted" style={{ margin: 0 }}>{t('dept.homeNone')}</p>}
            {data.canEdit && (
              <div className="dept-action">
                <p className="small muted">{t(data.home ? 'dept.homeChange' : 'dept.homeMake')}</p>
                <CopyBox text={t('prompt.homeDept', { hub, department: d.name })} />
              </div>
            )}
          </div>

          <div className="card pad">
            <h3>{t('dept.boards')} <span className="count">{data.boards.length}</span></h3>
            {data.boards.length === 0 ? <p className="small muted" style={{ margin: 0 }}>{t('dept.boardsNone')}</p> : (
              <div className="home-links">
                {data.boards.map((b) => (
                  <Link key={b.id} to={`/data?board=${encodeURIComponent(b.id)}`} className="home-link">
                    <span className="home-link__icon"><Icon name="chart" size={13} /></span>
                    <span className="grow ellipsis">{b.title}</span>
                    <span className="small muted">{t('common.updatedAgo', { ago: ago(b.updatedAt) })}</span>
                  </Link>
                ))}
              </div>
            )}
            {data.canEdit && (
              <div className="dept-action">
                <p className="small muted">{t('dept.boardMake')}</p>
                <CopyBox text={t('prompt.board', { hub, scope: t('data.scopeDept', { dept: d.name }) })} />
              </div>
            )}
          </div>
        </div>

        <div className="card pad dept-people">
          <h3>{t('dept.people')} <span className="count">{data.people.length}</span></h3>
          {data.people.length === 0 ? <Empty title={t('org.nobody')} /> : data.people.map((p) => (
            <Link key={p.id} to={`/org?person=${encodeURIComponent(p.id)}`} className="org-person">
              <Avatar person={p} size="md" />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row" style={{ gap: 6 }}>
                  <b>{p.name}</b>
                  {d.leaders.includes(p.id) && <span className="badge dark">{t('org.leader')}</span>}
                </div>
                <div className="small muted ellipsis">{p.email}</div>
              </div>
              {!p.joined && <span className="small muted">{t('org.notYet')}</span>}
            </Link>
          ))}
        </div>
      </div>

      {data.apps.length > 0 && (
        <div className="section">
          <div className="section-title">{t('dept.apps')} <span className="count">{t('common.count', { n: data.apps.length })}</span></div>
          <div className="grid">{data.apps.map((a) => <AppCard key={a.slug} app={a} />)}</div>
        </div>
      )}
      {data.skills.length > 0 && (
        <div className="section">
          <div className="section-title">{t('dept.skills')} <span className="count">{t('common.count', { n: data.skills.length })}</span></div>
          <div className="grid">{data.skills.map((s) => <SkillCard key={s.slug} skill={s} />)}</div>
        </div>
      )}
    </>
  );
}
