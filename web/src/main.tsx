import { lazy, StrictMode, Suspense, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, NavLink, Route, Routes } from 'react-router';
import { api, type Me } from './api';
import { I18nProvider, LocaleSelect, useI18n } from './i18n';
import { Avatar, Icon, LinkIcon, Loading, MeProvider, ToastHost, useMe } from './ui';
import { HomePage } from './pages/Home';
import { AppsPage } from './pages/Apps';
import { SkillsPage } from './pages/Skills';
import { IssuesPage } from './pages/Issues';
import { SearchBox } from './Search';
import './styles.css';

// pages other than home load when first opened, so the first visit downloads less
const AppDetailPage = lazy(() => import('./pages/AppDetail').then((m) => ({ default: m.AppDetailPage })));
const SkillDetailPage = lazy(() => import('./pages/SkillDetail').then((m) => ({ default: m.SkillDetailPage })));
const MePage = lazy(() => import('./pages/MePage').then((m) => ({ default: m.MePage })));
const AdminPage = lazy(() => import('./pages/Admin').then((m) => ({ default: m.AdminPage })));
const LibraryPage = lazy(() => import('./pages/Library').then((m) => ({ default: m.LibraryPage })));
const DataPage = lazy(() => import('./pages/Data').then((m) => ({ default: m.DataPage })));
const DataSourcePage = lazy(() => import('./pages/DataSource').then((m) => ({ default: m.DataSourcePage })));
const OrgPage = lazy(() => import('./pages/Org').then((m) => ({ default: m.OrgPage })));
const OkrPage = lazy(() => import('./pages/Okr').then((m) => ({ default: m.OkrPage })));

/** The company's brand colour (HUB_ACCENT) over the default theme, with its hover, pressed and soft shades. */
function applyAccent(accent: string | null) {
  if (!accent) return;
  const root = document.documentElement.style;
  root.setProperty('--aisa-accent', accent);
  root.setProperty('--aisa-accent-hover', `color-mix(in oklab, ${accent} 88%, white)`);
  root.setProperty('--aisa-accent-pressed', `color-mix(in oklab, ${accent} 85%, black)`);
  root.setProperty('--aisa-accent-soft', `color-mix(in oklab, ${accent} 12%, var(--aisa-surface))`);
  root.setProperty('--aisa-accent-text', `color-mix(in oklab, ${accent} 75%, var(--aisa-text))`);
  root.setProperty('--aisa-chart-emph', accent);
}

function Shell() {
  const me = useMe();
  const { t } = useI18n();
  useEffect(() => {
    document.title = t('nav.hubName', { company: me.hub.companyName });
  }, [t, me.hub.companyName]);
  const nav = [
    { to: '/', label: t('nav.home'), icon: 'home' as const, end: true },
    ...(me.hub.features.lark ? [{ to: '/okr', label: 'OKR', icon: 'target' as const }] : []),
    { to: '/library', label: t('nav.library'), icon: 'library' as const },
    { to: '/data', label: t('nav.data'), icon: 'chart' as const },
    { to: '/issues', label: t('nav.issues'), icon: 'issues' as const },
    { to: '/org', label: t('nav.org'), icon: 'org' as const },
    { to: '/apps', label: t('nav.apps'), icon: 'apps' as const },
    { to: '/skills', label: t('nav.skills'), icon: 'skill' as const },
    { to: '/me', label: t('nav.me'), icon: 'user' as const },
    ...(me.user.role === 'admin' ? [{ to: '/admin', label: t('nav.admin'), icon: 'settings' as const }] : []),
  ];
  const logout = async () => {
    await fetch('/auth/logout', { method: 'POST' });
    location.href = '/auth/login';
  };
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><img src="/brand/logo.svg" alt="" />{t('nav.hubName', { company: me.hub.companyName })}</div>
        <SearchBox pages={nav.map((n) => ({ to: n.to, label: n.label, icon: n.icon }))} />
        <nav className="nav">
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end}><Icon name={n.icon} />{n.label}</NavLink>
          ))}
          {me.sidebarLinks.length > 0 && <div className="nav-sep" />}
          {me.sidebarLinks.map((l) => (
            <a key={l.id} href={l.url} target="_blank" rel="noreferrer" className="nav-ext">
              {l.icon && !/^(https?:\/\/|\/[^/])/.test(l.icon) ? <span className="nav-ext__emoji">{l.icon}</span> : <LinkIcon icon={l.icon} size={16} />}
              <span className="grow ellipsis">{l.name}</span><Icon name="external" size={12} />
            </a>
          ))}
        </nav>
        <div className="sidebar-foot">
          <LocaleSelect />
          <div className="me">
            <Avatar person={me.user} size="md" />
            <div className="grow">
              <div className="ellipsis">{me.user.name}</div>
              <small>{me.user.role === 'admin' ? t('nav.roleAdmin') : t('nav.roleMember')}</small>
            </div>
            <button className="btn sm ghost" onClick={logout} title={t('nav.logout')} aria-label={t('nav.logout')} type="button"><Icon name="logout" /></button>
          </div>
        </div>
      </aside>
      <nav className="topbar">
        <img src="/brand/logo.svg" alt="" width={22} />
        {nav.map((n) => <NavLink key={n.to} to={n.to} end={n.end}>{n.label}</NavLink>)}
        <span className="grow" />
        <LocaleSelect />
      </nav>
      <main className="main">
        <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/library" element={<LibraryPage />} />
          <Route path="/issues" element={<IssuesPage />} />
          <Route path="/data" element={<DataPage />} />
          <Route path="/data/source/:id" element={<DataSourcePage />} />
          <Route path="/org" element={<OrgPage />} />
          {me.hub.features.lark && <Route path="/okr" element={<OkrPage />} />}
          <Route path="/apps" element={<AppsPage />} />
          <Route path="/apps/:slug" element={<AppDetailPage />} />
          <Route path="/skills" element={<SkillsPage />} />
          <Route path="/skills/:slug" element={<SkillDetailPage />} />
          <Route path="/me" element={<MePage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="*" element={<div className="empty"><b>{t('common.pageNotFound')}</b></div>} />
        </Routes>
        </Suspense>
      </main>
    </div>
  );
}

/** Tells the server the chosen language, so MCP replies and server pages follow it. */
const saveLocale = (locale: string) => void api.post('/me/locale', { locale }).catch(() => {});

function Root() {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.get<Me>('/me').then((m) => {
      applyAccent(m.hub.accent);
      setMe(m);
    }, (e: Error) => setError(e.message));
  }, []);
  return (
    <I18nProvider onChange={saveLocale}>
      {!me ? <Loading error={error} /> : (
        <MeProvider value={me}>
          <LocaleSync serverLocale={me.user.locale} />
          <ToastHost>
            <BrowserRouter>
              <Shell />
            </BrowserRouter>
          </ToastHost>
        </MeProvider>
      )}
    </I18nProvider>
  );
}

/** First visit on a new device: record the detected language for this user if the server has none or a different one. */
function LocaleSync({ serverLocale }: { serverLocale: string | null }) {
  const { locale } = useI18n();
  useEffect(() => {
    if (serverLocale !== locale) saveLocale(locale);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

createRoot(document.getElementById('root')!).render(<StrictMode><Root /></StrictMode>);
