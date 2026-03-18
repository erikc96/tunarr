import { injectable, inject } from 'inversify';
import { LoggerFactory } from '@/util/logging/LoggerFactory.js';
import { AnthropicAdapter } from './AnthropicAdapter.js';
import { ContextBuilder, type MediaItem } from './ContextBuilder.js';

const logger = LoggerFactory.child({
  caller: import.meta,
  className: 'ChannelGenerator',
});

export interface ChannelProposal {
  name: string;
  number: number;
  groupTitle: string;
  programUuids: string[];
  warnings: string[];
}

@injectable()
export class ChannelGenerator {
  constructor(
    @inject(AnthropicAdapter) private adapter: AnthropicAdapter,
    @inject(ContextBuilder) private ctx: ContextBuilder,
  ) {}

  async generate(
    prompt: string,
    existingChannels: { number: number; name: string }[],
  ): Promise<ChannelProposal | { error: string; raw?: string }> {
    const stats = await this.ctx.getStats();
    const items = await this.ctx.getFilteredItems(prompt);
    const summaryList = this.ctx.buildSummaryList(items);

    const usedNumbers = new Set(existingChannels.map((c) => c.number));
    let nextNumber = 1;
    while (usedNumbers.has(nextNumber)) nextNumber++;

    const channelList =
      existingChannels.length > 0
        ? '\n\nExisting channels:\n' +
          existingChannels.map((c) => `#${c.number}: ${c.name}`).join('\n')
        : '';

    const systemPrompt = [
      'You are a TV channel curator for Tunarr. You create themed TV channels from a media library.',
      'You MUST respond with ONLY valid JSON, no markdown, no explanation, no code fences.',
      'If no content matches the request, still return valid JSON with an empty selections array.',
      '\nLibrary overview:\n' + stats,
      channelList,
    ].join('\n');

    logger.info(
      'Generating channel for prompt "%s": %d items available',
      prompt,
      items.length,
    );

    const userMsg = [
      prompt,
      `\nAvailable content (${items.length} items):\n${summaryList}`,
      `\nNext available channel number: ${nextNumber}`,
      '\nRules:',
      '- Items prefixed with SHOW: are TV shows. Select them with type "show" and the exact show name in quotes.',
      '- Items prefixed with MOVIE: are movies. Select them with type "movie" and the exact movie title in quotes.',
      '- Do NOT list individual episodes — just select the show name and all episodes are included automatically.',
      '- ORDER MATTERS: Arrange your selections in a curated viewing order. Group most movies into small clusters (2-4 films) by perceivable commonality — subgenre, director, era, tone, aesthetic, franchise — then move to a different cluster. Occasionally place a standalone film between clusters as a palate cleanser or wild card. Do NOT just sort chronologically or alphabetically. Think like a creative human programming a themed marathon with variety and flow.',
      `\nRespond with ONLY this JSON, nothing else:`,
      `{ "name": "...", "number": ${nextNumber}, "selections": [{ "type": "show", "title": "Show Name" }, { "type": "movie", "title": "Movie Title" }], "groupTitle": "..." }`,
      'If nothing matches, return: { "name": "...", "number": ' + nextNumber + ', "selections": [], "groupTitle": "" }',
    ].join('\n');

    const response = await this.adapter.complete(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg },
      ],
      { responseFormat: 'json', temperature: 0.7 },
    );

    let parsed: {
      name?: string;
      number?: number;
      groupTitle?: string;
      selections?: { type: 'show' | 'movie'; title: string }[];
    };
    try {
      parsed = JSON.parse(response);
    } catch {
      // Attempt to repair truncated JSON (e.g. cut off mid-selections array)
      try {
        const repaired = response
          .replace(/,?\s*\{[^}]*$/, '')  // remove last incomplete object
          .replace(/,\s*$/, '')           // trailing comma
          + ']}';
        parsed = JSON.parse(repaired);
        logger.warn('Repaired truncated JSON from LLM');
      } catch {
        logger.error('LLM returned invalid JSON: %s', response.slice(0, 500));
        return { error: 'LLM returned invalid JSON', raw: response };
      }
    }

    const selections = parsed.selections ?? [];
    logger.info('LLM selected %d items: %o', selections.length, selections.slice(0, 10));
    const resolved = await this.ctx.expandSelections(selections);
    const interleaved = interleavePrograms(resolved);
    const programUuids = interleaved.map((r) => r.uuid);

    const warnings: string[] = [];
    if (programUuids.length === 0) {
      warnings.push('No items matched the selections');
    }

    logger.info(
      'Generated channel "%s" with %d programs',
      parsed.name,
      programUuids.length,
    );

    return {
      name: parsed.name ?? 'AI Channel',
      number: parsed.number ?? nextNumber,
      groupTitle: parsed.groupTitle ?? '',
      programUuids,
      warnings,
    };
  }
}

/**
 * Interleave programs from different shows so the lineup isn't just
 * all episodes of show A followed by all of show B. Movies are treated
 * as individual items. Episodes within a show keep their season/episode order.
 *
 * Strategy: round-robin through show queues, picking 1-3 episodes per turn.
 * Single-show channels pass through unchanged.
 */
function interleavePrograms(items: MediaItem[]): MediaItem[] {
  const groups = new Map<string, MediaItem[]>();
  const movieKey = '__movies__';

  for (const item of items) {
    const key = item.showTitle ?? movieKey;
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push(item);
  }

  // Sort episodes within each show by season then episode number
  for (const [key, group] of groups) {
    if (key !== movieKey) {
      group.sort((a, b) => {
        const sa = a.seasonNumber ?? 0;
        const sb = b.seasonNumber ?? 0;
        if (sa !== sb) return sa - sb;
        return (a.episode ?? 0) - (b.episode ?? 0);
      });
    }
  }

  // Single group — no interleaving needed, but return the sorted version
  if (groups.size <= 1) {
    const [group] = groups.values();
    return group ?? items;
  }

  // Build queue entries: each show is a queue, movies stay as one ordered queue
  // so the LLM's thematic clustering is preserved
  const queues: MediaItem[][] = [];
  for (const [, group] of groups) {
    queues.push(group);
  }

  const result: MediaItem[] = [];
  const cursors = new Array<number>(queues.length).fill(0);
  let remaining = items.length;

  // Seeded PRNG so lineup is deterministic for the same input
  let seed = items.length;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  while (remaining > 0) {
    // Pick a random non-exhausted queue
    const active: number[] = [];
    for (let i = 0; i < queues.length; i++) {
      if (cursors[i]! < queues[i]!.length) active.push(i);
    }
    if (active.length === 0) break;

    const qi = active[Math.floor(rand() * active.length)]!;
    const queue = queues[qi]!;
    const cursor = cursors[qi]!;
    const left = queue.length - cursor;

    // Pick 1-3 consecutive items per turn
    const blockSize = Math.min(left, 1 + Math.floor(rand() * 3));

    for (let i = 0; i < blockSize; i++) {
      result.push(queue[cursor + i]!);
    }
    cursors[qi] = cursor + blockSize;
    remaining -= blockSize;
  }

  return result;
}
