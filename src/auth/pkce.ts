import { createHash, randomBytes } from 'crypto';

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** An RFC 7636 verifier and its S256 challenge. */
export function createPkcePair(): PkcePair {
  const verifier = randomBytes(64).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}
