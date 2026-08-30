// PR-011 Semantic routing — the TKG upstream routing behaviour: ONE LLM call
// reads each skill's frontmatter (name/description/when_to_use ONLY, never the
// domain SKILL.md body) alongside the question and picks the relevant slugs.
// Validated fail-closed against the real slug list; the deterministic keyword
// router (routeSkills) is the fallback when the parse fails or zero slugs
// survive. The upstream "No matches → broadcast to all" behaviour is preserved
// via routeSkills' broadcast.

import type { GoalLlmClient } from "../learner/goal-parse";
import type { InstalledBookSkill } from "./cross-book";
import { routeSkills } from "./cross-book";

export function buildSemanticRoutingPrompt(params: {
  question: string;
  skills: InstalledBookSkill[];
}): { system: string; user: string } {
  const frontmatters = params.skills
    .map((skill) => {
      const description = /^description:\s*(.+)$/m.exec(skill.skillMd)?.[1] ?? "";
      const whenToUse = /^when_to_use:\s*(.+)$/m.exec(skill.skillMd)?.[1] ?? "";
      return `- ${skill.slug}: ${skill.title} — ${description} | when_to_use: ${whenToUse}`;
    })
    .join("\n");
  const system = [
    "You route a question to the relevant books on a shelf, using ONLY each book's frontmatter (title, description, when_to_use).",
    "Do NOT read or guess beyond the frontmatter. If no book is relevant, return an empty array.",
    "Return STRICT JSON only, no prose, with this shape:",
    '["slug1", "slug2"]',
    "Pick the SMALLEST set of books that genuinely serve the question.",
  ].join("\n");
  const user = `Question: ${params.question}\n\nAvailable books:\n${frontmatters}`;
  return { system, user };
}

export interface SemanticRoutingResult {
  matched: InstalledBookSkill[];
  broadcast: boolean;
  /** Slugs the model invented that don't exist on the shelf (dropped). */
  inventedSlugs: string[];
  /** True when the LLM parse succeeded (even if it returned zero slugs → keyword fallback kicked in). */
  semanticUsed: boolean;
}

/** Route via one LLM call reading frontmatter only; fail-closed to the
 * deterministic keyword router (including its broadcast) on any failure. */
export async function routeSkillsSemantic(
  skills: InstalledBookSkill[],
  question: string,
  llm: GoalLlmClient,
): Promise<SemanticRoutingResult> {
  if (skills.length === 0) {
    return { matched: [], broadcast: false, inventedSlugs: [], semanticUsed: false };
  }
  const prompt = buildSemanticRoutingPrompt({ question, skills });
  let parsed: unknown;
  let parseSucceeded = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // The routing reply is a JSON ARRAY of slugs (not an object), so we
      // parse it directly rather than via parseJsonResponse (which only
      // extracts {…} objects).
      const raw = await llm.complete(prompt.system, prompt.user);
      const candidate = raw
        .trim()
        .replace(/^```(?:json)?\s*\n?/, "")
        .replace(/\n?```\s*$/, "");
      parsed = JSON.parse(candidate);
      parseSucceeded = true;
      break;
    } catch {
      // retry
    }
  }
  if (!parseSucceeded) {
    const fallback = routeSkills(skills, question);
    return { ...fallback, inventedSlugs: [], semanticUsed: false };
  }

  const realSlugs = new Map(skills.map((skill) => [skill.slug, skill]));
  const inventedSlugs: string[] = [];
  const matched: InstalledBookSkill[] = [];
  for (const slug of Array.isArray(parsed) ? parsed : []) {
    if (typeof slug !== "string") continue;
    const skill = realSlugs.get(slug);
    if (!skill) {
      inventedSlugs.push(slug);
      continue;
    }
    if (!matched.some((entry) => entry.slug === slug)) {
      matched.push(skill);
    }
  }
  if (matched.length === 0) {
    // Model returned zero or only invented slugs → deterministic fallback
    // (which includes broadcast-on-no-hit).
    const fallback = routeSkills(skills, question);
    return { ...fallback, inventedSlugs, semanticUsed: true };
  }
  return { matched, broadcast: false, inventedSlugs, semanticUsed: true };
}
