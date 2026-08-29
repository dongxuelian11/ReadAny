import { Button } from "@/components/ui/button";
import {
  deleteBookSkill,
  estimateBookSkillForBook,
  generateBookSkillForBook,
  loadExistingBookSkill,
} from "@/lib/book-skill/trigger";
import { useBookSkillStore } from "@/stores/book-skill-store";
import {
  BOOK_SKILL_GENRES,
  bookSkillPanelReducer,
  initialBookSkillPanelState,
} from "@readany/core/book-skill";
import type { BookSkillGenre } from "@readany/core/book-skill";
import type { Book } from "@readany/core/types";
import { BookMarked, CircleAlert, CircleCheck, RotateCcw } from "lucide-react";
import { useEffect, useReducer, useRef } from "react";
import { useTranslation } from "react-i18next";

interface BookSkillPanelProps {
  book: Book;
  onNavigateToChapter: (chapterIndex: number) => void;
}

const GENRE_LABEL_KEYS: Record<BookSkillGenre, string> = {
  technical: "bookSkill.genre.technical",
  "vuln-hunting": "bookSkill.genre.vulnHunting",
  financial: "bookSkill.genre.financial",
  scientific: "bookSkill.genre.scientific",
  legal: "bookSkill.genre.legal",
  textbook: "bookSkill.genre.textbook",
  reference: "bookSkill.genre.reference",
  business: "bookSkill.genre.business",
  psychology: "bookSkill.genre.psychology",
  history: "bookSkill.genre.history",
  productivity: "bookSkill.genre.productivity",
  biography: "bookSkill.genre.biography",
  narrative: "bookSkill.genre.narrative",
  general: "bookSkill.genre.general",
};

function formatTokens(tokens: number): string {
  if (tokens >= 1000) return `${Math.round(tokens / 100) / 10}K`;
  return String(tokens);
}

export function BookSkillPanel({ book, onNavigateToChapter }: BookSkillPanelProps) {
  const { t } = useTranslation();
  const [state, dispatch] = useReducer(bookSkillPanelReducer, initialBookSkillPanelState);
  const bookRef = useRef(book);
  bookRef.current = book;

  useEffect(() => {
    dispatch({ type: "BOOK_CHANGED", bookId: book.id });
    let cancelled = false;
    void (async () => {
      try {
        const existing = await loadExistingBookSkill(bookRef.current);
        if (cancelled) return;
        if (existing) {
          dispatch({ type: "COMPLETE", result: existing });
          return;
        }
        dispatch({ type: "ESTIMATE_LOADING" });
        const estimate = await estimateBookSkillForBook(bookRef.current);
        if (cancelled) return;
        dispatch({
          type: "ESTIMATE_READY",
          estimate: {
            chapterCount: estimate.chapterCount,
            estimatedInputTokens: estimate.estimatedInputTokens,
            estimatedOutputTokens: estimate.estimatedOutputTokens,
          },
        });
      } catch (error) {
        if (!cancelled) {
          dispatch({
            type: "UNAVAILABLE",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [book.id]);

  const genre = useBookSkillStore((s) => s.getGenrePreference(book.id));

  const handleGenerate = async () => {
    dispatch({ type: "GENERATE_START" });
    try {
      const result = await generateBookSkillForBook(book, (progress) =>
        dispatch({ type: "PROGRESS", progress }),
      );
      dispatch({ type: "COMPLETE", result });
    } catch (error) {
      dispatch({ type: "ERROR", error: error instanceof Error ? error.message : String(error) });
    }
  };

  const handleRetryEstimate = async () => {
    dispatch({ type: "ESTIMATE_LOADING" });
    try {
      const estimate = await estimateBookSkillForBook(book);
      dispatch({
        type: "ESTIMATE_READY",
        estimate: {
          chapterCount: estimate.chapterCount,
          estimatedInputTokens: estimate.estimatedInputTokens,
          estimatedOutputTokens: estimate.estimatedOutputTokens,
        },
      });
    } catch (error) {
      dispatch({
        type: "UNAVAILABLE",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const handleDelete = async () => {
    try {
      await deleteBookSkill(book.id);
    } finally {
      dispatch({ type: "REGENERATE" });
      void handleRetryEstimate();
    }
  };

  const busy = state.phase === "generating" || state.phase === "estimating";
  const failedChapters = state.result?.manifest.chapters.filter((c) => c.status === "failed") ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col" aria-busy={busy}>
      <div className="border-b border-border/40 px-4 py-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <BookMarked className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="truncate">{book.meta.title}</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        <output className="mb-4 flex items-start gap-2 text-xs" aria-live="polite">
          {state.phase === "unavailable" || state.phase === "error" ? (
            <CircleAlert
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive"
              aria-hidden="true"
            />
          ) : state.phase === "ready" ? (
            <CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
          ) : (
            <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-primary/70" aria-hidden="true" />
          )}
          <div className="min-w-0">
            <p className="font-medium text-foreground">
              {t(`bookSkill.phase.${state.phase}`)}
              {state.phase === "generating" && state.progress && (
                <span className="ml-1 text-muted-foreground">
                  {state.progress.phase === "mapping"
                    ? t("bookSkill.progressChapters", {
                        completed: state.progress.completedChapters,
                        total: state.progress.totalChapters,
                      })
                    : ""}
                </span>
              )}
            </p>
            {(state.phase === "unavailable" || state.phase === "error") && state.error && (
              <p className="mt-1 break-words leading-5 text-muted-foreground">{state.error}</p>
            )}
          </div>
        </output>

        {state.phase === "unavailable" && (
          <Button variant="outline" size="sm" onClick={handleRetryEstimate}>
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            {t("bookSkill.retry")}
          </Button>
        )}

        {(state.phase === "estimate-ready" || state.phase === "estimating") && (
          <section aria-labelledby="book-skill-estimate-heading">
            <h2 id="book-skill-estimate-heading" className="text-sm font-semibold">
              {t("bookSkill.estimateTitle")}
            </h2>
            {state.estimate && (
              <dl className="mt-3 space-y-1.5 text-xs leading-5 text-muted-foreground">
                <div className="flex justify-between gap-4">
                  <dt>{t("bookSkill.chapters")}</dt>
                  <dd className="font-medium text-foreground">{state.estimate.chapterCount}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt>{t("bookSkill.estimatedInput")}</dt>
                  <dd className="font-medium text-foreground">
                    ~{formatTokens(state.estimate.estimatedInputTokens)}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt>{t("bookSkill.estimatedOutput")}</dt>
                  <dd className="font-medium text-foreground">
                    ~{formatTokens(state.estimate.estimatedOutputTokens)}
                  </dd>
                </div>
              </dl>
            )}
            <label className="mt-4 block text-xs font-medium" htmlFor="book-skill-genre">
              {t("bookSkill.genreLabel")}
            </label>
            <select
              id="book-skill-genre"
              value={genre}
              onChange={(event) => {
                const next = event.target.value as BookSkillGenre;
                useBookSkillStore.getState().setGenrePreference(book.id, next);
                dispatch({ type: "GENRE_SELECTED", genre: next });
              }}
              className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              disabled={busy}
            >
              {BOOK_SKILL_GENRES.map((value) => (
                <option key={value} value={value}>
                  {t(GENRE_LABEL_KEYS[value])}
                </option>
              ))}
            </select>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              {t("bookSkill.estimateNote")}
            </p>
            <Button className="mt-3" size="sm" disabled={busy} onClick={handleGenerate}>
              {state.phase === "estimating" ? t("bookSkill.preparing") : t("bookSkill.generate")}
            </Button>
          </section>
        )}

        {state.phase === "generating" && (
          <section aria-labelledby="book-skill-generating-heading">
            <h2 id="book-skill-generating-heading" className="text-sm font-semibold">
              {t("bookSkill.generatingTitle")}
            </h2>
            <div className="mt-3 space-y-1.5 text-xs leading-5 text-muted-foreground">
              <p>{t("bookSkill.generatingSpine")}</p>
              <p>{t("bookSkill.generatingMap")}</p>
              <p>{t("bookSkill.generatingReduce")}</p>
            </div>
            {state.progress && (
              <p className="mt-3 text-xs font-medium text-foreground">
                {t("bookSkill.progressChapters", {
                  completed: state.progress.completedChapters,
                  total: state.progress.totalChapters,
                })}
              </p>
            )}
            <p className="mt-3 text-xs leading-5 text-muted-foreground">
              {t("bookSkill.generatingNote")}
            </p>
          </section>
        )}

        {state.phase === "ready" && state.result && (
          <div className="space-y-6">
            <section aria-labelledby="book-skill-thesis-heading">
              <h2
                id="book-skill-thesis-heading"
                className="text-xs font-medium text-muted-foreground"
              >
                {t("bookSkill.thesis")}
              </h2>
              <p className="mt-1 whitespace-pre-wrap text-sm leading-6">
                {state.result.tier1.thesis}
              </p>
            </section>

            {state.result.tier1.coreFrameworks.length > 0 && (
              <section aria-labelledby="book-skill-frameworks-heading">
                <h2
                  id="book-skill-frameworks-heading"
                  className="text-xs font-medium text-muted-foreground"
                >
                  {t("bookSkill.coreFrameworks")}
                </h2>
                <dl className="mt-1 space-y-3">
                  {state.result.tier1.coreFrameworks.map((framework) => (
                    <div key={framework.name}>
                      <dt className="text-sm font-medium">{framework.name}</dt>
                      <dd className="mt-0.5 text-xs leading-5 text-muted-foreground">
                        {framework.whenToUse}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}

            {state.result.tier1.nodes.length > 0 && (
              <section aria-labelledby="book-skill-map-heading">
                <h2
                  id="book-skill-map-heading"
                  className="text-xs font-medium text-muted-foreground"
                >
                  {t("bookSkill.conceptMap")}
                </h2>
                <ul className="mt-1 space-y-1.5 text-xs leading-5">
                  {state.result.tier1.nodes.map((node) => (
                    <li key={`${node.name}-${node.chapter}`}>
                      <span className="font-medium">{node.name}</span>
                      <span className="text-muted-foreground"> — {node.summary}</span>
                      <ChapterLink
                        bookNumber={node.chapter}
                        chapters={state.result?.manifest.readany.chapters ?? []}
                        onNavigate={onNavigateToChapter}
                      />
                    </li>
                  ))}
                </ul>
                {state.result.tier1.edges.length > 0 && (
                  <ul className="mt-2 space-y-1 text-xs leading-5 text-muted-foreground">
                    {state.result.tier1.edges.map((edge) => (
                      <li key={`${edge.from}-${edge.relation}-${edge.to}`}>
                        {edge.from} →{" "}
                        {t(`bookSkill.relation.${edge.relation.replace(/\s+/g, "-")}`)} → {edge.to}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}

            {state.result.tier1.topicIndex.length > 0 && (
              <section aria-labelledby="book-skill-topics-heading">
                <h2
                  id="book-skill-topics-heading"
                  className="text-xs font-medium text-muted-foreground"
                >
                  {t("bookSkill.topicIndex")}
                </h2>
                <ul className="mt-1 space-y-1 text-xs leading-5">
                  {state.result.tier1.topicIndex.map((entry) => (
                    <li key={entry.term} className="flex flex-wrap items-baseline gap-x-1.5">
                      <span className="font-medium">{entry.term}</span>
                      <span className="text-muted-foreground">→</span>
                      {entry.chapters.map((bookNumber) => (
                        <ChapterLink
                          key={bookNumber}
                          bookNumber={bookNumber}
                          chapters={state.result?.manifest.readany.chapters ?? []}
                          onNavigate={onNavigateToChapter}
                        />
                      ))}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section aria-labelledby="book-skill-chapters-heading">
              <h2
                id="book-skill-chapters-heading"
                className="text-xs font-medium text-muted-foreground"
              >
                {t("bookSkill.chapterIndex")}
              </h2>
              <ul className="mt-1 divide-y divide-border/40">
                {state.result.manifest.chapters.map((chapter) => {
                  const mapping = state.result?.manifest.readany.chapters.find(
                    (candidate) => candidate.book_number === chapter.book_number,
                  );
                  return (
                    <li key={chapter.file} className="flex items-center justify-between gap-3 py-2">
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-medium">{chapter.title}</span>
                        <span className="text-[11px] text-muted-foreground">
                          {chapter.book_number}
                          {chapter.status === "failed" ? ` · ${t("bookSkill.failed")}` : ""}
                        </span>
                      </span>
                      {mapping && chapter.status !== "failed" && (
                        <button
                          type="button"
                          className="shrink-0 text-xs text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={() => onNavigateToChapter(mapping.chapterIndex)}
                        >
                          {t("bookSkill.backToSource")}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>

            {failedChapters.length > 0 && (
              <p className="text-xs leading-5 text-amber-600 dark:text-amber-400">
                {t("bookSkill.failedChapters", { count: failedChapters.length })}
              </p>
            )}

            <div className="flex items-center gap-2 border-t border-border/50 pt-4">
              <Button variant="outline" size="sm" onClick={handleDelete}>
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                {t("bookSkill.regenerate")}
              </Button>
              <span className="text-[11px] text-muted-foreground">
                {t("bookSkill.builtAt", { date: state.result.manifest.built_at.slice(0, 10) })}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ChapterLink({
  bookNumber,
  chapters,
  onNavigate,
}: {
  bookNumber: string;
  chapters: Array<{ book_number: string; chapterIndex: number; title: string }>;
  onNavigate: (chapterIndex: number) => void;
}) {
  const { t } = useTranslation();
  const mapping = chapters.find((candidate) => candidate.book_number === bookNumber);
  if (!mapping) {
    return <span className="text-muted-foreground"> · {bookNumber}</span>;
  }
  return (
    <button
      type="button"
      className="ml-1 inline text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      title={mapping.title}
      onClick={() => onNavigate(mapping.chapterIndex)}
    >
      {t("bookSkill.backToSourceShort", { chapter: bookNumber })}
    </button>
  );
}
