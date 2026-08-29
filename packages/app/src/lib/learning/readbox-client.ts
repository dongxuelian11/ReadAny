import { useLearningStore } from "@/stores/learning-store";
import {
  assertReadBoxQaAnswer,
  createLearningCitation,
  findQuotedEvidence,
  normalizeDerivedChapterText,
} from "@readany/core/learning";
import type {
  LearningDigest,
  LearningQuizJudgement,
  LearningQuizQuestion,
  LearningSourceRef,
  ReadBoxBinding,
} from "@readany/core/learning";
import type { AIConfig } from "@readany/core/types";
import { resolveProviderBaseUrl } from "@readany/core/utils";
import { invoke } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

export const READBOX_REF = "15f766f19f1ab204535f1947983fa397540352c8";

const OPENAI_COMPATIBLE_PROVIDERS = new Set([
  "openai",
  "deepseek",
  "openrouter",
  "siliconflow",
  "moonshot",
  "zhipu",
  "aliyun",
  "volces",
  "baichuan",
  "minimax",
  "groq",
  "together",
  "fireworks",
  "xai",
  "mistral",
  "perplexity",
  "aihubmix",
  "custom",
]);

export interface ReadBoxRuntimeSnapshot {
  status: "idle" | "starting" | "ready" | "unavailable" | "stopped";
  port?: number;
  upstreamRef: string;
  error?: string;
}

export interface ReadBoxSession {
  baseUrl: string;
  runtime: ReadBoxRuntimeSnapshot;
}

interface ReadBoxImportedBook {
  book_id: number;
  status: string;
}

interface ReadBoxChapter {
  id: number;
}

interface ReadBoxDigestResponse {
  summary: string;
  concepts: Array<{ term: string; explanation: string }>;
  quotes: Array<{ quote: string; reason: string }>;
}

interface ReadBoxQuizStartResponse {
  questions: LearningQuizQuestion[];
}

function activeModelConfig(aiConfig: AIConfig) {
  const endpoint = aiConfig.endpoints.find(
    (candidate) => candidate.id === aiConfig.activeEndpointId,
  );
  if (!endpoint || !aiConfig.activeModel) {
    throw new Error("Configure an active AI endpoint and model in ReadAny Settings");
  }
  if (!OPENAI_COMPATIBLE_PROVIDERS.has(endpoint.provider) || endpoint.useExactRequestUrl) {
    throw new Error("The Read-Box slice currently requires an OpenAI-compatible ReadAny endpoint");
  }
  if (!endpoint.apiKey.trim()) {
    throw new Error("The active ReadAny AI endpoint has no API key");
  }

  const apiBase = resolveProviderBaseUrl(endpoint.provider, endpoint.baseUrl);
  if (!apiBase) throw new Error("The active ReadAny AI endpoint has no valid base URL");

  return {
    apiKey: endpoint.apiKey,
    apiBase,
    model: aiConfig.activeModel,
    maxTokens: aiConfig.maxTokens,
    temperature: aiConfig.temperature,
  };
}

export async function startReadBoxWorker(aiConfig: AIConfig): Promise<ReadBoxSession> {
  const runtime = await invoke<ReadBoxRuntimeSnapshot>("readbox_start", {
    config: activeModelConfig(aiConfig),
  });
  if (runtime.status !== "ready" || !runtime.port) {
    throw new Error(runtime.error || "Read-Box worker is unavailable");
  }
  if (runtime.upstreamRef !== READBOX_REF) {
    throw new Error(`Read-Box runtime ref mismatch: ${runtime.upstreamRef}`);
  }
  return { runtime, baseUrl: `http://127.0.0.1:${runtime.port}` };
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await tauriFetch(url, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Read-Box request failed (${response.status}): ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as T;
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function bindingIsLive(baseUrl: string, binding: ReadBoxBinding): Promise<boolean> {
  if (binding.upstreamRef !== READBOX_REF) return false;
  try {
    const response = await tauriFetch(`${baseUrl}/api/books/${binding.derivedReadBoxBookId}`);
    return response.ok;
  } catch {
    return false;
  }
}

export async function ensureReadBoxBinding(
  session: ReadBoxSession,
  source: LearningSourceRef,
): Promise<ReadBoxBinding> {
  const chapterText = normalizeDerivedChapterText(source);
  if (!chapterText) throw new Error("The current ReadAny chapter has no text to synchronize");
  const syncVersion = await sha256(`${READBOX_REF}\n${source.title}\n${chapterText}`);
  const store = useLearningStore.getState();
  const existing = store.getBinding(source.readAnyBookId, source.readAnyChapterId);

  if (existing?.syncVersion === syncVersion && (await bindingIsLive(session.baseUrl, existing))) {
    return existing;
  }

  if (existing && (await bindingIsLive(session.baseUrl, existing))) {
    await tauriFetch(`${session.baseUrl}/api/books/${existing.derivedReadBoxBookId}`, {
      method: "DELETE",
    }).catch(() => undefined);
  }

  const safeId = `${source.readAnyBookId}-${source.readAnyChapterId}`.replace(
    /[^a-zA-Z0-9_-]/g,
    "-",
  );
  const form = new FormData();
  form.append(
    "file",
    new Blob([chapterText], { type: "text/plain;charset=utf-8" }),
    `readany-${safeId}-${syncVersion.slice(0, 12)}.txt`,
  );
  const imported = await requestJson<ReadBoxImportedBook>(`${session.baseUrl}/api/books/import`, {
    method: "POST",
    body: form,
  });
  if (imported.status !== "completed") throw new Error("Read-Box did not complete derived import");

  const chapters = await requestJson<ReadBoxChapter[]>(
    `${session.baseUrl}/api/books/${imported.book_id}/chapters`,
  );
  if (chapters.length !== 1) {
    throw new Error(`Expected one derived Read-Box chapter, received ${chapters.length}`);
  }

  const binding: ReadBoxBinding = {
    upstreamRef: READBOX_REF,
    readAnyBookId: source.readAnyBookId,
    readAnyChapterId: source.readAnyChapterId,
    derivedReadBoxBookId: imported.book_id,
    derivedReadBoxChapterId: chapters[0].id,
    syncVersion,
  };
  store.setBinding(binding);
  return binding;
}

export async function createDigest(
  session: ReadBoxSession,
  binding: ReadBoxBinding,
  source: LearningSourceRef,
): Promise<LearningDigest> {
  const started = await requestJson<{ status: string }>(
    `${session.baseUrl}/api/digest/${binding.derivedReadBoxBookId}/chapters/${binding.derivedReadBoxChapterId}`,
    { method: "POST" },
  );
  if (started.status !== "completed") throw new Error(`Read-Box digest status: ${started.status}`);
  const digest = await requestJson<ReadBoxDigestResponse>(
    `${session.baseUrl}/api/digest/${binding.derivedReadBoxBookId}/chapters/${binding.derivedReadBoxChapterId}`,
  );
  return {
    summary: digest.summary,
    concepts: digest.concepts,
    quotes: digest.quotes.map((quote) => ({
      ...quote,
      citation: createLearningCitation(source, quote.quote),
    })),
  };
}

async function consumeSse(response: Response, onChunk: (chunk: string) => void): Promise<string> {
  if (!response.ok) throw new Error(`Read-Box QA failed (${response.status})`);
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";

  const consumeEvents = (flush = false) => {
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = flush ? "" : blocks.pop() || "";
    for (const block of blocks) {
      const line = block.split(/\r?\n/).find((candidate) => candidate.startsWith("data:"));
      if (!line) continue;
      const payload = JSON.parse(line.slice(5).trim()) as { t?: string };
      if (!payload.t || payload.t === "[DONE]") continue;
      answer += payload.t;
      onChunk(payload.t);
    }
  };

  if (!reader) {
    buffer = await response.text();
    buffer += "\n\n";
    consumeEvents(true);
    return answer;
  }

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    if (done) {
      buffer += "\n\n";
      consumeEvents(true);
      break;
    }
    consumeEvents();
  }
  return answer;
}

export async function askReadBox(
  session: ReadBoxSession,
  binding: ReadBoxBinding,
  source: LearningSourceRef,
  question: string,
  onChunk: (chunk: string) => void,
) {
  const response = await tauriFetch(
    `${session.baseUrl}/api/qa/${binding.derivedReadBoxBookId}/ask`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question }),
    },
  );
  const answer = await consumeSse(response, onChunk);
  assertReadBoxQaAnswer(answer);
  return {
    answer,
    citations: [createLearningCitation(source, findQuotedEvidence(answer))],
  };
}

export async function startQuiz(session: ReadBoxSession, binding: ReadBoxBinding) {
  const started = await requestJson<ReadBoxQuizStartResponse>(
    `${session.baseUrl}/api/quiz/${binding.derivedReadBoxBookId}/start`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chapter_id: binding.derivedReadBoxChapterId,
        count: 1,
        mode: "chapter",
      }),
    },
  );
  if (!started.questions.length) throw new Error("Read-Box returned no quiz question");
  const first = await requestJson<{ question?: LearningQuizQuestion; done?: boolean }>(
    `${session.baseUrl}/api/quiz/${binding.derivedReadBoxBookId}/next`,
  );
  if (first.done || !first.question)
    throw new Error("Read-Box quiz could not activate its first question");
  return [first.question];
}

export async function answerQuiz(
  session: ReadBoxSession,
  binding: ReadBoxBinding,
  question: LearningQuizQuestion,
  answer: string,
): Promise<LearningQuizJudgement> {
  const result = await requestJson<{
    correct: boolean;
    explanation: string;
    current: number;
    total: number;
    correct_count: number;
  }>(`${session.baseUrl}/api/quiz/${binding.derivedReadBoxBookId}/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question, answer }),
  });
  return {
    correct: result.correct,
    explanation: result.explanation,
    current: result.current,
    total: result.total,
    correctCount: result.correct_count,
  };
}

export async function finishQuiz(
  session: ReadBoxSession,
  binding: ReadBoxBinding,
): Promise<boolean> {
  const next = await requestJson<{ done?: boolean }>(
    `${session.baseUrl}/api/quiz/${binding.derivedReadBoxBookId}/next`,
  );
  return next.done === true;
}
