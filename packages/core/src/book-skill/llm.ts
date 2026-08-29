// aiConfig -> BookSkillLlmClient factory. Uses the existing unified model
// gateway (createChatModel, non-streaming) so every configured provider works
// — DeepSeek first, and also Anthropic / Google / OpenAI / custom endpoints —
// keeping the pipeline model-independent (PR-001's Read-Box worker was limited
// to OpenAI-compatible endpoints; this port is not).

import { createChatModel } from "../ai/llm-provider";
import type { AIConfig } from "../types/chat";
import type { BookSkillLlmClient } from "./types";

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .join("");
  }
  return "";
}

export interface BookSkillClientOptions {
  temperature?: number;
  maxTokens?: number;
}

export async function createBookSkillLlmClient(
  config: AIConfig,
  options: BookSkillClientOptions = {},
): Promise<BookSkillLlmClient> {
  const model = await createChatModel(config, {
    streaming: false,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
  });
  return {
    async complete(system: string, user: string): Promise<string> {
      const response = await model.invoke([
        { role: "system", content: system },
        { role: "user", content: user },
      ]);
      const text = extractText(response.content).trim();
      if (!text) {
        throw new Error("The model returned an empty completion");
      }
      return text;
    },
  };
}
