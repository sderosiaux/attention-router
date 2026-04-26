import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import process from "node:process";
import type { ZodType } from "zod";

export interface LlmCallOptions<T = unknown> {
  system: string;
  systemCacheable?: boolean;
  user: string;
  /** Tighter ceiling — council votes and rule extractions are tiny JSON. */
  maxTokens?: number;
  /**
   * If set, the SDK uses messages.parse() with output_config.format = zodOutputFormat(schema),
   * and the API enforces the schema. The result.parsed field is typed.
   * Supported on claude-haiku-4-5, claude-sonnet-4-6, claude-opus-4-7.
   */
  schema?: ZodType<T>;
}

export interface LlmCallResult<T = unknown> {
  text: string;
  /** Present iff `schema` was provided AND the API returned a valid parse. */
  parsed?: T;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
}

export interface LlmProvider {
  call<T = unknown>(opts: LlmCallOptions<T>): Promise<LlmCallResult<T>>;
}

export class AnthropicProvider implements LlmProvider {
  private client: Anthropic;
  constructor(
    private model: string = process.env.AR_LLM_MODEL || "claude-haiku-4-5",
    apiKey?: string,
  ) {
    this.client = new Anthropic(apiKey ? { apiKey } : {});
  }

  async call<T = unknown>(opts: LlmCallOptions<T>): Promise<LlmCallResult<T>> {
    const systemBlock = opts.systemCacheable
      ? [
          {
            type: "text" as const,
            text: opts.system,
            cache_control: { type: "ephemeral" as const },
          },
        ]
      : opts.system;

    const baseRequest = {
      model: this.model,
      max_tokens: opts.maxTokens ?? 512,
      system: systemBlock as never,
      messages: [{ role: "user" as const, content: opts.user }],
    };

    if (opts.schema) {
      const resp = await this.client.messages.parse({
        ...baseRequest,
        output_config: { format: zodOutputFormat(opts.schema) },
      });
      const text = collectText(resp.content);
      return {
        text,
        parsed: (resp.parsed_output ?? undefined) as T | undefined,
        ...usageOf(resp.usage),
      };
    }

    const resp = await this.client.messages.create(baseRequest);
    return {
      text: collectText(resp.content),
      ...usageOf(resp.usage),
    };
  }
}

function collectText(content: { type: string; text?: string }[]): string {
  let text = "";
  for (const b of content) {
    if (b.type === "text" && typeof b.text === "string") text += b.text;
  }
  return text;
}

function usageOf(u: {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): Pick<LlmCallResult, "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_write_tokens"> {
  return {
    input_tokens: u.input_tokens ?? undefined,
    output_tokens: u.output_tokens ?? undefined,
    cache_read_tokens: u.cache_read_input_tokens ?? undefined,
    cache_write_tokens: u.cache_creation_input_tokens ?? undefined,
  };
}

/**
 * Test/offline provider. Honors `schema` by returning a deterministic parsed value
 * (either fixed via constructor or hash-based) so callers can rely on .parsed in tests.
 */
export class MockProvider implements LlmProvider {
  constructor(private fixed?: unknown) {}
  async call<T>(opts: LlmCallOptions<T>): Promise<LlmCallResult<T>> {
    const value =
      this.fixed ??
      // Sensible default for council votes
      ({ vote: "A", confidence: 0.7, reason: "mock vote" } as unknown);

    const text = JSON.stringify(value);
    return opts.schema
      ? { text, parsed: value as T }
      : { text };
  }
}

export function defaultProvider(): LlmProvider {
  if (process.env.AR_LLM_MODE === "mock") return new MockProvider();
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn(
      "[council] ANTHROPIC_API_KEY not set; using MockProvider. Set AR_LLM_MODE=mock to silence this warning.",
    );
    return new MockProvider();
  }
  return new AnthropicProvider();
}
