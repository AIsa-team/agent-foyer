/**
 * The long connection to Lark: the hub keeps a connection open to Lark, and Lark sends taps on the hub bot's cards
 * through it, so the hub needs no public callback address. Lark's developer console has to deliver the card callback
 * (card.action.trigger) "through a long connection" (docs/LARK_SETUP.md).
 */
import * as lark from '@larksuiteoapi/node-sdk';
import { config } from '../config.ts';
import { onCardTap, type CardTap } from './messages.ts';
import { onTwinCardTap } from './twin.ts';

export function startLarkEvents() {
  if (!config.lark.enabled || !config.lark.longConnection) return;
  const dispatcher = new lark.EventDispatcher({}).register({
    'card.action.trigger': async (tap: CardTap) => {
      try {
        return await ((tap.action?.value as { hub?: string } | undefined)?.hub === 'twin_doc' ? onTwinCardTap(tap) : onCardTap(tap));
      } catch (e) {
        console.warn('[lark events] card tap failed:', (e as Error).message);
        return { toast: { type: 'error', content: (e as Error).message } };
      }
    },
  });
  const ws = new lark.WSClient({
    appId: config.lark.appId, appSecret: config.lark.appSecret, domain: `https://open.${config.lark.domain}`, loggerLevel: lark.LoggerLevel.warn,
    onReady: () => console.log('[lark events] long connection open'),
  });
  void ws.start({ eventDispatcher: dispatcher });
}
