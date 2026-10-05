import type { SetupContext } from '../../plugin-sdk';

// Shared by Jira and Confluence: both sign in through the same Atlassian app, and one account can
// reach several sites. Not a plugin: nothing here is registered.

const ATLASSIAN_RESOURCES_URL = 'https://api.atlassian.com/oauth/token/accessible-resources';

export interface AtlassianSite {
  id: string;
  url: string;
  name: string;
  scopes: string[];
  avatarUrl?: string;
}

/** The sites the signed-in account reaches. */
export async function getAccessibleResources(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<AtlassianSite[]> {
  const response = await fetchImpl(ATLASSIAN_RESOURCES_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get accessible resources: ${error}`);
  }

  return response.json();
}

/** The site to use: asked only when the account reaches several. `product` names it in the question. */
export async function selectAtlassianSite(
  sites: AtlassianSite[],
  context: SetupContext,
  product: 'Jira' | 'Confluence',
): Promise<AtlassianSite> {
  if (sites.length === 1) return sites[0];
  const id = await context.ask({
    id: 'site',
    label: `${product} site`,
    kind: 'choice',
    choices: sites.map((site) => ({ value: site.id, label: `${site.name} (${site.url})` })),
  });
  return sites.find((site) => site.id === id)!;
}
