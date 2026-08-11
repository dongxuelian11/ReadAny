const READBOX_QA_FAILURE_PREFIXES = ["调用 AI 失败：", "调用 AI 失败:", "错误：", "错误:"];

/**
 * Read-Box reports provider failures inside an HTTP-200 SSE stream. Keep that
 * upstream behavior out of canonical answers by turning it back into an error.
 */
export function assertReadBoxQaAnswer(answer: string): string {
  const normalized = answer.trim();
  if (!normalized) throw new Error("Read-Box QA returned an empty answer");

  const prefix = READBOX_QA_FAILURE_PREFIXES.find((candidate) => normalized.startsWith(candidate));
  if (prefix) {
    const detail = normalized.slice(prefix.length).trim();
    throw new Error(`Read-Box QA failed: ${detail || normalized}`);
  }

  return answer;
}
