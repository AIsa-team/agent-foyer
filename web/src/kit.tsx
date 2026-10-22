/** The design system's overlays as React components: a modal dialog and a drawer from the right (aisa-ui.css). */
import { useEffect, useRef, type ReactNode } from 'react';
import { useI18n } from './i18n';
import { Icon } from './ui';

/**
 * A native <dialog> opened as a modal: Escape and a click on the backdrop close it. kind 'drawer' slides in from
 * the right, for looking at one thing while the page stays in view.
 */
export function KitDialog({ kind = 'dialog', title, subtitle, onClose, children, foot, wide }: {
  kind?: 'dialog' | 'drawer'; title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode; foot?: ReactNode; wide?: boolean;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const d = ref.current!;
    if (!d.open) d.showModal();
    const cancel = (e: Event) => { e.preventDefault(); close.current(); };
    d.addEventListener('cancel', cancel);
    return () => {
      d.removeEventListener('cancel', cancel);
      if (d.open) d.close();
    };
  }, []);
  return (
    <dialog ref={ref} className={`${kind === 'drawer' ? 'aisa-drawer' : 'aisa-dialog'}${wide ? ' kit-dialog--wide' : ''} kit-dialog`}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()} aria-modal>
      <div className="aisa-dialog__head">
        <div style={{ minWidth: 0 }}><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
        <button className="aisa-btn aisa-btn--ghost aisa-btn--icon aisa-btn--sm" type="button" onClick={onClose} aria-label={t('common.close')}><Icon name="x" size={14} /></button>
      </div>
      <div className="aisa-dialog__body">{children}</div>
      {foot && <div className="aisa-dialog__foot">{foot}</div>}
    </dialog>
  );
}
