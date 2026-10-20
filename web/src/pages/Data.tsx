import { useSearchParams } from 'react-router';
import { useI18n } from '../i18n';
import { CopyBox, Empty, Loading, useApi, useMe } from '../ui';
import { RenderModule, type HomeData, type Module } from './Home';

interface Board { id: string; title: string; department: { id: string; name: string } | null; layout: { modules: Module[] }; canEdit: boolean; updatedAt: number }

/** The 数据 page: shared boards for the company and the viewer's departments, picked with tabs. */
export function DataPage() {
  const me = useMe();
  const { t, ago } = useI18n();
  const [params, setParams] = useSearchParams();
  const { data, error } = useApi<{ boards: Board[]; canEditCompany: boolean; editableDepartments: { id: string; name: string }[] }>('/boards');
  // apps / Skills / resources modules need the same context as the home page
  const home = useApi<HomeData>('/home');
  if (!data || !home.data) return <Loading error={error ?? home.error} />;
  const board = data.boards.find((b) => b.id === params.get('board')) ?? data.boards[0];
  const hub = t('prompt.hub', { company: me.hub.companyName, mcp: me.hub.mcpName });
  const canBuild = data.canEditCompany || data.editableDepartments.length > 0;
  return (
    <>
      <div className="page-head"><div><h1>{t('data.title')}</h1><p>{t('data.intro')}</p></div></div>
      {!board ? (
        <div className="card pad">
          <Empty title={t('data.none')} hint={canBuild ? t('data.noneHint') : t('data.noneAsk')} />
          {canBuild && <CopyBox text={t('prompt.board', { hub, scope: data.canEditCompany ? t('data.scopeCompany') : t('data.scopeDept', { dept: data.editableDepartments[0].name }) })} />}
        </div>
      ) : (
        <>
          {data.boards.length > 1 && (
            <div className="seg data-tabs">
              {data.boards.map((b) => (
                <button key={b.id} className={b.id === board.id ? 'on' : ''} onClick={() => setParams({ board: b.id })} type="button">
                  {b.title}{b.department && <span className="muted"> · {b.department.name}</span>}
                </button>
              ))}
            </div>
          )}
          <div className="home-grid">
            {board.layout.modules.map((m, i) => (
              <div key={`${board.id}-${i}`} className={`home-cell home-cell--${m.width ?? 'full'}`}><RenderModule m={m} data={home.data!} /></div>
            ))}
          </div>
          <div className="home-foot">
            <span className="small muted">{board.department ? t('data.forDept', { dept: board.department.name }) : t('data.forCompany')} · {t('data.updated', { ago: ago(board.updatedAt) })}</span>
            {board.canEdit && <span className="small muted">{t('data.editHint')}</span>}
          </div>
        </>
      )}
    </>
  );
}
