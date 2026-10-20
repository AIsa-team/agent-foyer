import { config } from './config.ts';
import { larkMessenger } from './lark/messenger.ts';

/**
 * Sends the hub's messages (alerts, app notifications) through the company's chat tool. Only Lark so far; another
 * tool plugs in here. Without one, alerts still show on people's home pages and nothing is sent.
 */
export interface Messenger {
  toPerson(userId: string, text: string): Promise<void>;
  toGroup(groupId: string, text: string): Promise<void>;
}

export const messenger: Messenger | null = config.lark.enabled ? larkMessenger : null;
