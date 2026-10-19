declare const BUILD_VERSION: string | undefined;

/** This agentio's version: baked in by `build:native`, read from package.json otherwise. */
export function agentioVersion(): string {
  if (typeof BUILD_VERSION !== 'undefined') {
    return BUILD_VERSION;
  }
  return require('../../package.json').version;
}
