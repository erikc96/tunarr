import { injectable, inject } from 'inversify';
import { LoggerFactory } from '@/util/logging/LoggerFactory.js';
import { AnthropicAdapter } from './AnthropicAdapter.js';
import { ContextBuilder } from './ContextBuilder.js';

const logger = LoggerFactory.child({
  caller: import.meta,
  className: 'ChannelRefresher',
});

export interface RefreshResult {
  newProgramUuids: string[];
  warnings: string[];
  error?: string;
}

interface ChannelInfo {
  id: string;
  name: string;
  number: number;
  programUuids: string[];
  shows: Record<string, number>;
}

@injectable()
export class ChannelRefresher {
  constructor(
    @inject(AnthropicAdapter) private adapter: AnthropicAdapter,
    @inject(ContextBuilder) private ctx: ContextBuilder,
  ) {}

  async refresh(channel: ChannelInfo): Promise<RefreshResult> {
    const existingSet = new Set(channel.programUuids);
    const showNames = Object.keys(channel.shows);

    let candidates: import('./ContextBuilder.js').MediaItem[] = [];
    for (const show of showNames) {
      const episodes = await this.ctx.queryPrograms({
        showTitle: show,
        limit: 10000,
      });
      candidates.push(
        ...episodes.filter((ep) => !existingSet.has(ep.uuid)),
      );
    }

    if (candidates.length === 0) {
      const all = await this.ctx.queryPrograms({ limit: 500 });
      candidates = all.filter((i) => !existingSet.has(i.uuid));
    }

    if (candidates.length === 0) {
      return { newProgramUuids: [], warnings: ['No new matching content found'] };
    }

    const summaryList = this.ctx.buildSummaryList(candidates);
    const channelShows = Object.entries(channel.shows)
      .sort((a, b) => b[1] - a[1])
      .map(([s, c]) => `${s}(${c})`)
      .join(', ');

    const userMsg = [
      `Channel: "${channel.name}" (#${channel.number})`,
      `Current shows: ${channelShows}`,
      `Current program count: ${channel.programUuids.length}`,
      `\nNew items available (${candidates.length} total):\n${summaryList}`,
      '\nSelect shows and movies that fit this channel\'s theme. ALL episodes of selected shows will be added automatically.',
      '\nRespond with JSON: { "selections": [{ "type": "show"|"movie", "title": "exact title" }] }',
      'Be thorough: include every show and movie that belongs on this channel.',
    ].join('\n');

    const response = await this.adapter.complete(
      [
        {
          role: 'system',
          content: 'You are a TV channel curator. Add new programs to existing channels that match their theme.',
        },
        { role: 'user', content: userMsg },
      ],
      { responseFormat: 'json', temperature: 0.5 },
    );

    let parsed: {
      selections?: { type: 'show' | 'movie'; title: string }[];
    };
    try {
      parsed = JSON.parse(response);
    } catch {
      return { newProgramUuids: [], warnings: [], error: 'LLM returned invalid JSON' };
    }

    const selections = parsed.selections ?? [];
    const resolved = await this.ctx.expandSelections(selections, existingSet);
    const newProgramUuids = resolved.map((r) => r.uuid);

    logger.info(
      'Refresh for channel "%s": found %d new programs',
      channel.name,
      newProgramUuids.length,
    );

    return {
      newProgramUuids,
      warnings: newProgramUuids.length === 0 ? ['No new matching content found'] : [],
    };
  }

  async addByPrompt(
    channel: ChannelInfo,
    prompt: string,
  ): Promise<RefreshResult> {
    const existingSet = new Set(channel.programUuids);
    let candidates = await this.ctx.getFilteredItems(prompt);
    candidates = candidates.filter((i) => !existingSet.has(i.uuid));

    if (candidates.length === 0) {
      const all = await this.ctx.queryPrograms({ limit: 500 });
      candidates = all.filter((i) => !existingSet.has(i.uuid));
    }

    if (candidates.length === 0) {
      return { newProgramUuids: [], warnings: ['No new matching content found'] };
    }

    const summaryList = this.ctx.buildSummaryList(candidates);

    const userMsg = [
      `Channel: "${channel.name}" (#${channel.number})`,
      `Request: ${prompt}`,
      `\nAvailable items not yet on this channel (${candidates.length} total):\n${summaryList}`,
      '\nSelect shows and movies that match the request. ALL episodes of selected shows will be added automatically.',
      '\nRespond with JSON: { "selections": [{ "type": "show"|"movie", "title": "exact title" }] }',
      'Be thorough: include every show and movie that fits.',
    ].join('\n');

    const response = await this.adapter.complete(
      [
        {
          role: 'system',
          content: 'You are a TV channel curator. Add programs to channels based on specific requests.',
        },
        { role: 'user', content: userMsg },
      ],
      { responseFormat: 'json', temperature: 0.5 },
    );

    let parsed: {
      selections?: { type: 'show' | 'movie'; title: string }[];
    };
    try {
      parsed = JSON.parse(response);
    } catch {
      return { newProgramUuids: [], warnings: [], error: 'LLM returned invalid JSON' };
    }

    const selections = parsed.selections ?? [];
    const resolved = await this.ctx.expandSelections(selections, existingSet);

    return {
      newProgramUuids: resolved.map((r) => r.uuid),
      warnings: [],
    };
  }
}
