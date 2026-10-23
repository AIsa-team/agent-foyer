import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useI18n } from '../i18n';
import { CopyBox, Dialog, Empty, Loading, useApi, useMe } from '../ui';
import { RenderModule, type HomeData, type Module } from './Home';

type Named = { id: string; name: string };
interface Board {
  id: string; title: string; scope: 'me' | 'department' | 'company'; department: Named | null; layout: { modules: Module[] }; canEdit: boolean; updatedAt: number;
  owner?: Named; mine?: boolean; share?: { company: boolean; people: Named[]; departments: Named[] };
}

/** The 数据 page: boards for the company and the viewer's departments, their own boards and colleagues' shared with them, picked with tabs. */
export function DataPage() {
  const me = useMe();
  const { t, ago } = useI18n();
  const [params, setParams] = useSearchParams();
  const [making, setMaking] = useState(false);
  const { data, error } = useApi<{ boards: Board[]; canEditCompany: boolean; editableDepartments: { id: string; name: string }[] }>('/boards');
  // apps / Skills / resources modules need the same context as the home page
  const home = useApi<HomeData>('/home');
  if (!data || !home.data) return <Loading error={error ?? home.error} />;
  const team = data.boards.filter((b) => b.scope !== 'me');
  const own = data.boards.filter((b) => b.scope === 'me');
  const board = data.boards.find((b) => b.id === params.get('board')) ?? team[0] ?? own[0];
  const hub = t('prompt.hub', { company: me.hub.companyName, mcp: me.hub.mcpName });
  const canBuild = data.canEditCompany || data.editableDepartments.length > 0;
  const tab = (b: Board) => (
    <button key={b.id} className={b.id === board?.id ? 'on' : ''} onClick={() => setParams({ board: b.id })} type="button">
      {b.title}
      {b.department && <span className="muted"> · {b.department.name}</span>}
      {b.scope === 'me' && !b.mine && b.owner && <span className="muted"> · {b.owner.name}</span>}
    </button>
  );
  const sharedText = (s: NonNullable<Board['share']>) => {
    if (s.company) return t('data.sharedTo', { who: t('data.everyone') });
    const who = [...s.people, ...s.departments].map((x) => x.name);
    return who.length ? t('data.sharedTo', { who: who.join(t('common.listSeparator')) }) : t('data.private');
  };
  const scopeText = (b: Board) => b.scope === 'me'
    ? (b.mine ? sharedText(b.share ?? { company: false, people: [], departments: [] }) : t('data.fromOwner', { name: b.owner?.name ?? '' }))
    : b.department ? t('data.forDept', { dept: b.department.name }) : t('data.forCompany');
  return (
    <>
      <div className="page-head">
        <div><h1>{t('data.title')}</h1><p>{t('data.intro')}</p></div>
        <button className="btn" type="button" onClick={() => setMaking(true)}>{t('data.newMine')}</button>
      </div>
      {!board ? (
        <div className="card pad">
          <Empty title={t('data.none')} hint={t('data.noneMine')} />
          <CopyBox text={t('prompt.myBoard', { hub })} />
          {canBuild && (
            <>
              <p className="small muted" style={{ margin: '14px 0 6px' }}>{t('data.noneHint')}</p>
              <CopyBox text={t('prompt.board', { hub, scope: data.canEditCompany ? t('data.scopeCompany') : t('data.scopeDept', { dept: data.editableDepartments[0].name }) })} />
            </>
          )}
        </div>
      ) : (
        <>
          {data.boards.length > 1 && (
            <div className="data-tabs-row">
              {team.length > 0 && <div className="seg data-tabs">{team.map(tab)}</div>}
              {own.length > 0 && (
                <div className="seg data-tabs">
                  <span className="data-tabs__label">{t('data.mine')}</span>
                  {own.map(tab)}
                </div>
              )}
            </div>
          )}
          <div className="home-grid">
            {board.layout.modules.map((m, i) => (
              <div key={`${board.id}-${i}`} className={`home-cell home-cell--${m.width ?? 'full'}`}><RenderModule m={m} data={home.data!} /></div>
            ))}
          </div>
          <div className="home-foot">
            <span className="small muted">{scopeText(board)} · {t('data.updated', { ago: ago(board.updatedAt) })}</span>
            {board.canEdit && <span className="small muted">{t(board.scope === 'me' ? 'data.editMine' : 'data.editHint')}</span>}
          </div>
        </>
      )}
      {making && (
        <Dialog title={t('data.newMine')} subtitle={t('data.newMineSub')} onClose={() => setMaking(false)}>
          <p className="small muted" style={{ marginTop: 0 }}>{t('data.newMineIntro')}</p>
          <CopyBox text={t('prompt.myBoard', { hub })} />
        </Dialog>
      )}
    </>
  );
}
