import { encryptVault, decryptVault } from '../../src/vault/crypto.ts';
const passphrase = 'go-port-skeleton-test';
const plaintext = JSON.stringify({
  version: 1,
  config: { profiles: { gmail: [{ name: 'fixture@example.com', readOnly: false }] } },
  credentials: {
    gmail: {
      'fixture@example.com': {
        access_token: 'ya29.test',
        refresh_token: '1//test-refresh',
        expiry_date: Date.now() + 3600_000,
        token_type: 'Bearer',
        scope: 'https://www.googleapis.com/auth/gmail.readonly',
        email: 'fixture@example.com',
      },
    },
  },
});
const enc = await encryptVault(plaintext, passphrase);
await Bun.write(new URL('./vault.fixture.b64', import.meta.url), enc);
const round = await decryptVault(enc, passphrase);
if (round !== plaintext) throw new Error('bun roundtrip failed');
console.log('ok', enc.length);
