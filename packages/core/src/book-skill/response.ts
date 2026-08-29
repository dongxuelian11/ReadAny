// LLM response boundary for the Book Skill pipeline, mirroring the discipline
// of the PR-001 Read-Box response boundary: provider failures embedded in
// HTTP-200-ish text, chatty preambles, and malformed JSON must never leak into
// derived skill files.

export class BookSkillResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookSkillResponseError";
  }
}

const FAILURE_MARKERS = [
  /调用\s*AI\s*失败/,
  /^错误[:：]/,
  /rate\s*limit/i,
  /insufficient\s*(?:quota|balance)/i,
  /invalid\s*api\s*key/i,
  /model\s*overloaded/i,
  /i\s*(?:can'?t|cannot)\s+assist/i,
];

export function looksLikeFailureText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return FAILURE_MARKERS.some((re) => re.test(trimmed));
}

/** Extract and parse a JSON object from a model reply (fenced or bare). */
export function parseJsonResponse<T>(text: string): T {
  if (looksLikeFailureText(text)) {
    throw new BookSkillResponseError("The model reply looks like a failure message, not content");
  }
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1].trim());
  const candidates = [...fenced, extractBalancedJsonObject(text)].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // try the next candidate
    }
  }
  throw new BookSkillResponseError("No parsable JSON object found in the model reply");
}

function extractBalancedJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Validate and normalise a Stage 1 chapter toolkit. Strips any chatty
 * preamble before the first markdown heading and enforces the chapter
 * template's structural contract (upstream lint_chapters.py checks the same
 * headings on the file afterwards).
 */
export function assertChapterToolkit(raw: string, bookNumber: string): string {
  if (looksLikeFailureText(raw)) {
    throw new BookSkillResponseError(`Toolkit for ${bookNumber} looks like a failure message`);
  }
  const firstHeading = raw.indexOf("#");
  const text = firstHeading > 0 ? raw.slice(firstHeading).trim() : raw.trim();
  if (!text.startsWith("#")) {
    throw new BookSkillResponseError(`Toolkit for ${bookNumber} has no markdown heading`);
  }
  const lower = text.toLowerCase();
  if (!lower.includes("## core idea")) {
    throw new BookSkillResponseError(`Toolkit for ${bookNumber} is missing the Core Idea section`);
  }
  if (!lower.includes("frameworks") && !lower.includes("key takeaways")) {
    throw new BookSkillResponseError(
      `Toolkit for ${bookNumber} is missing both the Frameworks and Key Takeaways sections`,
    );
  }
  return text;
}

/** CJK-aware word estimate: latin whitespace words + CJK characters. */
export function countWords(text: string): number {
  const latin = (text.match(/[A-Za-z0-9]+(?:[''-][A-Za-z0-9]+)*/g) ?? []).length;
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  return latin + cjk;
}

/**
 * Token estimate following upstream's chars/4 heuristic for latin text, with
 * an honest 1 token per CJK character (upstream's chars/4 underestimates
 * Chinese by roughly 4x).
 */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const rest = text.length - cjk;
  return Math.ceil(rest / 4) + cjk;
}
