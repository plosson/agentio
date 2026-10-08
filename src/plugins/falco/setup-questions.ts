import type { InputSpec } from '../../plugin-sdk';

// Kept apart from commands.ts, which reaches the plugin registry: lifecycle.ts and auth.ts ask these too.

export const FALCO_EMAIL_INPUT: InputSpec = { label: 'Email', kind: 'email' };
export const FALCO_PASSWORD_INPUT: InputSpec = { label: 'Password', kind: 'secret' };
/** Asked only when Falco asks for it. */
export const FALCO_CODE_INPUT: InputSpec = { label: 'Two-factor code', kind: 'text' };
