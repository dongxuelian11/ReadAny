import { describe, expect, it } from "vitest";
import {
  type InstalledBookSkill,
  askAcrossBooks,
  buildBookAnswerPrompt,
  buildSynthesisPrompt,
  routeSkills,
  selectChaptersForQuestion,
  tokenizeQuestion,
} from "./cross-book";

const SKILL_MD_A = `---
name: bogle-investing
description: Index investing and long-term portfolio principles.
when_to_use: asset allocation, fees, market timing
---

# The Little Book of Common Investing

## Book Thesis
Stay the course.

## Concept Map
### Core Frameworks (nodes)
- **Costs Matter** — fees compound against you · ch01

## Topic Index
- **费用 fees** → ch01, ch03
- **资产配置 asset allocation** → ch02
`;

const SKILL_MD_B = `---
name: housel-psychology
description: Psychology of money and investor behaviour.
when_to_use: risk, greed, savings behaviour
---

# The Psychology of Money

## Book Thesis
Behaviour beats models.

## Concept Map
### Core Frameworks (nodes)
- **Risk Is What You Feel** — perceived vs actual risk · ch03

## Topic Index
- **风险 risk** → ch03
- **储蓄 savings** → ch01
`;

function skill(
  slug: string,
  skillMd: string,
  chapters: InstalledBookSkill["chapters"] = [],
): InstalledBookSkill {
  return { bookId: `book-${slug}`, slug, title: slug, skillMd, chapters };
}

describe("deterministic question routing", () => {
  it("tokenizes latin words and CJK bigrams", () => {
    expect(tokenizeQuestion("What do my books say about fees?")).toContain("fees");
    const tokens = tokenizeQuestion("费用与风险");
    expect(tokens).toContain("费用");
    expect(tokens).toContain("风险");
  });

  it("routes by distinct token hits over title/description/when_to_use/topic index", () => {
    const skills = [skill("bogle", SKILL_MD_A), skill("housel", SKILL_MD_B)];
    const { matched, broadcast } = routeSkills(skills, "费用 fees 与资产配置 asset allocation");
    expect(broadcast).toBe(false);
    expect(matched[0].slug).toBe("bogle"); // fees + asset allocation both hit
  });

  it("broadcasts to all skills when nothing matches", () => {
    const skills = [skill("bogle", SKILL_MD_A), skill("housel", SKILL_MD_B)];
    const { matched, broadcast } = routeSkills(skills, "量子纠缠与甜面酱 quantum entanglement");
    expect(broadcast).toBe(true);
    expect(matched).toHaveLength(2);
  });

  it("selects chapter toolkits whose topic-index lines hit the question, bounded", () => {
    const bogle = skill("bogle", SKILL_MD_A, [
      { bookNumber: "ch01", title: "Costs Matter", toolkit: "costs toolkit" },
      { bookNumber: "ch02", title: "Allocation", toolkit: "allocation toolkit" },
      { bookNumber: "ch03", title: "Fees Deep Dive", toolkit: "fees toolkit" },
    ]);
    const selected = selectChaptersForQuestion(bogle, "费用 fees 到底吃掉多少收益");
    expect(selected.map((chapter) => chapter.bookNumber)).toEqual(["ch01", "ch03"]);
  });
});

describe("per-book grounded answers and synthesis", () => {
  it("builds a per-book prompt with citations contract and selected chapters", () => {
    const bogle = skill("bogle", SKILL_MD_A, [
      { bookNumber: "ch01", title: "Costs", toolkit: "costs toolkit" },
    ]);
    const prompt = buildBookAnswerPrompt({
      skill: bogle,
      question: "why do fees matter?",
      chapters: bogle.chapters,
    });
    expect(prompt.system).toContain('ONLY the book "bogle"');
    expect(prompt.system).toContain("[bogle book_number]");
    expect(prompt.system).toContain("OUT OF SCOPE");
    expect(prompt.user).toContain("costs toolkit");
  });

  it("fans out in parallel, drops OUT OF SCOPE reports, and synthesizes the rest", async () => {
    const skills = [skill("bogle", SKILL_MD_A), skill("housel", SKILL_MD_B)];
    const llm = {
      async complete(system: string, user: string) {
        if (system.includes("ONLY the book")) {
          if (user.includes("bogle")) {
            return "Fees compound against you [bogle ch01]. Stay the course [bogle ch03].";
          }
          return "OUT OF SCOPE";
        }
        if (system.includes("synthesize")) {
          expect(user).toContain("[bogle ch01]");
          expect(user).toContain("Fees compound against you");
          expect(user).not.toContain("OUT OF SCOPE");
          return "Fees matter [bogle ch01].";
        }
        throw new Error("unexpected prompt");
      },
    };
    const answer = await askAcrossBooks({
      skills,
      question: "随便聊聊 生命的意义 meaning of life",
      llm,
    });
    expect(answer.reports).toHaveLength(2);
    expect(answer.broadcast).toBe(true);
    expect(answer.droppedSlugs).toEqual(["housel"]);
    expect(answer.synthesis).toBe("Fees matter [bogle ch01].");
  });

  it("returns OUT OF SCOPE synthesis when every book refuses", async () => {
    const skills = [skill("bogle", SKILL_MD_A)];
    const llm = {
      async complete() {
        return "OUT OF SCOPE";
      },
    };
    const answer = await askAcrossBooks({ skills, question: "量子纠缠", llm });
    expect(answer.broadcast).toBe(true);
    expect(answer.synthesis).toBe("OUT OF SCOPE");
    expect(answer.droppedSlugs).toEqual(["bogle"]);
  });

  it("builds a synthesis prompt that braids and surfaces tensions", () => {
    const prompt = buildSynthesisPrompt({
      question: "timing vs holding",
      reports: [{ slug: "bogle", title: "Bogle", answer: "Never time [bogle ch02]." }],
    });
    expect(prompt.system).toContain("never a stack");
    expect(prompt.system).toContain("tensions");
    expect(prompt.user).toContain("[bogle ch02]");
  });

  it("fails closed on an empty shelf", async () => {
    await expect(
      askAcrossBooks({
        skills: [],
        question: "x",
        llm: {
          async complete() {
            return "";
          },
        },
      }),
    ).rejects.toThrow("at least one installed Book Skill");
  });
});
