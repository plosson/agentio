import { describe, expect, spyOn, test } from 'bun:test';
import { reauthProfile } from '../../src/commands/reauth';

describe('reauthProfile fallback', () => {
  test('uses one generic profile-setup instruction without a service-name list', async () => {
    const messages: string[] = [];
    const error = spyOn(console, 'error').mockImplementation((message) => {
      messages.push(String(message));
    });

    try {
      await reauthProfile('telegram', 'alerts');
      await reauthProfile('sql', 'work');
    } finally {
      error.mockRestore();
    }

    expect(messages).toEqual([
      '\nSkipping telegram / alerts: no automatic reauthentication is registered. Run \'agentio telegram profile add --profile alerts\' to update.',
      '\nSkipping sql / work: no automatic reauthentication is registered. Run \'agentio sql profile add --profile work\' to update.',
    ]);
  });
});
