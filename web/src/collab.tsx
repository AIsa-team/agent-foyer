/** Who looks after an app or Skill: the owner and collaborators. The owner (or an admin) adds, removes and hands over; anyone can leave. */
import { useState } from 'react';
import { api, type Person } from './api';
import { useI18n } from './i18n';
import { Avatar, PersonPicker, useAction, useMe } from './ui';

export function CollaboratorsCard({ kind, slug, owner, collaborators, canAdminister, reload }: {
  kind: 'app' | 'skill'; slug: string; owner: Person | null; collaborators: Person[]; canAdminister: boolean; reload: () => void;
}) {
  const { t } = useI18n();
  const me = useMe();
  const { busy, run } = useAction();
  const [adding, setAdding] = useState<Person[]>([]);
  const base = `/${kind}s/${slug}`;
  const change = (body: { add?: string[]; remove?: string[] }, done: string) => run(() => api.post(`${base}/collaborators`, body), done).then((ok) => {
    if (!ok) return;
    setAdding([]);
    reload();
  });
  const handOver = (p: Person) => {
    if (!confirm(t('collab.handOverConfirm', { name: p.name }))) return;
    run(() => api.post(`${base}/transfer`, { userId: p.id }), t('collab.handedOver')).then(reload);
  };
  const taken = new Set([owner?.id, ...collaborators.map((c) => c.id)]);
  return (
    <div className="card pad">
      <h3>{t('collab.title')}</h3>
      <p className="small muted" style={{ marginTop: -6 }}>{t('collab.hint')}</p>
      <div className="stack" style={{ gap: 0 }}>
        {owner && (
          <div className="row collab-row">
            <Avatar person={owner} /> <span className="grow">{owner.name}</span> <span className="badge dark">{t('collab.owner')}</span>
          </div>
        )}
        {collaborators.map((p) => (
          <div key={p.id} className="row collab-row">
            <Avatar person={p} /> <span className="grow">{p.name}</span>
            {canAdminister && <button className="btn sm ghost" disabled={busy} onClick={() => handOver(p)} type="button">{t('collab.makeOwner')}</button>}
            {canAdminister && <button className="btn sm ghost danger" disabled={busy} onClick={() => change({ remove: [p.id] }, t('collab.removed'))} type="button">{t('common.remove')}</button>}
            {!canAdminister && p.id === me.user.id && (
              <button className="btn sm ghost danger" disabled={busy} type="button"
                onClick={() => confirm(t('collab.leaveConfirm')) && change({ remove: [p.id] }, t('collab.left'))}>{t('collab.leave')}</button>
            )}
            {!canAdminister && p.id !== me.user.id && <span className="badge">{t('collab.collaborator')}</span>}
          </div>
        ))}
      </div>
      {canAdminister && (
        <div className="stack" style={{ gap: 8, marginTop: 12 }}>
          <PersonPicker value={adding} onChange={setAdding} exclude={[...taken]} />
          {adding.length > 0 && (
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn sm primary" disabled={busy} onClick={() => change({ add: adding.map((p) => p.id) }, t('collab.added'))} type="button">{t('collab.add', { n: adding.length })}</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
