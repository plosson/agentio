import { defineServicePlugin } from '../types';
import { PAGERIO_URL, PagerioClient } from './client';
import { pagerioProfileAdd, registerPagerioCommands } from './commands';
import { PAGERIO_SETUP_NEEDS } from './setup-needs';
import type { PagerioCredentials } from './types';

export default defineServicePlugin<PagerioCredentials>()({
  apiVersion: 1,
  id: 'pagerio',
  displayName: 'Pocket Pager',
  description: 'Use when paging yourself (a push notification on your iPhone and Mac) via Pocket Pager with the agentio CLI.',
  // No profile.describe: the pager URL is itself the secret, so the admin shows only the brand link.
  brand: { url: PAGERIO_URL },
  registerCommands: registerPagerioCommands,
  profile: {
    needs: PAGERIO_SETUP_NEEDS,
    setup: pagerioProfileAdd,
    createClient: (credentials) => new PagerioClient(credentials),
  },
});
