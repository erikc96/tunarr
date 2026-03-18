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
  temperature?: number;
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

    const client = new Anthropic({ apiKey: settings.apiKey });

    const systemMessages = messages.filter((m) => m.role === 'system');
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');
    const systemText = systemMessages.map((m) => m.content).join('\n');

    const maxTokens = opts.responseFormat === 'json' ? 16384 : 4096;
    const response = await client.messages.create({
      model: settings.model,
      max_tokens: maxTokens,
      temperature: opts.temperature ?? 0.7,
      system: systemText || undefined,
      messages: nonSystemMessages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    });

    const block = response.content[0];
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

      const client = new Anthropic({ apiKey: settings.apiKey });
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
