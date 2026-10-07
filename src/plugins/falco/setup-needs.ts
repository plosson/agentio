import type { InputSpec, SetupNeeds } from '../../plugin-sdk';

export const FALCO_EMAIL_INPUT: InputSpec = { id: 'email', label: 'Email', kind: 'email' };
export const FALCO_PASSWORD_INPUT: InputSpec = { id: 'password', label: 'Password', kind: 'secret' };
/** Asked during the run, only when Falco asks for it. */
export const FALCO_CODE_INPUT: InputSpec = { id: 'twoFactorCode', label: 'Two-factor code', kind: 'text' };

export const FALCO_SETUP_NEEDS: SetupNeeds = { inputs: [FALCO_EMAIL_INPUT, FALCO_PASSWORD_INPUT], auth: 'none' };
