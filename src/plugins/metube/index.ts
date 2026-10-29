import { defineServicePlugin } from '../types';
import { MetubeClient } from './client';
import { metubeProfileAdd, registerMetubeCommands } from './commands';
import type { MetubeCredentials } from './types';

export default defineServicePlugin<MetubeCredentials>()({
  apiVersion: 1,
  id: 'metube',
  displayName: 'MeTube',
  description: 'Use when downloading a video or its audio from YouTube, X, Instagram, TikTok or another yt-dlp site through a self-hosted MeTube server with the agentio CLI.',
  brand: { url: 'https://github.com/alexta69/metube' },
  registerCommands: registerMetubeCommands,
  profile: {
    setup: metubeProfileAdd,
    createClient: (credentials) => new MetubeClient(credentials),
    describe: (credentials) => ({ account: credentials.username, url: credentials.url }),
  },
});
