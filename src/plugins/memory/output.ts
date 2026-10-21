import { writeJson } from '../../utils/output';
import type { EntityResult, ForgetPlan, ForgetResult } from './operations';
import type { MemoryAdded, MemoryEpisode, MemoryFact } from './types';

/** `--json` writes `data`; otherwise `text` prints for people. */
function emit(json: boolean | undefined, data: unknown, text: () => void): void {
  if (json) writeJson(data, 2);
  else text();
}

function sourceLine(ref: string | null, url: string | null): string {
  if (!ref && !url) return '(unknown source)';
  return [ref ? `ref ${ref}` : null, url].filter(Boolean).join(' ');
}

export function printAdded(added: MemoryAdded, json?: boolean): void {
  emit(json, added, () => {
    console.log('Queued for Graphiti to extract facts');
    console.log(`  Episode: ${added.uuid}`);
    console.log(`  Group: ${added.group}`);
    console.log(`  Source: ${sourceLine(added.ref, added.url)}`);
    console.log('Facts appear in search once the server has processed it, usually within a minute.');
  });
}

function factLines(fact: MemoryFact): void {
  console.log(fact.fact);
  console.log(`  Fact: ${fact.uuid}${fact.name ? ` (${fact.name})` : ''}`);
  if (fact.valid_at || fact.invalid_at) console.log(`  Valid: ${fact.valid_at ?? '?'} → ${fact.invalid_at ?? 'now'}`);
  const sources = fact.sources.length ? fact.sources : [];
  for (const source of sources) console.log(`  From: ${sourceLine(source.ref, source.url)}${source.ref ? '' : ` (episode ${source.episode})`}`);
}

export function printFacts(facts: MemoryFact[], json?: boolean): void {
  emit(json, { facts }, () => {
    if (facts.length === 0) {
      console.log('No facts found');
      return;
    }
    console.log(`Facts (${facts.length})\n`);
    for (const fact of facts) {
      factLines(fact);
      console.log('');
    }
  });
}

export function printEntity(result: EntityResult, json?: boolean): void {
  emit(json, result, () => {
    if (result.facts.length === 0) {
      console.log(`No facts about "${result.entity}" in group ${result.group}`);
      return;
    }
    console.log(`${result.entity}: ${result.facts.length} fact${result.facts.length === 1 ? '' : 's'} in group ${result.group}`);
    if (result.node) console.log(`  Node: ${result.node}`);
    console.log('');
    for (const fact of result.facts) {
      factLines(fact);
      console.log('');
    }
  });
}

export function printEpisodes(episodes: MemoryEpisode[], json?: boolean): void {
  emit(json, { episodes }, () => {
    if (episodes.length === 0) {
      console.log('No episodes found');
      return;
    }
    console.log(`Episodes (${episodes.length})\n`);
    for (const episode of episodes) {
      console.log(episode.name || '(unnamed)');
      console.log(`  Episode: ${episode.uuid}`);
      console.log(`  Group: ${episode.group}`);
      console.log(`  Source: ${sourceLine(episode.ref, episode.url)}`);
      if (episode.valid_at) console.log(`  Valid at: ${episode.valid_at}`);
      const text = episode.text.length > 200 ? `${episode.text.slice(0, 200)}…` : episode.text;
      console.log(`  Text: ${text.replace(/\s+/g, ' ')}`);
      console.log('');
    }
  });
}

export function describePlan(plan: ForgetPlan): string {
  const facts = plan.facts.length ? ` and ${plan.facts.length} fact${plan.facts.length === 1 ? '' : 's'} extracted only from them` : '';
  return `Forget ${plan.episodes.length} episode${plan.episodes.length === 1 ? '' : 's'} for ref ${plan.ref} in group ${plan.group}${facts}?`;
}

export function printForgot(result: ForgetResult, json?: boolean): void {
  emit(json, result, () => {
    if (result.deletedEpisodes.length === 0 && result.failed.length === 0) {
      console.log(`Nothing to forget for ref ${result.ref} in group ${result.group}`);
      return;
    }
    console.log(`Forgot ref ${result.ref} in group ${result.group}`);
    console.log(`  Episodes deleted: ${result.deletedEpisodes.length}`);
    console.log(`  Facts deleted: ${result.deletedFacts.length}`);
    if (result.keptFacts.length) console.log(`  Facts kept (other documents support them): ${result.keptFacts.length}`);
    for (const failure of result.failed) console.log(`  Failed ${failure.kind} ${failure.uuid}: ${failure.error}`);
  });
}
