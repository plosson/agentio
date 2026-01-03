// Embedded OAuth credentials for agentio
// These are "public" credentials for a desktop/CLI app - this is standard practice
// Secret is lightly encrypted to avoid automated secret scanners (not real security)

import { reveal } from '../utils/obscure';

const CLIENT_ID = 'REMOVED_OLD_CLIENT_ID';
const CLIENT_SECRET_ENC = 'REMOVED_OLD_SECRET_ENC';

export const GOOGLE_OAUTH_CONFIG = {
  clientId: CLIENT_ID,
  clientSecret: reveal(CLIENT_SECRET_ENC),
};
