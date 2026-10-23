/** Lark as a channel of the hub (see ../channels.ts): its contacts as the directory, its Base tables as data sources. */
import type { Channel } from '../channels.ts';
import { readDirectory } from './auth.ts';
import { larkBaseSource } from './baseSource.ts';

export const larkChannel: Channel = {
  name: 'lark',
  directory: { name: 'Lark', read: readDirectory },
  sources: [larkBaseSource],
};
