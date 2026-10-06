import Anthropic from '@anthropic-ai/sdk';
import { LoggerFactory } from '@/util/logging/LoggerFactory.js';
import { injectable, inject } from 'inversify';
import { AiSettingsDB } from './AiSettingsDB.js';

const logger = LoggerFactory.child({
  caller: import.meta,
  className: 'AnthropicAdapter',
});

interface CompleteOptions {
  responseFormat?: 'json' | 'text';
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

@injectable()
export class AnthropicAdapter {
  constructor(@inject(AiSettingsDB) private settingsDB: AiSettingsDB) {}

  async complete(
    messages: ChatMessage[],
    opts: CompleteOptions = {},
  ): Promise<string> {
    const settings = await this.settingsDB.get();
    if (!settings.apiKey) throw new Error('Anthropic API key not configured');

    // maxRetries: the Whatbox box drops many connections to api.anthropic.com (2026-09-23),
    // and the SDK default of 2 retries gave up on most channel builds.
    const client = new Anthropic({ apiKey: settings.apiKey, maxRetries: 8 });

    const systemMessages = messages.filter((m) => m.role === 'system');
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');
    const systemText = systemMessages.map((m) => m.content).join('\n');

    const maxTokens = opts.responseFormat === 'json' ? 16384 : 4096;
    const response = await client.messages.create({
      model: settings.model,
      max_tokens: maxTokens,
      system: systemText || undefined,
      messages: nonSystemMessages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    });

    // Newer models can lead with a thinking block; take the first text block.
    const block = response.content.find((b) => b.type === 'text');
    if (!block || block.type !== 'text') throw new Error('Unexpected response type');
    let text = block.text;

    if (opts.responseFormat === 'json') {
      text = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        text = match[0];
      }
    }

    return text;
  }

  async test(): Promise<{ ok: boolean; model: string; error?: string }> {
    try {
      const settings = await this.settingsDB.get();
      if (!settings.apiKey) return { ok: false, model: '', error: 'No API key' };

      // maxRetries: the Whatbox box drops many connections to api.anthropic.com (2026-09-23),
      // and the SDK default of 2 retries gave up on most channel builds.
      const client = new Anthropic({ apiKey: settings.apiKey, maxRetries: 8 });
      await client.messages.create({
        model: settings.model,
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Say "ok"' }],
      });
      return { ok: true, model: settings.model };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error('AI connection test failed: %s', msg);
      return { ok: false, model: '', error: msg };
    }
  }
}
