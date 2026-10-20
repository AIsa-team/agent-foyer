import type { MessageKey } from './zh-CN';
import zhCN from './zh-CN';
import en from './en';

export type Messages = Partial<Record<MessageKey, string>>;

/**
 * Available UI languages. To add one: create locales/<code>.ts exporting a Messages object
 * (any keys it leaves out fall back to English, then Simplified Chinese) and list it here.
 * `code` is a BCP 47 tag; it is also used for date formatting and sent to the server.
 */
export const LOCALES: { code: string; name: string; messages: Messages }[] = [
  { code: 'zh-CN', name: '简体中文', messages: zhCN },
  { code: 'en', name: 'English', messages: en },
];

export const FALLBACK_CHAIN = ['en', 'zh-CN'];
export type { MessageKey };
