/**
 * The outside services the hub has its own code for, each one module (integration.ts says what a module brings). The
 * core walks this list; adding a service is adding its module and a line here.
 */
import type { Integration } from './integration.ts';
import { github } from './github/integration.ts';
import { google } from './google/integration.ts';
import { lark } from './lark/integration.ts';
import { linear } from './linear/integration.ts';

export const integrations: Integration[] = [lark, github, google, linear];

export const enabledIntegrations = () => integrations.filter((i) => i.enabled());

/** Whether a service is set up on this hub, for core features that use what it brings (e.g. the GitHub home module). */
export const integrationEnabled = (id: string) => !!integrations.find((i) => i.id === id)?.enabled();
