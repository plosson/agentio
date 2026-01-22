import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * Simple obfuscation utilities for embedding secrets in source code.
 *
 * NOT for real security - just prevents secret scanners from flagging embedded
 * OAuth client secrets. Uses the same pattern as rclone.
 *
 * obscure() is exported for generating new obscured values (run in a scratch file):
 *   import { obscure } from './src/utils/obscure';
 *   console.log(obscure('your-secret-here'));
 *
 * reveal() is used at runtime to decode the obscured values.
 */

// Hardcoded key for obfuscation (not real security, just to avoid secret scanners)
// This is the same pattern rclone uses
const OBSCURE_KEY = Buffer.from('9c935b2aa628f0e9d48d5f3e8a4b7c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b', 'hex');

export function obscure(plaintext: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-ctr', OBSCURE_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const result = Buffer.concat([iv, encrypted]);
  return result.toString('base64url');
}

export function reveal(obscured: string): string {
  const data = Buffer.from(obscured, 'base64url');
  const iv = data.subarray(0, 16);
  const encrypted = data.subarray(16);
  const decipher = createDecipheriv('aes-256-ctr', OBSCURE_KEY, iv);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}
