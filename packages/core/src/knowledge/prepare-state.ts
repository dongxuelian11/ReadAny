/**
 * Book preparation states (KB-01/F03).
 *
 * A single view over the EXISTING Book fields — no new tables, no parallel
 * engine. "已入库" and "可检索" are genuinely different things: a book can be
 * fully readable while its full-text index is still preparing (or failed).
 * Consumers (library cards, recommendations, teaching prep) must not claim
 * full-text searchability from readability alone.
 */

import type { Book } from "../types/book";

export type BookPrepareState =
  /** 正文可读,全文索引尚未准备(未开始) */
  | "readable"
  /** 索引准备中(进度在推进) */
  | "indexing"
  /** 可全文检索(索引完成) */
  | "searchable"
  /** 索引准备失败(可重试;不影响阅读) */
  | "index-failed";

export function bookPrepareState(book: Book): BookPrepareState {
  if (book.vectorizeError) return "index-failed";
  if (book.isVectorized) return "searchable";
  if (book.vectorizeProgress > 0) return "indexing";
  return "readable";
}

/** True when the book can be claimed to support full-text retrieval. */
export function isBookSearchable(book: Book): boolean {
  return bookPrepareState(book) === "searchable";
}
