import type { InputSpec, SetupNeeds } from '../../plugin-sdk';

// Kept apart from commands.ts, which reaches the plugin registry through the vault: importing these
// must not load the plugins (a test, or a future caller, could otherwise meet them half-initialised).

// A connection URL holds the password, so it is a secret; `url` would refuse postgres:// and sqlite://.
export const SQL_URL_INPUT: InputSpec = {
  id: 'url', label: 'Connection URL', kind: 'secret',
  help: 'postgres://user:password@host:5432/db, mysql://user:password@host:3306/db or sqlite:///path/to/file.db',
};

/** What SQL setup needs: one connection URL. No sign-in. */
export const SQL_SETUP_NEEDS: SetupNeeds = { inputs: [SQL_URL_INPUT], auth: 'none' };
