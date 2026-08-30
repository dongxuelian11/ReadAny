import { describe, expect, it } from "vitest";
import { askAcrossBooks } from "./cross-book";
import type { InstalledBookSkill } from "./cross-book";
import { buildSemanticRoutingPrompt, routeSkillsSemantic } from "./semantic-routing";

const SKILL_MD_A = `---
name: bogle-investing
description: Index investing and long-term portfolio principles.
when_to_use: asset allocation, fees, market timing
---

# Investing Book

## Book Thesis
Stay the course.

## Topic Index
- **费用 fees** → ch01
`;

const SKILL_MD_B = `---
name: housel-psychology
description: Psychology of money and investor behaviour.
when_to_use: risk, greed, savings behaviour
---

# Psychology Book

## Book Thesis
Behaviour beats models.

## Topic Index
- **风险 risk** → ch03
`;

function skill(slug: string, skillMd: string): InstalledBookSkill {
  return { bookId: `book-${slug}`, slug, title: slug, skillMd, chapters: [] };
}

const SKILLS = [skill("bogle", SKILL_MD_A), skill("housel", SKILL_MD_B)];

function fakeLlm(replies: string[]): {
  complete: (system: string, user: string) => Promise<string>;
  calls: number;
} {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async complete(system: string) {
      const index = Math.min(calls, replies.length - 1);
      calls += 1;
      if (system.includes("route a question")) return replies[index];
      return "generic answer";
    },
  };
}

describe("semantic routing (LLM-assisted, frontmatter-only)", () => {
  it("uses the LLM to pick relevant slugs when semanticRouting is enabled", async () => {
    const llm = fakeLlm(['["bogle"]', "bogle answer", "braided answer"]);
    const answer = await askAcrossBooks({
      skills: SKILLS,
      question: "should I worry about fees?",
      llm,
      semanticRouting: true,
    });
    expect(llm.calls).toBeGreaterThanOrEqual(3); // 1 routing + 1 fan-out + 1 synthesis
    expect(answer.matchedSlugs).toEqual(["bogle"]);
    expect(answer.broadcast).toBe(false);
  });

  it("drops invented slugs and keeps only real ones", async () => {
    const llm = fakeLlm(['["bogle", "nonexistent-book"]', "bogle answer", "braided"]);
    const result = await routeSkillsSemantic(SKILLS, "fees question", llm);
    expect(result.inventedSlugs).toEqual(["nonexistent-book"]);
    expect(result.matched.map((entry) => entry.slug)).toEqual(["bogle"]);
    expect(result.semanticUsed).toBe(true);
  });

  it("falls back to keyword routing when the LLM parse fails twice", async () => {
    const llm = fakeLlm(["not json", "still not json", "unused"]);
    const result = await routeSkillsSemantic(SKILLS, "fees 费用", llm);
    expect(result.semanticUsed).toBe(false);
    expect(result.matched.map((entry) => entry.slug)).toEqual(["bogle"]); // keyword hit
    expect(result.broadcast).toBe(false);
  });

  it("falls back to keyword routing when the LLM returns zero valid slugs", async () => {
    const llm = fakeLlm(["[]", "unused"]);
    const result = await routeSkillsSemantic(SKILLS, "fees 费用", llm);
    // LLM parse succeeded (empty result) → keyword router takes over.
    // "fees" hits bogle's vocabulary → matched, not broadcast.
    expect(result.semanticUsed).toBe(true);
    expect(result.broadcast).toBe(false);
    expect(result.matched.map((entry) => entry.slug)).toEqual(["bogle"]);
  });

  it("falls back to keyword broadcast when the LLM returns zero valid slugs AND the keyword router has no hits", async () => {
    const llm = fakeLlm(["[]", "unused"]);
    const result = await routeSkillsSemantic(SKILLS, "量子纠缠 quantum entanglement", llm);
    expect(result.semanticUsed).toBe(true);
    expect(result.broadcast).toBe(true);
    expect(result.matched).toHaveLength(2);
  });

  it("does not use semantic routing by default (backwards compatible)", async () => {
    const llm = fakeLlm(['["bogle"]', "bogle answer", "braided"]);
    const answer = await askAcrossBooks({
      skills: SKILLS,
      question: "fees 费用",
      llm,
      // No semanticRouting flag
    });
    // Only keyword routing: 1 fan-out + 1 synthesis = 2 calls, no routing call.
    expect(llm.calls).toBe(2);
    expect(answer.matchedSlugs).toEqual(["bogle"]);
  });

  it("builds a prompt that only exposes frontmatter, never the SKILL.md body", () => {
    const prompt = buildSemanticRoutingPrompt({
      question: "test",
      skills: SKILLS,
    });
    expect(prompt.user).toContain("bogle");
    expect(prompt.user).toContain("Index investing");
    expect(prompt.user).not.toContain("## Topic Index");
    expect(prompt.user).not.toContain("## Book Thesis");
    expect(prompt.user).not.toContain("Stay the course");
  });
});
