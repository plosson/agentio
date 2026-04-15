/**
 * Embedded favicon served at `/favicon.ico` and `/favicon.png`. Keeps MCP
 * clients (e.g. Claude's connector UI) from falling back to the generic
 * globe icon. Bytes are inlined so every build target — dev, `bun build
 * --target node`, and `bun build --compile` — ships it without filesystem
 * lookups.
 *
 * Source: `site/logo.png` (120x120 PNG).
 */

const FAVICON_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAHgAAAB4EAIAAADmln3GAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRP///////wlY99wAAAAHdElNRQfqAQMQAyhWYExTAAAAJXRFWHRkYXRlOmNyZWF0ZQAyMDI2LTAxLTAzVDE2OjAzOjM5KzAwOjAwTY3PQAAAACV0RVh0ZGF0ZTptb2RpZnkAMjAyNi0wMS0wM1QxNjowMzozOSswMDowMDzQd/wAAAAodEVYdGRhdGU6dGltZXN0YW1wADIwMjYtMDEtMDNUMTY6MDM6MzkrMDA6MDBrxVYjAAAMjklEQVR42u3dd1QU1x4H8Dtll04EREBFEBSVIiWCFAUBsccSTYyFGKOIPp9HeXmWYIklqKioiSHRaKIGsSTHEiNRH6iRpgRDsUSKiGIE9IkNZZfdnZn3x7z3Ts5LZnbdyt73+/zlcX87d+71e2an3DsScXFpaS9eIACwQJp6BwDQJwg0wAoEGmAFAg2wAoEGWIFAA6xAoAFWINAAKxBogBUINMAKBBpgBQINsAKBBliBQAOsQKABViDQACsQaIAVCDTACgQaYAUCDbACgQZYgUADrECgAVYg0AArEGiAFQg0wAoEGmAFAg2wAoEGWIFAA6xAoAFWINAAKxBogBUINMAKBBpgBQINsAKBBliBQAOsQKABViDQACsQaIAVCDTACgQaYAUCDbACgQZYgUADrECgAVYg0AArEGiAFQg0wAoEGmAFAg2w8i9H6natiosOZAAAAABJRU5ErkJggg==';

export const FAVICON_BYTES = Uint8Array.from(
  Buffer.from(FAVICON_BASE64, 'base64')
);
export const FAVICON_CONTENT_TYPE = 'image/png';
