import { injectable, inject } from 'inversify';
import { AnthropicAdapter } from './AnthropicAdapter.js';
import { ContextBuilder } from './ContextBuilder.js';
import type { AiRecommendation } from '@tunarr/types/schemas';

@injectable()
export class RecommendationEngine {
  constructor(
    @inject(AnthropicAdapter) private adapter: AnthropicAdapter,
    @inject(ContextBuilder) private ctx: ContextBuilder,
  ) {}

  async getRecommendations(
    channels: {
      id: string;
      number: number;
      name: string;
      programCount: number;
      durationHours: number;
      topShows: string[];
    }[],
  ): Promise<{ recommendations: AiRecommendation[] } | { error: string }> {
    const stats = await this.ctx.getStats();

    const channelSummary =
      channels.length > 0
        ? channels
            .map(
              (c) =>
                `#${c.number} "${c.name}" (${c.programCount} programs, ${c.durationHours}h, shows: ${c.topShows.join(', ')})`,
            )
            .join('\n')
        : '(no channels yet)';

    const userMsg = [
      'Analyze this library and channel setup. Suggest improvements.',
      `\nLibrary:\n${stats}`,
      `\nChannels:\n${channelSummary}`,
      '\nRespond with JSON: { "recommendations": [{ "type": "new-channel"|"schedule-improvement"|"content-addition"|"gap-analysis", "title": "...", "description": "...", "actionPrompt": "...", "targetChannel": number|null, "items": ["title1", "title2", ...] }] }',
      'For content-addition and schedule-improvement, targetChannel must be an existing channel number.',
      'For gap-analysis, include a list of specific items (titles) from the library that are underutilized.',
      'actionPrompt must include genre keywords (e.g. horror, comedy, drama) and specific show/movie titles in double quotes.',
      'Give 3-6 specific, actionable recommendations.',
    ].join('\n');

    const response = await this.adapter.complete(
      [
        {
          role: 'system',
          content: 'You are a TV programming consultant. Analyze channel lineups and suggest improvements.',
        },
        { role: 'user', content: userMsg },
      ],
      { responseFormat: 'json', temperature: 0.8 },
    );

    try {
      const parsed = JSON.parse(response) as {
        recommendations: AiRecommendation[];
      };
      return parsed;
    } catch {
      return { error: 'LLM returned invalid JSON' };
    }
  }
}
