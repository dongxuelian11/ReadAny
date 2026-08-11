import { fallbackContentService } from "@readany/core/ai";
import type { LearningSourceRef } from "@readany/core/learning";
import type { Book, ReadingContext } from "@readany/core/types";

export async function resolveCurrentLearningSource(
  book: Book,
  context: ReadingContext | null,
): Promise<LearningSourceRef> {
  if (!context || context.bookId !== book.id) {
    throw new Error("The Reader has not published a current chapter yet");
  }

  const chapters = await fallbackContentService.getChapters(book);
  const chapter =
    chapters.find((candidate) => candidate.index === context.currentChapter.index) ??
    chapters.find((candidate) => candidate.title === context.currentChapter.title);

  if (!chapter?.content.trim()) {
    throw new Error("The current chapter could not be resolved from ReadAny original content");
  }

  return {
    readAnyBookId: book.id,
    readAnyChapterId: String(chapter.index),
    location: {
      chapterIndex: chapter.index,
      chapterHref: context.currentChapter.href || undefined,
      cfi: context.currentPosition.cfi || undefined,
    },
    title: chapter.title || context.currentChapter.title || book.meta.title,
    text: chapter.content,
    passages: (chapter.segments ?? []).map((segment) => ({
      text: segment.text,
      cfi: segment.cfi,
    })),
  };
}
