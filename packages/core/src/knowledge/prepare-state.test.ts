// KB-01/F03: the preparation state is a pure view over existing Book fields.

import { describe, expect, it } from "vitest";
import type { Book } from "../types";
import { bookPrepareState, isBookSearchable } from "./prepare-state";

function book(overrides: Partial<Book> = {}): Book {
  return {
    id: "b1",
    filePath: "books/b1.epub",
    format: "epub",
    meta: { title: "T", author: "" },
    progress: 0,
    isVectorized: false,
    vectorizeProgress: 0,
    tags: [],
    addedAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("bookPrepareState", () => {
  it("readable: no index started, no failure", () => {
    expect(bookPrepareState(book())).toBe("readable");
  });

  it("indexing: progress started but not complete", () => {
    expect(bookPrepareState(book({ vectorizeProgress: 0.4 }))).toBe("indexing");
  });

  it("searchable: vectorized", () => {
    expect(bookPrepareState(book({ isVectorized: true, vectorizeProgress: 1 }))).toBe("searchable");
    expect(isBookSearchable(book({ isVectorized: true, vectorizeProgress: 1 }))).toBe(true);
  });

  it("index-failed: persisted failure wins and blocks the searchable claim", () => {
    const failed = book({ vectorizeError: "model unavailable" });
    expect(bookPrepareState(failed)).toBe("index-failed");
    expect(isBookSearchable(failed)).toBe(false);
    // even a partially-indexed book with a failure is honest about it
    expect(bookPrepareState(book({ vectorizeProgress: 0.4, vectorizeError: "x" }))).toBe(
      "index-failed",
    );
  });
});
