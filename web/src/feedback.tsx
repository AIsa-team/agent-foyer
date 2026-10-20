/** What colleagues said about an app or a Skill. Everyone who can use it can add to it; the owner sees all of it and resolves items. */
import { useState } from 'react';
import { api, type Feedback } from './api';
import { useI18n, type MessageKey } from './i18n';
import { feedbackPrompt } from './prompts';
import { Avatar, CopyBox, useAction, useMe } from './ui';

export function FeedbackCard({ kind, slug, canSend, canManage, items, reload, button }: {
  kind: 'app' | 'skill'; slug: string; canSend: boolean; canManage: boolean; items: Feedback[]; reload: () => void;
  /** apps: whether the hub shows its 「feedback」 button inside the app (the owner can turn it off) */
  button?: boolean;
}) {
  const { t, ago } = useI18n();
  const me = useMe();
  const { busy, run } = useAction();
  const [text, setText] = useState('');
  const open = items.filter((f) => f.status === 'open').length;
  const base = kind === 'app' ? `/apps/${slug}` : `/skills/${slug}`;
  const send = () => run(() => api.post(`${base}/feedback`, { body: text }), t('feedback.sent')).then((ok) => ok && (setText(''), reload()));
  const resolve = (f: Feedback, status: Feedback['status']) => {
    const reply = status === 'open' ? undefined : prompt(t('feedback.replyPrompt'));
    if (reply === null) return;
    run(() => api.post(`/feedback/${f.id}`, { status, reply }), t('feedback.updated')).then(reload);
  };
  return (
    <div className="card pad" id="feedback">
      <h3>{t('feedback.title')} {canManage && open > 0 && <span className="count">{t('feedback.openCount', { n: open })}</span>}</h3>
      <p className="small muted" style={{ marginTop: 0 }}>{t(canManage ? `feedback.ownerHint.${kind}` : 'feedback.hint')}</p>
      {canManage && open > 0 && <div style={{ marginBottom: 12 }}><CopyBox text={feedbackPrompt(me, t, kind, slug)} /></div>}
      {canManage && button !== undefined && (
        <label className="row small" style={{ gap: 8, marginBottom: 12, alignItems: 'flex-start' }}>
          <input type="checkbox" checked={button} disabled={busy} style={{ marginTop: 2 }}
            onChange={(e) => run(() => api.patch(base, { feedbackButton: e.target.checked }), t('feedback.updated')).then(reload)} />
          <span><b style={{ fontWeight: 500 }}>{t('feedback.button')}</b><br /><span className="muted">{t('feedback.buttonHint')}</span></span>
        </label>
      )}
      {(canSend || canManage) && (
        <div className="stack" style={{ gap: 8, marginBottom: items.length ? 14 : 0 }}>
          <textarea className="input" rows={3} value={text} maxLength={2000} placeholder={t('feedback.placeholder')} onChange={(e) => setText(e.target.value)} />
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn sm primary" disabled={busy || text.trim().length < 2} onClick={send} type="button">{t('feedback.send')}</button>
          </div>
        </div>
      )}
      <div className="stack" style={{ gap: 0 }}>
        {items.map((f) => (
          <div key={f.id} className="feedback-item">
            <div className="row small">
              <Avatar person={f.author} /> <b>{f.author?.name}</b> <span className="muted">{ago(f.at)}</span>
              {f.via !== 'web' && <span className="muted">· {f.via === 'agent' ? t('feedback.via.agent', { agent: f.agent ?? 'Agent' }) : t('feedback.via.app')}</span>}
              <span className="spacer" />
              <span className={`badge ${f.status === 'open' ? 'warn' : f.status === 'done' ? 'ok' : ''}`}>{t(`feedback.status.${f.status}` as MessageKey)}</span>
            </div>
            <p className="feedback-body">{f.body}</p>
            {f.context && (
              <details className="feedback-context small">
                <summary className="muted">{t('feedback.context')}</summary>
                <pre>{f.context}</pre>
              </details>
            )}
            {f.reply && <p className="small muted feedback-reply">{t('feedback.reply', { name: f.resolvedBy?.name ?? '', text: f.reply })}</p>}
            {canManage && (
              <div className="row" style={{ gap: 6 }}>
                {f.status === 'open' ? (
                  <>
                    <button className="btn sm" disabled={busy} onClick={() => resolve(f, 'done')} type="button">{t('feedback.markDone')}</button>
                    <button className="btn sm ghost" disabled={busy} onClick={() => resolve(f, 'declined')} type="button">{t('feedback.markDeclined')}</button>
                  </>
                ) : <button className="btn sm ghost" disabled={busy} onClick={() => resolve(f, 'open')} type="button">{t('feedback.reopen')}</button>}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
