import { defineServicePlugin } from '../types';
import { HiggsfieldClient } from './client';
import { describeKey, higgsfieldProfileAdd, registerHiggsfieldCommands } from './commands';
import type { HiggsfieldCredentials } from './types';

export default defineServicePlugin<HiggsfieldCredentials>()({
  apiVersion: 1,
  id: 'higgsfield',
  displayName: 'Higgsfield',
  description: 'Use when generating images, videos or audio with a Higgsfield API model (Soul, Genjutsu, Kling and others) from the agentio CLI: upload inputs, submit, wait, save outputs.',
  brand: { url: 'https://higgsfield.ai' },
  registerCommands: registerHiggsfieldCommands,
  profile: {
    setup: higgsfieldProfileAdd,
    createClient: (credentials) => new HiggsfieldClient(credentials),
    describe: (credentials) => ({ account: `key ${describeKey(credentials)}` }),
  },
});
