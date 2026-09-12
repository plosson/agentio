import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { seedVault } from '../vault/test-helpers';
import { clearVaultCache, loadVault } from '../vault/vault';
import { clearPassphraseCache, resetPassphraseProvider } from '../vault/passphrase';
import {
  authenticateToken,
  createApiKey,
  keyAllows,
  listApiKeys,
  revokeApiKey,
  rotateApiKey,
  touchApiKey,
  updateApiKey,
  validateHubUrl,
} from './api-keys';
import { decodeToken } from './token';

const HUB = 'https://vault.example.com';
let tempHome = '';
let savedHome = '';

beforeEach(async () => {
  savedHome = process.env.HOME || '';
  tempHome = await mkdtemp(join(tmpdir(), 'agentio-keys-test-'));
  process.env.HOME = tempHome;
  await seedVault({
    config: { profiles: { gdrive: [{ name: 'docs' }], gmail: [{ name: 'work' }, { name: 'home' }] } },
  });
});

afterEach(async () => {
  process.env.HOME = savedHome;
  delete process.env.AGENTIO_PASSPHRASE;
  resetPassphraseProvider();
  clearPassphraseCache();
  clearVaultCache();
  await rm(tempHome, { recursive: true, force: true }).catch(() => {});
});

describe('api keys', () => {
  test('create stores only the hash and returns a token that authenticates', async () => {
    const { key, token } = await createApiKey({ name: 'agent', allowedProfiles: '*', readOnly: false }, HUB);
    expect(key).not.toHaveProperty('secretHash');
    expect(decodeToken(token)).toMatchObject({ url: HUB, kid: key.id });

    const stored = (await loadVault()).config.apiKeys![0];
    expect(stored.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(token).not.toContain(stored.secretHash);

    expect(await authenticateToken(token)).toEqual(key);
    expect(await listApiKeys()).toEqual([key]);
  });

  test('wrong secret, unknown id, and malformed tokens do not authenticate', async () => {
    const { key, token } = await createApiKey({ name: 'agent', allowedProfiles: '*', readOnly: false }, HUB);
    const parts = decodeToken(token);
    const { encodeToken } = await import('./token');
    expect(await authenticateToken(encodeToken({ ...parts, secret: 'x'.repeat(43) }))).toBeNull();
    expect(await authenticateToken(encodeToken({ ...parts, kid: 'nope' }))).toBeNull();
    expect(await authenticateToken('garbage')).toBeNull();
    expect(await authenticateToken(token)).toEqual(key);
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

  test('name, readOnly, and hub URL are validated', async () => {
    await expect(createApiKey({ name: '  ', allowedProfiles: '*', readOnly: false }, HUB)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(createApiKey({ name: 'a', allowedProfiles: '*', readOnly: 'no' as never }, HUB)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(createApiKey({ name: 'a', allowedProfiles: '*', readOnly: false }, 'vault.example.com')).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(createApiKey({ name: 'a', allowedProfiles: '*', readOnly: false }, 'ftp://x')).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(validateHubUrl('https://vault.example.com/ui/?x=1')).toBe('https://vault.example.com');
    expect(validateHubUrl('http://127.0.0.1:7890')).toBe('http://127.0.0.1:7890');
  });

  test('update changes name, scope, and read-only; unknown id is null', async () => {
    const { key } = await createApiKey({ name: 'a', allowedProfiles: '*', readOnly: false }, HUB);
    const updated = await updateApiKey(key.id, { name: 'b', allowedProfiles: ['gmail/home'], readOnly: true });
    expect(updated).toMatchObject({ id: key.id, name: 'b', allowedProfiles: ['gmail/home'], readOnly: true });
    expect(await updateApiKey('nope', { name: 'x' })).toBeNull();
  });

  test('rotate keeps id and scope, invalidates the old token', async () => {
    const first = await createApiKey({ name: 'a', allowedProfiles: ['gdrive/docs'], readOnly: false }, HUB);
    const second = await rotateApiKey(first.key.id, 'http://localhost:7890');
    expect(second!.key).toMatchObject({ id: first.key.id, allowedProfiles: ['gdrive/docs'] });
    expect(decodeToken(second!.token).url).toBe('http://localhost:7890');
    expect(await authenticateToken(first.token)).toBeNull();
    expect(await authenticateToken(second!.token)).toEqual(second!.key);
    expect(await rotateApiKey('nope', HUB)).toBeNull();
  });

  test('revoke deletes the record and the token stops working', async () => {
    const { key, token } = await createApiKey({ name: 'a', allowedProfiles: '*', readOnly: false }, HUB);
    expect(await revokeApiKey(key.id)).toBe(true);
    expect(await listApiKeys()).toEqual([]);
    expect(await authenticateToken(token)).toBeNull();
    expect(await revokeApiKey(key.id)).toBe(false);
  });

  test('touch records last use', async () => {
    const { key } = await createApiKey({ name: 'a', allowedProfiles: '*', readOnly: false }, HUB);
    await touchApiKey(key.id, new Date('2026-09-12T10:00:00Z'));
    expect((await listApiKeys())[0].lastUsedAt).toBe('2026-09-12T10:00:00.000Z');
  });
});
