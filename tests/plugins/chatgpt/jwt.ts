/** An unsigned JWT with `claims` as its payload, as far as agentio reads one. */
export function jwt(claims: Record<string, unknown>): string {
  const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(claims)}.sig`;
}
