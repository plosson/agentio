import { CliError } from '../../utils/errors';
import { MemoryClient, parseSource, toMemoryEpisode } from './client';
import type { GraphitiFact, MemoryEpisode, MemoryFact, MemorySource } from './types';

/**
 * What the commands do beyond one request. The REST server has no route that reads one episode or
 * filters by source, so refs are found by listing a group's recent episodes (`scan` of them).
 */

/** Episode uuid → its ref and url, from the `scan` most recent episodes of each group. */
async function sourcesByEpisode(client: MemoryClient, groups: string[], scan: number): Promise<Map<string, MemorySource>> {
  const map = new Map<string, MemorySource>();
  for (const group of groups) {
    for (const episode of await client.episodes(group, scan)) map.set(episode.uuid, parseSource(episode.source_description));
  }
  return map;
}

/**
 * Each fact with the documents it came from. Without a group to list, refs cannot be resolved: they stay
 * null with the episode uuid alone.
 */
export async function withSources(client: MemoryClient, facts: GraphitiFact[], groups: string[] | null, scan: number): Promise<MemoryFact[]> {
  const needed = facts.some((f) => f.episodes.length > 0);
  const known = needed && groups ? await sourcesByEpisode(client, groups, scan) : new Map<string, MemorySource>();
  return facts.map((fact) => ({
    ...fact,
    sources: fact.episodes.map((episode) => ({ episode, ...(known.get(episode) ?? { ref: null, url: null }) })),
  }));
}

export async function listEpisodes(client: MemoryClient, group: string, limit: number, ref?: string, scan?: number): Promise<MemoryEpisode[]> {
  if (ref === undefined) return (await client.episodes(group, limit)).map(toMemoryEpisode);
  const matching = (await client.episodes(group, Math.max(scan ?? limit, limit))).map(toMemoryEpisode).filter((e) => e.ref === ref);
  return matching.slice(0, limit);
}

export interface EntityResult {
  entity: string;
  group: string;
  /** The graph node taken for the entity: the one most of the facts that name it touch. */
  node: string | null;
  facts: MemoryFact[];
}

function mentions(fact: GraphitiFact, needle: string): boolean {
  return fact.fact.toLowerCase().includes(needle) || fact.name.toLowerCase().includes(needle);
}

/**
 * Facts linked to an entity. The REST server cannot look a node up by name, so this searches for the
 * name, keeps the facts that mention it, takes the node those facts share most as the entity, then asks
 * `/get-memory` for the facts around that node and keeps the ones that touch it.
 */
export async function entityFacts(client: MemoryClient, name: string, group: string, limit: number, scan: number): Promise<EntityResult> {
  const needle = name.trim().toLowerCase();
  if (!needle) throw new CliError('INVALID_PARAMS', 'An entity name is required');
  const candidates = (await client.search(name, [group], Math.min(Math.max(limit, 20), 200))).filter((f) => mentions(f, needle));
  if (candidates.length === 0) return { entity: name, group, node: null, facts: [] };

  const counts = new Map<string, number>();
  for (const fact of candidates) {
    for (const node of [fact.source_node_uuid, fact.target_node_uuid]) counts.set(node, (counts.get(node) ?? 0) + 1);
  }
  const node = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const around = await client.around(group, node, name, limit);

  const facts: GraphitiFact[] = [];
  const seen = new Set<string>();
  for (const fact of [...around, ...candidates]) {
    if (seen.has(fact.uuid)) continue;
    if (fact.source_node_uuid !== node && fact.target_node_uuid !== node && !mentions(fact, needle)) continue;
    seen.add(fact.uuid);
    facts.push(fact);
  }
  return { entity: name, group, node, facts: await withSources(client, facts.slice(0, limit), [group], scan) };
}

export interface ForgetPlan {
  ref: string;
  group: string;
  episodes: MemoryEpisode[];
  /** Facts that came only from these episodes: removed with them. */
  facts: string[];
  /** Facts that other episodes support too: kept. */
  keptFacts: string[];
}

export interface ForgetResult {
  ref: string;
  group: string;
  deletedEpisodes: string[];
  deletedFacts: string[];
  keptFacts: string[];
  failed: Array<{ uuid: string; kind: 'episode' | 'fact'; error: string }>;
}

/**
 * What forgetting a ref removes. The server's `DELETE /episode` removes the episode node only, so facts
 * extracted from it would stay, still pointing at it. Each episode lists its facts (`entity_edges`); a
 * fact is removed when every episode it came from is being forgotten. Entity nodes stay: the REST
 * server cannot delete them.
 */
export async function planForget(client: MemoryClient, ref: string, group: string, scan: number, keepFacts: boolean): Promise<ForgetPlan> {
  const raw = (await client.episodes(group, scan)).filter((e) => parseSource(e.source_description).ref === ref);
  const episodes = raw.map(toMemoryEpisode);
  const facts: string[] = [];
  const keptFacts: string[] = [];
  if (!keepFacts) {
    const forgotten = new Set(raw.map((e) => e.uuid));
    const edgeIds = [...new Set(raw.flatMap((e) => e.entity_edges ?? []))];
    for (const id of edgeIds) {
      let fact: GraphitiFact;
      try {
        fact = await client.fact(id);
      } catch (error) {
        if (error instanceof CliError && error.code === 'NOT_FOUND') continue; // Already gone.
        throw error;
      }
      if (fact.episodes.every((e) => forgotten.has(e))) facts.push(id);
      else keptFacts.push(id);
    }
  }
  return { ref, group, episodes, facts, keptFacts };
}

export async function runForget(client: MemoryClient, plan: ForgetPlan): Promise<ForgetResult> {
  const result: ForgetResult = { ref: plan.ref, group: plan.group, deletedEpisodes: [], deletedFacts: [], keptFacts: plan.keptFacts, failed: [] };
  const attempt = async (uuid: string, kind: 'episode' | 'fact', run: () => Promise<void>, done: string[]) => {
    try {
      await run();
      done.push(uuid);
    } catch (error) {
      if (error instanceof CliError && error.code === 'NOT_FOUND') {
        done.push(uuid);
        return;
      }
      if (error instanceof CliError && error.code === 'AUTH_FAILED') throw error;
      result.failed.push({ uuid, kind, error: error instanceof Error ? error.message : String(error) });
    }
  };
  // Facts first: once the episodes are gone, nothing would tie them to the ref any more.
  for (const uuid of plan.facts) await attempt(uuid, 'fact', () => client.deleteFact(uuid), result.deletedFacts);
  for (const episode of plan.episodes) await attempt(episode.uuid, 'episode', () => client.deleteEpisode(episode.uuid), result.deletedEpisodes);
  return result;
}
