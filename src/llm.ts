import Anthropic from "@anthropic-ai/sdk";
import process from "node:process";

export interface LlmCallOptions {
  system: string;
  systemCacheable?: boolean;
  user: string;
  /** Tighter ceiling — council votes are tiny JSON. */
  maxTokens?: number;
}

export interface LlmCallResult {
  text: string;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
}

export interface LlmProvider {
  call(opts: LlmCallOptions): Promise<LlmCallResult>;
}

export class AnthropicProvider implements LlmProvider {
  private client: Anthropic;
  constructor(
    private model: string = process.env.AR_LLM_MODEL || "claude-haiku-4-5",
    apiKey?: string,
  ) {
    this.client = new Anthropic(apiKey ? { apiKey } : {});
  }

  async call(opts: LlmCallOptions): Promise<LlmCallResult> {
    const systemBlock = opts.systemCacheable
      ? [{ type: "text" as const, text: opts.system, cache_control: { type: "ephemeral" as const } }]
      : opts.system;

    const resp = await this.client.messages.create({
      model: this.model,
      max_tokens: opts.maxTokens ?? 512,
      system: systemBlock as never,
      messages: [{ role: "user", content: opts.user }],
    });

    let text = "";
    for (const block of resp.content) {
      if (block.type === "text") text += block.text;
    }
    return {
      text,
      input_tokens: resp.usage.input_tokens,
      output_tokens: resp.usage.output_tokens,
      cache_read_tokens: (resp.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens,
      cache_write_tokens: (resp.usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens,
    };
  }
}

/**
 * Test/offline provider. Deterministic vote pattern based on a hash of the user prompt.
 * Use this in tests; in production, AnthropicProvider is the default.
 */
export class MockProvider implements LlmProvider {
  constructor(private fixed?: { vote: "A" | "B" | "C"; confidence?: number; reason?: string }) {}
  async call(opts: LlmCallOptions): Promise<LlmCallResult> {
    if (this.fixed) {
      return {
        text: JSON.stringify({
          vote: this.fixed.vote,
          confidence: this.fixed.confidence ?? 0.7,
          reason: this.fixed.reason ?? "mock vote",
        }),
      };
    }
    // Pseudo-deterministic distribution from prompt hash
    let h = 0;
    for (let i = 0; i < opts.user.length; i++) h = (h * 31 + opts.user.charCodeAt(i)) | 0;
    const vote = (["A", "B", "C"] as const)[Math.abs(h) % 3];
    const confidence = 0.55 + (Math.abs(h) % 40) / 100;
    return {
      text: JSON.stringify({ vote, confidence, reason: `mock vote based on hash ${h}` }),
    };
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
