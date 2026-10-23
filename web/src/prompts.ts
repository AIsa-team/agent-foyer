/** The sentences people copy into their agent, built from the locale catalogue so they follow the UI language. */
import type { Me } from './api';
import type { T } from './i18n';


const hub = (me: Me, t: T) => t('prompt.hub', { company: me.hub.companyName, mcp: me.hub.mcpName });

export const connectPrompt = (me: Me, t: T) => t('prompt.connect', { company: me.hub.companyName, mcp: me.hub.mcpName, url: me.hub.mcpUrl, login: me.hub.login });
export const publishPrompt = (me: Me, t: T) => t('prompt.publish', { hub: hub(me, t) });
export const skillWritePrompt = (t: T) => t('prompt.skillWrite');
export const skillSharePrompt = (me: Me, t: T) => t('prompt.skillShare', { hub: hub(me, t) });
export const skillInstallPrompt = (me: Me, t: T, slug: string) => t('prompt.skillInstall', { hub: hub(me, t), slug });
export const skillReadPrompt = (me: Me, t: T, slug: string) => t('prompt.skillRead', { hub: hub(me, t), slug });
export const skillUpdatePrompt = (me: Me, t: T) => t('prompt.skillUpdate', { hub: hub(me, t) });
export const iconPrompt = (me: Me, t: T, slug: string) => t('prompt.icon', { hub: hub(me, t), slug });
export const feedbackPrompt = (me: Me, t: T, kind: 'app' | 'skill', slug: string) => t(`prompt.feedback.${kind}`, { hub: hub(me, t), slug });
export const agentUsePrompt = (me: Me, t: T, name: string) => t('prompt.agentUse', { hub: hub(me, t), name });
export const agentAddPrompt = (me: Me, t: T, slug: string) => t('prompt.agentAdd', { hub: hub(me, t), slug });
export const requestAskPrompt = (me: Me, t: T) => t('prompt.requestAsk', { hub: hub(me, t) });
export const requestBuildPrompt = (me: Me, t: T, id: number, title: string) => t('prompt.requestBuild', { hub: hub(me, t), id, title });
