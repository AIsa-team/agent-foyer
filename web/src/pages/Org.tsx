import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useI18n } from '../i18n';
import { Avatar, Empty, Icon, Loading, useApi, useMe } from '../ui';

interface Dept { id: string; name: string; parent: string | null; leaders: string[]; members: string[] }
interface Person { id: string; name: string; enName: string | null; email: string | null; avatar: string | null; joined: boolean }

/** The 组织 page: the departments synced from Lark as a tree and the people in each (without Lark: everyone who signed in). */
export function OrgPage() {
  const { t } = useI18n();
  const me = useMe();
  const { data, error } = useApi<{ departments: Dept[]; people: Person[] }>('/org');
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const people = useMemo(() => new Map((data?.people ?? []).map((p) => [p.id, p])), [data]);
  if (!data) return <Loading error={error} />;
  const roots = data.departments.filter((d) => !d.parent);
  const children = (id: string) => data.departments.filter((d) => d.parent === id);
  const selected = data.departments.find((d) => d.id === params.get('dept'));
  const deptsOf = (pid: string) => data.departments.filter((d) => d.members.includes(pid)).map((d) => d.name);
  const focus = params.get('person');
  const needle = q.trim().toLowerCase();
  const list = needle
    ? data.people.filter((p) => [p.name, p.enName, p.email].some((x) => (x ?? '').toLowerCase().includes(needle)))
    : selected
      ? [...selected.leaders, ...selected.members.filter((m) => !selected.leaders.includes(m))].map((id) => people.get(id)).filter((p): p is Person => !!p)
      : focus ? data.people.filter((p) => p.id === focus) : data.people;

  const Tree = ({ d, depth }: { d: Dept; depth: number }) => {
    const kids = children(d.id);
    const isOpen = open.has(d.id) || depth === 0;
    return (
      <>
        <button className={`org-dept ${selected?.id === d.id ? 'on' : ''}`} style={{ paddingLeft: 10 + depth * 16 }} type="button"
          onClick={() => { setQ(''); setParams({ dept: d.id }); if (kids.length) setOpen(new Set(open.has(d.id) ? [...open].filter((x) => x !== d.id) : [...open, d.id])); }}>
          {kids.length ? <span className={`org-caret ${isOpen ? 'open' : ''}`}><Icon name="back" size={11} /></span> : <span className="org-caret" />}
          <span className="grow ellipsis">{d.name}</span>
          <span className="small muted">{d.members.length}</span>
        </button>
        {isOpen && kids.map((k) => <Tree key={k.id} d={k} depth={depth + 1} />)}
      </>
    );
  };

  return (
    <>
      <div className="page-head"><div><h1>{t('org.title')}</h1><p>{t('org.intro', { n: data.people.length, d: data.departments.length })}</p></div></div>
      {data.departments.length === 0 && data.people.length <= 1 ? (
        <div className="card"><Empty title={t('org.empty')} hint={t(me.hub.features.lark ? 'org.emptyHint' : 'org.emptyHint.signIn')} /></div>
      ) : (
        <div className="org">
          <div className="card org-tree">
            <button className={`org-dept ${!selected ? 'on' : ''}`} type="button" onClick={() => { setQ(''); setParams({}); }}>
              <span className="org-caret" /><span className="grow">{t('org.everyone')}</span><span className="small muted">{data.people.length}</span>
            </button>
            {roots.map((d) => <Tree key={d.id} d={d} depth={0} />)}
          </div>
          <div className="stack">
            <div className="search org-search"><Icon name="search" /><input className="input" placeholder={t('org.search')} value={q} onChange={(e) => setQ(e.target.value)} /></div>
            {selected && !needle && (
              <Link to={`/org/${encodeURIComponent(selected.id)}`} className="card org-deptlink">
                <span className="grow"><b>{selected.name}</b> <span className="small muted">{t('dept.intro', { n: selected.members.length })}</span></span>
                <span className="small">{t('org.deptPage')} →</span>
              </Link>
            )}
            <div className="card org-people">
              {list.length === 0 ? <Empty title={t('org.nobody')} /> : list.map((p) => (
                <div key={p.id} className={`org-person ${focus === p.id ? 'on' : ''}`}>
                  <Avatar person={p} size="md" />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="row" style={{ gap: 6 }}>
                      <b>{p.name}</b>{p.enName && p.enName !== p.name && <span className="small muted">{p.enName}</span>}
                      {selected?.leaders.includes(p.id) && <span className="badge dark">{t('org.leader')}</span>}
                    </div>
                    <div className="small muted ellipsis">{[p.email, ...deptsOf(p.id)].filter(Boolean).join(' · ')}</div>
                  </div>
                  {!p.joined && <span className="small muted">{t('org.notYet')}</span>}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
