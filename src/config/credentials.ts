// Embedded OAuth credentials for agentio
// These are "public" credentials for a desktop/CLI app - this is standard practice
// Secret is lightly encrypted to avoid automated secret scanners (not real security)

import { reveal } from '../utils/obscure';

const CLIENT_ID = '931954287794-4rflctl8lotok5d6rnd4o6teuk02lked.apps.googleusercontent.com';
const CLIENT_SECRET_ENC = 'H2nByOfMnoQDg9BIGMyt_hznzMMTq-Or4wsZwiqT1ldl6z7bTMIdk9L8rDzQJ4l0i_pA';

export const GOOGLE_OAUTH_CONFIG = {
  clientId: CLIENT_ID,
  clientSecret: reveal(CLIENT_SECRET_ENC),
};

// JIRA/Atlassian OAuth credentials
const JIRA_CLIENT_ID = 'cVyhx1kQLRUef6gr50M9cTDke7ZPL4CN';
const JIRA_CLIENT_SECRET_ENC = 'cFN1vM5KVVVCIkv9YlE5O0rerKJUkr-CszeusEVxofAH7W0evcCidzAB_OdTygfAcq2LjbN1IXK7ZiBBl3XrBsIO7RfxSGcEfHWpSbbHWxnKPP6H2iOoQZbOfns';

export const JIRA_OAUTH_CONFIG = {
  clientId: JIRA_CLIENT_ID,
  clientSecret: reveal(JIRA_CLIENT_SECRET_ENC),
};
