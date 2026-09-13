import { describe, expect, test } from 'bun:test';
import { withTempVault } from '../vault/test-helpers';
import { loadVault } from '../vault/vault';
import { updateConfig } from '../config/config-manager';
import { deleteProfile } from '../config/profile-store';
import { authenticateToken, createApiKey, describeScope, grantProfileToKey, keyAllows, listApiKeys, revokeApiKey, rotateApiKey, touchApiKey, updateApiKey, newKeyId } from './api-keys';
import { decodeToken, encodeToken } from './token';

const HUB = 'https://vault.example.com';

withTempVault('agentio-keys-test-', () => ({
  config: { profiles: { gdrive: [{ name: 'docs' }], gmail: [{ name: 'work' }, { name: 'home' }] } },
}));

describe('api keys', () => {
  test('ids never start with a dash, so `agentio key rotate <id>` cannot read one as an option', () => {
    for (let i = 0; i < 5000; i++) expect(newKeyId()).toMatch(/^[A-Za-z0-9_][A-Za-z0-9_-]{7}$/);
  });

  test('create stores only the hash and returns a token that authenticates', async () => {
    const { key, token } = await createApiKey({ name: 'agent', allowedProfiles: '*', readOnly: false }, HUB);
    expect(key).not.toHaveProperty('secretHash');
    expect(decodeToken(token)).toMatchObject({ url: HUB, kid: key.id });
    // The hint tells tokens apart in a list; four base64url characters give nothing away.
    expect(key.hint).toBe(token.slice(-4));

    const stored = (await loadVault()).config.apiKeys![0];
    expect(stored.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(token).not.toContain(stored.secretHash);

    expect(await authenticateToken(token)).toEqual(key);
    expect(await listApiKeys()).toEqual([key]);
  });

  test('wrong secret, unknown id, and malformed tokens do not authenticate', async () => {
    const { key, token } = await createApiKey({ name: 'agent', allowedProfiles: '*', readOnly: false }, HUB);
    const parts = decodeToken(token);
    expect(await authenticateToken(encodeToken({ ...parts, secret: 'x'.repeat(43) }))).toBeNull();
    expect(await authenticateToken(encodeToken({ ...parts, kid: 'nope' }))).toBeNull();
    expect(await authenticateToken('garbage')).toBeNull();
  });

  test('scope must name existing profiles, and is deduplicated', async () => {
    await expect(
      createApiKey({ name: 'a', allowedProfiles: ['gdrive/docs', 'gmail/nope'], readOnly: false }, HUB),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS', message: expect.stringContaining('gmail/nope') });
    await expect(createApiKey({ name: 'a', allowedProfiles: [], readOnly: false }, HUB)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });

    const { key } = await createApiKey({ name: 'a', allowedProfiles: ['gdrive/docs', 'gdrive/docs'], readOnly: true }, HUB);
    expect(key.allowedProfiles).toEqual(['gdrive/docs']);
    expect(keyAllows(key, 'gdrive', 'docs')).toBe(true);
    expect(keyAllows(key, 'gmail', 'work')).toBe(false);
  });

  test('name, flags, and hub URL are validated', async () => {
    await expect(createApiKey({ name: '  ', allowedProfiles: '*', readOnly: false }, HUB)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(createApiKey({ name: 'a', allowedProfiles: '*', readOnly: 'no' }, HUB)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(createApiKey({ name: 'a', allowedProfiles: '*', readOnly: false, canManageProfiles: 'yes' }, HUB)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(createApiKey({ name: 'a', allowedProfiles: '*', readOnly: false }, 'vault.example.com')).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(createApiKey({ name: 'a', allowedProfiles: '*', readOnly: false }, 'ftp://x')).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    const { token } = await createApiKey({ name: 'a', allowedProfiles: '*', readOnly: false }, 'https://vault.example.com/ui/?x=1');
    expect(decodeToken(token).url).toBe(HUB);
  });

  test('flags are off unless asked for, and show in the scope summary', async () => {
    const { key: plain } = await createApiKey({ name: 'a', allowedProfiles: '*' }, HUB);
    expect(plain).toMatchObject({ readOnly: false, canManageProfiles: false });
    expect(describeScope(plain)).toBe('all profiles');
    const { key } = await createApiKey({ name: 'b', allowedProfiles: ['gmail/home'], readOnly: true, canManageProfiles: true }, HUB);
    expect(describeScope(key)).toBe('gmail/home, read-only, can manage profiles');
  });

  test('a key minted by 2.4.0 keeps its right, and the next touch migrates the spelling away', async () => {
    const { key } = await createApiKey({ name: 'old', allowedProfiles: '*' }, HUB);
    await updateConfig((config) => {
      delete config.apiKeys![0].canManageProfiles;
      config.apiKeys![0].canAddProfiles = true;
    });
    expect(await listApiKeys()).toEqual([{ ...key, canManageProfiles: true }]);

    await updateApiKey(key.id, { name: 'renamed' });
    const stored = (await loadVault()).config.apiKeys![0];
    expect(stored).not.toHaveProperty('canAddProfiles');
    expect(stored.canManageProfiles).toBe(true);
  });

  test('a key stored before canManageProfiles existed lists as false', async () => {
    const { key } = await createApiKey({ name: 'a', allowedProfiles: '*' }, HUB);
    await updateConfig((config) => { delete config.apiKeys![0].canManageProfiles; });
    expect((await loadVault()).config.apiKeys![0]).not.toHaveProperty('canManageProfiles');
    expect(await listApiKeys()).toEqual([{ ...key, canManageProfiles: false }]);
  });

  test('update changes name, scope, and flags; unknown id is null', async () => {
    const { key } = await createApiKey({ name: 'a', allowedProfiles: '*', readOnly: false }, HUB);
    const updated = await updateApiKey(key.id, { name: 'b', allowedProfiles: ['gmail/home'], readOnly: true, canManageProfiles: true });
    expect(updated).toMatchObject({ id: key.id, name: 'b', allowedProfiles: ['gmail/home'], readOnly: true, canManageProfiles: true });
    await expect(updateApiKey('nope', { name: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('rotate keeps id and scope, invalidates the old token', async () => {
    const first = await createApiKey({ name: 'a', allowedProfiles: ['gdrive/docs'], readOnly: false }, HUB);
    const second = await rotateApiKey(first.key.id, 'http://localhost:7890');
    expect(second.key).toMatchObject({ id: first.key.id, allowedProfiles: ['gdrive/docs'] });
    expect(decodeToken(second.token).url).toBe('http://localhost:7890');
    expect(await authenticateToken(first.token)).toBeNull();
    expect(await authenticateToken(second.token)).toEqual(second.key);
    await expect(rotateApiKey('nope', HUB)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('revoke deletes the record and the token stops working', async () => {
    const { key, token } = await createApiKey({ name: 'a', allowedProfiles: '*', readOnly: false }, HUB);
    await revokeApiKey(key.id);
    expect(await listApiKeys()).toEqual([]);
    expect(await authenticateToken(token)).toBeNull();
    await expect(revokeApiKey(key.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('touch records last use, at most once a minute', async () => {
    const { key } = await createApiKey({ name: 'a', allowedProfiles: '*', readOnly: false }, HUB);
    await touchApiKey(key, new Date('2026-09-12T10:00:00Z'));
    await touchApiKey(key, new Date('2026-09-12T10:00:30Z'));
    expect((await listApiKeys())[0].lastUsedAt).toBe('2026-09-12T10:00:00.000Z');
    await touchApiKey(key, new Date('2026-09-12T10:01:00Z'));
    expect((await listApiKeys())[0].lastUsedAt).toBe('2026-09-12T10:01:00.000Z');
  });

  test('granting a profile extends a list scope once; wildcard and unknown keys are untouched', async () => {
    const { key: listed } = await createApiKey({ name: 'l', allowedProfiles: ['gdrive/docs'] }, HUB);
    const { key: star } = await createApiKey({ name: 's', allowedProfiles: '*' }, HUB);
    await updateConfig((config) => {
      grantProfileToKey(config, listed.id, 'gmail', 'work');
      grantProfileToKey(config, listed.id, 'gmail', 'work');
      grantProfileToKey(config, star.id, 'gmail', 'work');
      grantProfileToKey(config, 'nope', 'gmail', 'work');
    });
    const keys = await listApiKeys();
    expect(keys.find((k) => k.id === listed.id)!.allowedProfiles).toEqual(['gdrive/docs', 'gmail/work']);
    expect(keys.find((k) => k.id === star.id)!.allowedProfiles).toBe('*');
  });

  test('deleting a profile prunes it from key scopes; wildcard keys are untouched', async () => {
    await createApiKey({ name: 's', allowedProfiles: ['gdrive/docs', 'gmail/work'], readOnly: false }, HUB);
    await createApiKey({ name: 'a', allowedProfiles: '*', readOnly: false }, HUB);
    expect(await deleteProfile('gmail', 'work')).toBe(true);
    const [scoped, all] = await listApiKeys();
    expect(scoped.allowedProfiles).toEqual(['gdrive/docs']);
    expect(all.allowedProfiles).toBe('*');
  });
});
