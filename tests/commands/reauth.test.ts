import { describe, expect, mock, spyOn, test } from 'bun:test';
import { withTempVault } from '../helpers/vault';
import { loadVault } from '../../src/vault/vault';
import { reauthProfile, reauthSelected } from '../../src/commands/reauth';
import { scopesFor, type OAuthService } from '../../src/plugins/google/oauth';
import { GOOGLE_SUITE } from '../../src/plugins/google/suite';
import type { ProfileStatus } from '../../src/commands/status';

const ME = 'me@x.com';
const old = { access_token: 'old', refresh_token: 'rt-old', token_type: 'Bearer', email: ME };

withTempVault('agentio-reauth-test-', () => ({
  config: { profiles: { gmail: [{ name: 'me' }], gcal: [{ name: 'me' }], discourse: [{ name: 'alerts' }] } },
  credentials: { gmail: { me: old }, gcal: { me: old }, discourse: { alerts: { botToken: 't', channelId: '1' } } },
}));

function captureStderr() {
  const messages: string[] = [];
  const spy = spyOn(console, 'error').mockImplementation((message) => { messages.push(String(message)); });
  return { messages, restore: () => spy.mockRestore() };
}

describe('reauthProfile fallback', () => {
  test('uses one generic profile-setup instruction without a service-name list', async () => {
    const { messages, restore } = captureStderr();
    try {
      await reauthProfile('discourse', 'alerts');
      await reauthProfile('sql', 'work');
    } finally {
      restore();
    }

    expect(messages).toEqual([
      '\nSkipping discourse / alerts: no automatic reauthentication is registered. Run \'agentio discourse profile add --profile alerts\' to update.',
      '\nSkipping sql / work: no automatic reauthentication is registered. Run \'agentio sql profile add --profile work\' to update.',
    ]);
  });
});

describe('reauthSelected', () => {
  test('Google profiles of one account share a consent; other services still go one at a time', async () => {
    const performOAuth = mock(async (keys: OAuthService | readonly OAuthService[]) => ({
      access_token: 'at-new', refresh_token: 'rt-new', token_type: 'Bearer',
      scope: scopesFor(typeof keys === 'string' ? [keys] : [...keys]).join(' '),
    }));
    const selected: ProfileStatus[] = [
      { service: 'gmail', profile: 'me', status: 'invalid' },
      { service: 'discourse', profile: 'alerts', status: 'invalid' },
      { service: 'gcal', profile: 'me', status: 'invalid' },
    ];
    const { messages, restore } = captureStderr();
    try {
      await reauthSelected(selected, { performOAuth, fetchEmail: mock(async () => ME), suite: GOOGLE_SUITE });
    } finally {
      restore();
    }

    expect(performOAuth).toHaveBeenCalledTimes(1);
    expect((await loadVault()).credentials.gcal?.me).toMatchObject({ refresh_token: 'rt-new' });
    expect(messages).toContain('\nSkipping discourse / alerts: no automatic reauthentication is registered. Run \'agentio discourse profile add --profile alerts\' to update.');
  });
});
