import { Button } from "@/components/ui/button";
import { getBookDueReviews, getBookMasteryOverview } from "@/lib/learner/overview";
import {
  answerPlacement,
  finalizePlacementSession,
  getActivePlacement,
  startBookPlacement,
} from "@/lib/learner/placement-trigger";
import { useSettingsStore } from "@/stores/settings-store";
import {
  currentPlacementItem,
  initialLearnerPanelState,
  learnerPanelReducer,
} from "@readany/core/learner";
import type {
  LearnerDueRow,
  LearnerMasteryRow,
  LearnerTab,
  MasteryStatus,
  PlacementVerdict,
} from "@readany/core/learner";
import type { Book } from "@readany/core/types";
import { ArrowRight, CircleAlert, CircleCheck, GraduationCap, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

interface LearnerPanelProps {
  book: Book;
  onNavigateToChapter: (chapterIndex: number) => void;
}

const STATUS_CHIP_CLASS: Record<MasteryStatus, string> = {
  unseen: "bg-muted text-muted-foreground",
  learning: "bg-muted text-foreground",
  stable: "bg-primary/10 text-primary",
  needs_review: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
};

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function chapterIndexFromConceptId(conceptId: string): number | null {
  const match = /readany:book:[^:]+:chapter:(\d+)$/.exec(conceptId);
  return match ? Number(match[1]) : null;
}

export function LearnerPanel({ book, onNavigateToChapter }: LearnerPanelProps) {
  const { t } = useTranslation();
  const [state, dispatch] = useReducer(learnerPanelReducer, initialLearnerPanelState);
  const [selectedOption, setSelectedOption] = useState<number | null>(null);
  const aiConfig = useSettingsStore((state) => state.aiConfig);
  const bookRef = useRef(book);
  bookRef.current = book;

  // Resume an in-progress placement when the panel opens for this book.
  useEffect(() => {
    dispatch({ type: "BOOK_CHANGED", bookId: book.id });
    let cancelled = false;
    void (async () => {
      try {
        const active = await getActivePlacement();
        if (cancelled) return;
        if (
          active?.items.every((entry) => entry.conceptId.startsWith(`readany:book:${book.id}:`))
        ) {
          dispatch({ type: "PLACEMENT_SESSION", session: active });
        }
      } catch {
        // Placement resume is best-effort; the tab stays idle.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [book.id]);

  const loadMastery = useCallback(async () => {
    dispatch({ type: "MASTERY_LOADING" });
    try {
      const rows: LearnerMasteryRow[] = await getBookMasteryOverview(bookRef.current);
      dispatch({ type: "MASTERY_READY", rows });
    } catch (error) {
      dispatch({
        type: "MASTERY_ERROR",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const loadReview = useCallback(async () => {
    dispatch({ type: "REVIEW_LOADING" });
    try {
      const rows: LearnerDueRow[] = await getBookDueReviews(bookRef.current);
      dispatch({ type: "REVIEW_READY", rows });
    } catch (error) {
      dispatch({
        type: "REVIEW_ERROR",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  // Refresh lists when their tab becomes visible (the idle-phase guard makes
  // re-runs on phase changes no-ops).
  useEffect(() => {
    if (state.tab === "mastery" && state.masteryPhase === "idle") {
      void loadMastery();
    }
    if (state.tab === "review" && state.reviewPhase === "idle") {
      void loadReview();
    }
  }, [state.tab, state.masteryPhase, state.reviewPhase, loadMastery, loadReview]);

  const busy = state.placementPhase === "starting" || state.placementPhase === "finalizing";
  const currentItem = currentPlacementItem(state);
  const answeredCount = state.session?.responses.length ?? 0;
  const poolSize = state.session?.items.length ?? 0;

  const handleStart = async () => {
    if (!aiConfig.activeModel) {
      dispatch({ type: "PLACEMENT_UNAVAILABLE", error: t("learnerPanel.noAiConfig") });
      return;
    }
    dispatch({ type: "PLACEMENT_START" });
    try {
      const session = await startBookPlacement(bookRef.current);
      dispatch({ type: "PLACEMENT_SESSION", session });
    } catch (error) {
      dispatch({
        type: "PLACEMENT_ERROR",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const handleSubmitAnswer = async () => {
    if (!state.session || !currentItem || selectedOption === null) return;
    const correct = selectedOption === currentItem.correctIndex;
    try {
      const updated = await answerPlacement(state.session, currentItem.id, correct);
      dispatch({
        type: "PLACEMENT_ANSWERED",
        session: updated,
        correct,
        explanation: currentItem.explanation,
      });
      setSelectedOption(null);
    } catch (error) {
      dispatch({
        type: "PLACEMENT_ERROR",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const handleFinalize = async () => {
    if (!state.session) return;
    dispatch({ type: "PLACEMENT_FINALIZING" });
    try {
      const verdict: PlacementVerdict = await finalizePlacementSession(state.session);
      dispatch({ type: "PLACEMENT_COMPLETED", verdict });
      // Mastery data changed — refresh the list if it was already loaded.
      if (state.masteryPhase === "ready") void loadMastery();
    } catch (error) {
      dispatch({
        type: "PLACEMENT_ERROR",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const tabs: Array<[LearnerTab, string]> = [
    ["placement", t("learnerPanel.tabs.placement")],
    ["mastery", t("learnerPanel.tabs.mastery")],
    ["review", t("learnerPanel.tabs.review")],
  ];

  return (
    <div className="flex h-full min-h-0 flex-col" aria-busy={busy}>
      <div className="border-b border-border/40 px-4 py-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <GraduationCap className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="truncate">{book.meta.title}</span>
        </div>
        <div
          className="mt-2 grid grid-cols-3 gap-1"
          role="tablist"
          aria-label={t("learnerPanel.tabs.label")}
        >
          {tabs.map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={state.tab === value}
              className={`flex h-8 items-center justify-center rounded-md px-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                state.tab === value
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => dispatch({ type: "TAB_CHANGED", tab: value })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {state.tab === "placement" && (
          <PlacementTab
            state={state}
            currentItem={currentItem}
            answeredCount={answeredCount}
            poolSize={poolSize}
            selectedOption={selectedOption}
            onSelectOption={setSelectedOption}
            onStart={handleStart}
            onSubmitAnswer={handleSubmitAnswer}
            onFinalize={handleFinalize}
            onContinue={() => dispatch({ type: "PLACEMENT_CONTINUE" })}
            onNavigateToChapter={onNavigateToChapter}
          />
        )}
        {state.tab === "mastery" && <MasteryTab state={state} onRetry={loadMastery} />}
        {state.tab === "review" && <ReviewTab state={state} onRetry={loadReview} />}
      </div>
    </div>
  );
}

function PlacementTab({
  state,
  currentItem,
  answeredCount,
  poolSize,
  selectedOption,
  onSelectOption,
  onStart,
  onSubmitAnswer,
  onFinalize,
  onContinue,
  onNavigateToChapter,
}: {
  state: ReturnType<typeof learnerPanelReducer>;
  currentItem: ReturnType<typeof currentPlacementItem>;
  answeredCount: number;
  poolSize: number;
  selectedOption: number | null;
  onSelectOption: (index: number) => void;
  onStart: () => void;
  onSubmitAnswer: () => void;
  onFinalize: () => void;
  onContinue: () => void;
  onNavigateToChapter: (chapterIndex: number) => void;
}) {
  const { t } = useTranslation();
  const phase = state.placementPhase;

  return (
    <section aria-labelledby="learner-placement-heading">
      <h2 id="learner-placement-heading" className="text-sm font-semibold">
        {t("learnerPanel.placement.title")}
      </h2>

      <output className="mt-3 flex items-start gap-2 text-xs" aria-live="polite">
        {phase === "error" || phase === "unavailable" ? (
          <CircleAlert
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive"
            aria-hidden="true"
          />
        ) : phase === "completed" ? (
          <CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
        ) : (
          <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-primary/70" aria-hidden="true" />
        )}
        <div className="min-w-0">
          <p className="font-medium text-foreground">{t(`learnerPanel.phase.${phase}`)}</p>
          {(phase === "error" || phase === "unavailable") && state.error && (
            <p className="mt-1 break-words leading-5 text-muted-foreground">{state.error}</p>
          )}
        </div>
      </output>

      {phase === "idle" && (
        <div className="mt-3 text-xs leading-5 text-muted-foreground">
          <p>{t("learnerPanel.placement.idleNote")}</p>
          <Button className="mt-3" size="sm" onClick={onStart}>
            {t("learnerPanel.placement.start")}
          </Button>
        </div>
      )}

      {phase === "starting" && (
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          {t("learnerPanel.placement.starting")}
        </p>
      )}

      {phase === "active" && state.lastAnswer && (
        <div className="mt-3 border-l-2 border-primary/40 pl-3">
          <p className="text-sm font-medium">
            {state.lastAnswer.correct
              ? t("learnerPanel.placement.correct")
              : t("learnerPanel.placement.incorrect")}
          </p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {state.lastAnswer.explanation}
          </p>
          <Button className="mt-3" size="sm" variant="outline" onClick={onContinue}>
            {currentItem
              ? t("learnerPanel.placement.continue")
              : t("learnerPanel.placement.finish")}
            <ArrowRight className="ml-1.5 h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </div>
      )}

      {phase === "active" && !state.lastAnswer && currentItem && (
        <div className="mt-3">
          <p className="text-[11px] text-muted-foreground">
            {t("learnerPanel.placement.progress", { answered: answeredCount, pool: poolSize })}
          </p>
          <p className="mt-2 text-sm font-medium leading-6">{currentItem.prompt}</p>
          <div className="mt-3 grid gap-2">
            {currentItem.options.map((option, index) => (
              <button
                key={`${currentItem.id}-${index}`}
                type="button"
                className={`rounded-md border px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  selectedOption === index
                    ? "border-primary bg-primary/5"
                    : "border-border hover:bg-muted/50"
                }`}
                aria-pressed={selectedOption === index}
                onClick={() => onSelectOption(index)}
              >
                {option}
              </button>
            ))}
          </div>
          <Button
            className="mt-3"
            size="sm"
            disabled={selectedOption === null}
            onClick={onSubmitAnswer}
          >
            {t("learnerPanel.placement.submit")}
          </Button>
        </div>
      )}

      {phase === "active" && !state.lastAnswer && !currentItem && (
        <div className="mt-3 text-xs leading-5 text-muted-foreground">
          <p>{t("learnerPanel.placement.stopReached")}</p>
          <Button className="mt-3" size="sm" onClick={onFinalize}>
            {t("learnerPanel.placement.finish")}
          </Button>
        </div>
      )}

      {phase === "finalizing" && (
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          {t("learnerPanel.placement.finalizing")}
        </p>
      )}

      {phase === "completed" && state.verdict && (
        <VerdictView verdict={state.verdict} onNavigateToChapter={onNavigateToChapter} />
      )}

      {(phase === "error" || phase === "unavailable") && (
        <Button className="mt-3" size="sm" variant="outline" onClick={onStart}>
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          {t("learnerPanel.retry")}
        </Button>
      )}
    </section>
  );
}

function VerdictView({
  verdict,
  onNavigateToChapter,
}: {
  verdict: PlacementVerdict;
  onNavigateToChapter: (chapterIndex: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="mt-3 space-y-4 text-sm">
      <dl className="space-y-1.5 text-xs leading-5 text-muted-foreground">
        <div className="flex justify-between gap-4">
          <dt>{t("learnerPanel.verdict.ability")}</dt>
          <dd className="font-medium text-foreground">{formatPercent(verdict.theta)}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt>{t("learnerPanel.verdict.questions")}</dt>
          <dd className="font-medium text-foreground">
            {verdict.correct}/{verdict.questionsAsked}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt>{t("learnerPanel.verdict.assessed")}</dt>
          <dd className="font-medium text-foreground">
            {verdict.masteryWritten}/{verdict.conceptsAssessed}
          </dd>
        </div>
      </dl>
      <ul className="divide-y divide-border/40">
        {verdict.perConcept.map((entry) => {
          const chapterIndex = chapterIndexFromConceptId(entry.conceptId);
          return (
            <li key={entry.conceptId} className="flex items-center justify-between gap-3 py-2">
              <span className="min-w-0">
                <span className="block truncate text-xs font-medium">{entry.conceptTitle}</span>
                <span className="text-[11px] text-muted-foreground">
                  {formatPercent(entry.mastery)}
                  {entry.tested ? "" : ` · ${t("learnerPanel.verdict.inferred")}`}
                </span>
              </span>
              {chapterIndex !== null && (
                <button
                  type="button"
                  className="shrink-0 text-xs text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => onNavigateToChapter(chapterIndex)}
                >
                  {t("learnerPanel.backToSource")}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-xs leading-5 text-muted-foreground">{t("learnerPanel.verdict.note")}</p>
    </div>
  );
}

function MasteryTab({
  state,
  onRetry,
}: {
  state: ReturnType<typeof learnerPanelReducer>;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="learner-mastery-heading">
      <h2 id="learner-mastery-heading" className="text-sm font-semibold">
        {t("learnerPanel.mastery.title")}
      </h2>
      {state.masteryPhase === "loading" && (
        <p className="mt-3 text-xs leading-5 text-muted-foreground">{t("learnerPanel.loading")}</p>
      )}
      {state.masteryPhase === "error" && (
        <div className="mt-3">
          <p className="text-xs leading-5 text-muted-foreground">{state.error}</p>
          <Button className="mt-3" size="sm" variant="outline" onClick={onRetry}>
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            {t("learnerPanel.retry")}
          </Button>
        </div>
      )}
      {state.masteryPhase === "ready" && state.masteryRows.every((row) => row.mastery === null) && (
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          {t("learnerPanel.mastery.empty")}
        </p>
      )}
      {state.masteryPhase === "ready" && (
        <ul className="mt-3 divide-y divide-border/40">
          {state.masteryRows.map((row) => (
            <li key={row.conceptId} className="flex items-center justify-between gap-3 py-2">
              <span className="min-w-0">
                <span className="block truncate text-xs font-medium">{row.title}</span>
                <span className="text-[11px] text-muted-foreground">
                  {row.mastery
                    ? `${formatPercent(row.mastery.mastery)} · ${t(
                        `learnerPanel.status.${row.mastery.status}`,
                      )}${row.mastery.evidenceCount > 0 ? ` · ${t("learnerPanel.mastery.evidence", { count: row.mastery.evidenceCount })}` : ""}`
                    : t("learnerPanel.status.unseen")}
                </span>
              </span>
              {row.mastery && (
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_CHIP_CLASS[row.mastery.status]}`}
                >
                  {t(`learnerPanel.status.${row.mastery.status}`)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {state.masteryPhase === "ready" && (
        <button
          type="button"
          className="mt-3 text-xs text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onRetry}
        >
          {t("learnerPanel.mastery.refresh")}
        </button>
      )}
    </section>
  );
}

function ReviewTab({
  state,
  onRetry,
}: {
  state: ReturnType<typeof learnerPanelReducer>;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="learner-review-heading">
      <h2 id="learner-review-heading" className="text-sm font-semibold">
        {t("learnerPanel.review.title")}
      </h2>
      {state.reviewPhase === "loading" && (
        <p className="mt-3 text-xs leading-5 text-muted-foreground">{t("learnerPanel.loading")}</p>
      )}
      {state.reviewPhase === "error" && (
        <div className="mt-3">
          <p className="text-xs leading-5 text-muted-foreground">{state.error}</p>
          <Button className="mt-3" size="sm" variant="outline" onClick={onRetry}>
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            {t("learnerPanel.retry")}
          </Button>
        </div>
      )}
      {state.reviewPhase === "ready" && state.dueRows.length === 0 && (
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          {t("learnerPanel.review.empty")}
        </p>
      )}
      {state.reviewPhase === "ready" && state.dueRows.length > 0 && (
        <ul className="mt-3 divide-y divide-border/40">
          {state.dueRows.map((row) => (
            <li key={row.conceptId} className="py-2">
              <span className="block truncate text-xs font-medium">
                {row.title ?? row.conceptId}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {t("learnerPanel.review.dueAt", {
                  date: new Date(row.due).toLocaleDateString(),
                })}
                {row.mastery !== null ? ` · ${formatPercent(row.mastery)}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      {state.reviewPhase === "ready" && (
        <button
          type="button"
          className="mt-3 text-xs text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onRetry}
        >
          {t("learnerPanel.review.refresh")}
        </button>
      )}
    </section>
  );
}
