import { defineServicePlugin } from '../types';
import { registerRssCommands } from './commands';

const rss = defineServicePlugin()({
  apiVersion: 1,
  id: 'rss',
  displayName: 'RSS',
  description: 'Use when reading RSS feeds via the agentio CLI.',
  registerCommands: registerRssCommands,
});

export default rss;
export { RssClient } from './client';
export { registerRssCommands } from './commands';
export * from './output';
export type * from './types';
