import { isLegacyServicePlugin, type ProfileDetails, type RegisteredServicePlugin } from './types';

const MAX_ACCOUNT = 200;
const MAX_URL = 400;

/** A trimmed, non-empty string no longer than `max`, or nothing. */
function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : undefined;
}

/** An absolute http(s) link without embedded credentials, or nothing: the page turns it into a link. */
function link(value: unknown): string | undefined {
  const raw = text(value, MAX_URL);
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return undefined;
  return raw;
}

/**
 * What the admin shows about a profile: the plugin's own `describe`, cleaned
 * up, and the service's web app as the link when the profile has none. A
 * plugin that throws or returns something odd simply shows nothing more.
 */
export function profileDetails(plugin: RegisteredServicePlugin | undefined, credentials: unknown): ProfileDetails {
  if (!plugin) return {};
  let described: unknown;
  if (credentials && isLegacyServicePlugin(plugin) && plugin.profile?.describe) {
    try {
      described = plugin.profile.describe(credentials);
    } catch {
      described = undefined;
    }
  }
  const own = (typeof described === 'object' && described !== null ? described : {}) as Record<string, unknown>;
  const details: ProfileDetails = {};
  const account = text(own.account, MAX_ACCOUNT);
  const url = link(own.url) ?? link(plugin.brand && 'url' in plugin.brand ? plugin.brand.url : undefined);
  if (account) details.account = account;
  if (url) details.url = url;
  return details;
}
