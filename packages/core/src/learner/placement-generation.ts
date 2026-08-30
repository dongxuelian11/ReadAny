// Placement item generation — the LLM is a content co-processor ONLY: it
// writes the question text/options/explanation for a deterministically assigned
// difficulty layer; layer assignment, Bloom->difficulty mapping, validation,
// and pool assembly are pure. Items must be answerable WITHOUT reading the
// book — placement measures prior knowledge (the 摸底 contract).

import { parseJsonResponse } from "../book-skill/response";
import {
  LAYER_BLOOM,
  type PlacementConcept,
  type PlacementItem,
  type PlacementLayer,
  bloomToDifficulty,
} from "./placement";

/** Minimal completion surface — structurally satisfied by the app's unified
 * gateway client (createBookSkillLlmClient). */
export interface PlacementLlmClient {
  complete(system: string, user: string): Promise<string>;
}

export interface PlacementItemDraft {
  prompt: string;
  options: string[];
  correctIndex: number;
  explanation: string;
}

const LAYER_RULES: Record<PlacementLayer, string> = {
  1: "recall — tests whether the learner already knows the basic fact or definition",
  2: "application — tests whether the learner can already apply the idea to a small concrete situation",
  3: "trap — tests whether the learner avoids the misconception most beginners fall into",
};

function layerForIndex(index: number): PlacementLayer {
  return ((index % 3) + 1) as PlacementLayer;
}

export function buildPlacementGenerationPrompt(params: {
  bookTitle: string;
  concept: PlacementConcept;
  layer: PlacementLayer;
}): { system: string; user: string } {
  const bloom = LAYER_BLOOM[params.layer];
  const system = [
    "You write ONE diagnostic multiple-choice question that measures whether someone ALREADY knows a topic — before they study it.",
    "The question must be answerable on its own, WITHOUT reading the book it belongs to.",
    "Write the question, options, and explanation in the SAME LANGUAGE as the chapter title.",
    "Exactly 4 options. Exactly ONE correct option. The three distractors must be plausible misconceptions, not nonsense.",
    "Do not reveal the answer inside the question or options.",
    "Return STRICT JSON only, no prose, with this shape:",
    "{",
    '  "prompt": "the question text",',
    '  "options": ["option A", "option B", "option C", "option D"],',
    '  "correctIndex": 0,',
    '  "explanation": "one or two sentences: why the correct option is right and the key distractor is wrong"',
    "}",
  ].join("\n");
  const user = [
    `Book topic: ${params.bookTitle}`,
    `Chapter (the concept being probed): ${params.concept.title}`,
    `Required difficulty: ${params.layer} — ${LAYER_RULES[params.layer]} (Bloom level ${bloom}).`,
  ].join("\n");
  return { system, user };
}

/** Validate a model draft against the deterministic contract. */
export function validatePlacementDraft(draft: unknown): PlacementItemDraft {
  const d = draft as Partial<PlacementItemDraft>;
  if (typeof d.prompt !== "string" || !d.prompt.trim() || d.prompt.length > 500) {
    throw new Error("Placement draft prompt is missing or too long");
  }
  if (
    !Array.isArray(d.options) ||
    d.options.length !== 4 ||
    d.options.some((o) => typeof o !== "string" || !o.trim())
  ) {
    throw new Error("Placement draft must have exactly 4 non-empty options");
  }
  if (
    !Number.isInteger(d.correctIndex) ||
    (d.correctIndex as number) < 0 ||
    (d.correctIndex as number) > 3
  ) {
    throw new Error("Placement draft correctIndex must be an integer in [0, 3]");
  }
  if (typeof d.explanation !== "string" || !d.explanation.trim()) {
    throw new Error("Placement draft explanation is missing");
  }
  return {
    prompt: d.prompt.trim(),
    options: (d.options as string[]).map((o) => o.trim()),
    correctIndex: d.correctIndex as number,
    explanation: d.explanation.trim(),
  };
}

export interface GeneratePlacementItemsOptions {
  bookTitle: string;
  concepts: PlacementConcept[];
  llm: PlacementLlmClient;
  /** Deterministic id prefix (e.g. the session id); items get `${prefix}:${index}`. */
  idPrefix: string;
}

/**
 * Generate the placement pool: one item per concept, layer assigned
 * deterministically by concept order (recall/application/trap rotation) so the
 * pool covers the difficulty range. A concept whose generation fails after one
 * retry is skipped; a pool below the CAT minimum is the caller's fail-closed
 * signal.
 */
export async function generatePlacementItems(
  options: GeneratePlacementItemsOptions,
): Promise<PlacementItem[]> {
  const items: PlacementItem[] = [];
  for (let index = 0; index < options.concepts.length; index += 1) {
    const concept = options.concepts[index];
    const layer = layerForIndex(index);
    const bloom = LAYER_BLOOM[layer];
    const prompt = buildPlacementGenerationPrompt({ bookTitle: options.bookTitle, concept, layer });
    let draft: PlacementItemDraft | null = null;
    for (let attempt = 0; attempt < 2 && draft === null; attempt += 1) {
      try {
        draft = validatePlacementDraft(
          parseJsonResponse<unknown>(await options.llm.complete(prompt.system, prompt.user)),
        );
      } catch {
        draft = null;
      }
    }
    if (!draft) continue;
    items.push({
      id: `${options.idPrefix}:${index}`,
      conceptId: concept.conceptId,
      conceptTitle: concept.title,
      prompt: draft.prompt,
      options: draft.options,
      correctIndex: draft.correctIndex,
      explanation: draft.explanation,
      layer,
      bloomLevel: bloom,
      difficulty: bloomToDifficulty(bloom),
    });
  }
  return items;
}
