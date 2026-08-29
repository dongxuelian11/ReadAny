// Deterministic renderers for the derived skill files, following the upstream
// master SKILL.md template (reference/concept-map-spec.md, MIT) and the Pass 0
// spine format. The Tier-1 content comes from the LLM as structured JSON; these
// renderers turn it into the upstream file formats so TKG tooling
// (lint_chapters.py, future routers) can consume the skill as-is.

import type { BookSkillManifest, BookSkillSpine, BookSkillTier1 } from "./types";

export function renderSpineMd(spine: BookSkillSpine, bookTitle: string, author?: string): string {
  const frameworks = spine.frameworks
    .map((f) => `- ${f.name} — ${f.summary}${f.approxChapter ? ` (≈ ${f.approxChapter})` : ""}`)
    .join("\n");
  return [
    `# Spine — ${bookTitle}${author ? ` by ${author}` : ""}`,
    "## Thesis",
    spine.thesis,
    "## Framework Inventory",
    frameworks || "- (none detected)",
    "## Domain & Vocabulary",
    `${spine.domain}. Distinctive terms: ${spine.vocabulary.join(", ")}.`,
  ].join("\n\n");
}

export function renderSkillMd(params: {
  tier1: BookSkillTier1;
  manifest: BookSkillManifest;
  bookTitle: string;
  author?: string;
}): string {
  const { tier1, manifest } = params;
  const chapterCount = manifest.chapters.length;
  const description = `Expert knowledge from "${params.bookTitle}" by ${
    params.author ?? "unknown"
  }. Use when applying the author's frameworks for ${tier1.triggerPhrases.slice(0, 6).join(", ")}.`;

  const nodes = tier1.nodes.map((n) => `- **${n.name}** — ${n.summary} · ${n.chapter}`).join("\n");
  const edges = tier1.edges.map((e) => `- **${e.from}** → ${e.relation} → **${e.to}**`).join("\n");
  const frameworks = tier1.coreFrameworks
    .map((f) => `### ${f.name}\n- **When to use**: ${f.whenToUse}\n- **How**: ${f.how}`)
    .join("\n\n");
  const chapterIndex = manifest.chapters
    .map(
      (c) =>
        `| [${c.book_number}](${c.file}) | ${c.title} | ${c.status === "failed" ? "—" : "toolkit"} |`,
    )
    .join("\n");
  const topicIndex = tier1.topicIndex
    .map((t) => `- **${t.term}** → ${t.chapters.join(", ")}`)
    .join("\n");

  return [
    "---",
    `name: ${manifest.skill_slug}`,
    `description: ${description.replace(/\n/g, " ")}`,
    `when_to_use: ${tier1.triggerPhrases.join(", ")}`,
    "argument-hint: [topic, framework name, or chapter number]",
    "---",
    "",
    `# ${params.bookTitle}`,
    `**Author**: ${params.author ?? "unknown"} | **Chapters**: ${chapterCount} | **Built**: ${manifest.built_at}`,
    "",
    "## Book Thesis",
    tier1.thesis,
    "",
    "## Concept Map",
    "### Core Frameworks (nodes)",
    nodes,
    "",
    "### Relationships (edges)",
    edges || "(none detected)",
    "",
    "## Core Frameworks & Mental Models",
    frameworks,
    "",
    "## Chapter Index",
    "| Chapter | Title | Detail |",
    "|---|-------|--------|",
    chapterIndex,
    "",
    "## Topic Index",
    topicIndex,
    "",
    "## Scope & Limits",
    tier1.scopeNote ?? "Covers the content of this book only.",
    "Tier-2 chapter toolkits live in chapters/ and are loaded on demand; the original chapter text is preserved under raw/.",
    "",
  ].join("\n");
}
