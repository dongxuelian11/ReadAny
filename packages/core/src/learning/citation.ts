import type { LearningCitation, LearningSourceRef } from "./types";

function normalize(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function excerpt(value: string, limit = 220): string {
  const clean = normalize(value);
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
}

export function normalizeDerivedChapterText(source: LearningSourceRef): string {
  return normalize(source.text);
}

export function findQuotedEvidence(answer: string): string | undefined {
  const matches = Array.from(answer.matchAll(/[“「『"]([^”」』"]{6,240})[”」』"]/gu), (match) =>
    normalize(match[1] || ""),
  ).filter(Boolean);
  return matches.sort((left, right) => right.length - left.length)[0];
}

export function createLearningCitation(
  source: LearningSourceRef,
  evidenceText?: string,
): LearningCitation {
  const evidence = normalize(evidenceText || "");
  const matchingPassage = evidence
    ? source.passages.find((passage) => {
        const text = normalize(passage.text);
        return text.includes(evidence) || evidence.includes(text);
      })
    : undefined;

  const fallbackPassage = source.passages.find((passage) => passage.text.trim());
  const passage = matchingPassage || fallbackPassage;
  const exactPassage = Boolean(matchingPassage?.cfi);

  return {
    sourceType: "BOOK",
    readAnyBookId: source.readAnyBookId,
    readAnyChapterId: source.readAnyChapterId,
    canonicalLocation: {
      chapterIndex: source.location.chapterIndex,
      chapterHref: source.location.chapterHref,
      ...(exactPassage
        ? { cfi: matchingPassage?.cfi }
        : source.location.cfi
          ? { cfi: source.location.cfi }
          : {}),
    },
    displayExcerpt: excerpt(evidence || passage?.text || source.text),
    precision: exactPassage ? "PASSAGE" : "CHAPTER",
  };
}
