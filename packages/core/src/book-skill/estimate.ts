// Pre-flight cost estimate following the upstream Step 4 formula (MIT):
//   Input  ≈ estimated_total_tokens × 1.4   (chapter reads + spine fragments + prompts)
//   Output ≈ chapter_count × 1,100 + 9,000  (chapter files + SKILL.md + manifest)
// This slice has no nutshell/practice stages, so their surcharges are omitted.

import { estimateTokens } from "./response";

export interface BookSkillCostEstimate {
  chapterCount: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
}

export function estimateBookSkillCost(
  chapters: Array<{ title: string; content: string }>,
): BookSkillCostEstimate {
  const chapterCount = chapters.length;
  const totalTextTokens = chapters.reduce((sum, c) => sum + estimateTokens(c.content), 0);
  const spineFragments = chapterCount * Math.ceil(1000 / 4);
  const estimatedInputTokens = Math.ceil(totalTextTokens * 1.4) + spineFragments;
  const estimatedOutputTokens = chapterCount * 1100 + 9000;
  return { chapterCount, estimatedInputTokens, estimatedOutputTokens };
}
