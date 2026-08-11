import { describe, expect, it } from "vitest";
import {
  assertReadBoxQaAnswer,
  createLearningCitation,
  findQuotedEvidence,
  initialLearningPanelState,
  learningPanelReducer,
  normalizeDerivedChapterText,
} from "./index";
import type { LearningSourceRef } from "./types";

const source: LearningSourceRef = {
  readAnyBookId: "book-1",
  readAnyChapterId: "3",
  location: { chapterIndex: 3, chapterHref: "chapter-4.xhtml", cfi: "epubcfi(/6/8)" },
  title: "第四章",
  text: "第一段。\n\n  第二段包含关键证据。",
  passages: [
    { text: "第一段。", cfi: "epubcfi(/6/8!/4/2)" },
    { text: "第二段包含关键证据。", cfi: "epubcfi(/6/8!/4/4)" },
  ],
};

describe("canonical learning bridge", () => {
  it("normalizes a chapter into one rebuildable Read-Box TXT paragraph", () => {
    expect(normalizeDerivedChapterText(source)).toBe("第一段。 第二段包含关键证据。");
  });

  it("maps exact evidence to a canonical passage CFI", () => {
    expect(createLearningCitation(source, "第二段包含关键证据。")).toMatchObject({
      sourceType: "BOOK",
      readAnyBookId: "book-1",
      readAnyChapterId: "3",
      precision: "PASSAGE",
      canonicalLocation: { cfi: "epubcfi(/6/8!/4/4)", chapterIndex: 3 },
    });
  });

  it("stays honestly chapter-level when evidence cannot be located", () => {
    expect(createLearningCitation(source, "无法在原文匹配的概括")).toMatchObject({
      precision: "CHAPTER",
      canonicalLocation: { chapterIndex: 3, cfi: "epubcfi(/6/8)" },
    });
  });

  it("extracts quoted source evidence from a grounded answer", () => {
    expect(findQuotedEvidence("根据本章，“第二段包含关键证据。”说明了这一点。")).toBe(
      "第二段包含关键证据。",
    );
  });
});

describe("learning panel state", () => {
  it("preserves explicit loading, streaming, completed, and unavailable states", () => {
    const loading = learningPanelReducer(initialLearningPanelState, { type: "DIGEST_LOADING" });
    expect(loading.phase).toBe("digest-loading");

    const streaming = learningPanelReducer(initialLearningPanelState, { type: "QA_START" });
    const chunked = learningPanelReducer(streaming, { type: "QA_CHUNK", chunk: "回答" });
    expect(chunked).toMatchObject({ phase: "qa-streaming", answer: "回答" });

    const unavailable = learningPanelReducer(initialLearningPanelState, {
      type: "UNAVAILABLE",
      error: "worker unavailable",
    });
    expect(unavailable).toMatchObject({ phase: "unavailable", error: "worker unavailable" });
  });
});

describe("Read-Box QA response boundary", () => {
  it("preserves a real grounded answer", () => {
    expect(assertReadBoxQaAnswer("根据本章，ReadAny 保留原文权威。")).toContain("ReadAny");
  });

  it("rejects the upstream HTTP-200 provider failure text", () => {
    expect(() => assertReadBoxQaAnswer("\n\n调用 AI 失败：provider unavailable")).toThrow(
      "Read-Box QA failed: provider unavailable",
    );
  });

  it("rejects empty streams", () => {
    expect(() => assertReadBoxQaAnswer("  ")).toThrow("empty answer");
  });
});
