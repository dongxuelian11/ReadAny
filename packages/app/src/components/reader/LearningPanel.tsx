import { Button } from "@/components/ui/button";
import { useReadingContext } from "@/lib/ai/reading-context-service";
import { recordQuizEvidence } from "@/lib/learner/trigger";
import {
  answerQuiz,
  askReadBox,
  createDigest,
  ensureReadBoxBinding,
  finishQuiz,
  startQuiz,
  startReadBoxWorker,
} from "@/lib/learning/readbox-client";
import type { ReadBoxSession } from "@/lib/learning/readbox-client";
import { resolveCurrentLearningSource } from "@/lib/learning/source";
import { useSettingsStore } from "@/stores/settings-store";
import { initialLearningPanelState, learningPanelReducer } from "@readany/core/learning";
import type { LearningCitation, LearningSourceRef, ReadBoxBinding } from "@readany/core/learning";
import type { Book } from "@readany/core/types";
import {
  BookOpenCheck,
  CircleAlert,
  CircleCheck,
  ListChecks,
  MessageCircleQuestion,
  Quote,
  RotateCcw,
} from "lucide-react";
import { useEffect, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

type LearningTab = "digest" | "qa" | "quiz";

interface LearningPanelProps {
  book: Book;
  onNavigateToCitation: (citation: LearningCitation) => void;
}

const BUSY_PHASES = new Set(["starting", "digest-loading", "qa-streaming", "quiz-loading"]);

export function LearningPanel({ book, onNavigateToCitation }: LearningPanelProps) {
  const { t } = useTranslation();
  const readingContext = useReadingContext();
  const aiConfig = useSettingsStore((state) => state.aiConfig);
  const [state, dispatch] = useReducer(learningPanelReducer, initialLearningPanelState);
  const [tab, setTab] = useState<LearningTab>("digest");
  const [source, setSource] = useState<LearningSourceRef | null>(null);
  const [session, setSession] = useState<ReadBoxSession | null>(null);
  const [binding, setBinding] = useState<ReadBoxBinding | null>(null);
  const [question, setQuestion] = useState("");
  const [quizAnswer, setQuizAnswer] = useState("");
  const [retryKey, setRetryKey] = useState(0);
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const bookRef = useRef(book);
  const readingContextRef = useRef(readingContext);
  bookRef.current = book;
  readingContextRef.current = readingContext;

  const chapterIndex = readingContext?.currentChapter.index;
  const initializationKey = `${book.id}:${chapterIndex ?? "pending"}:${retryKey}`;

  useEffect(() => {
    if (!initializationKey) return;
    let cancelled = false;
    dispatch({ type: "RESET_CHAPTER" });
    dispatch({ type: "STARTING" });
    setSource(null);
    setSession(null);
    setBinding(null);
    setQuestion("");
    setQuizAnswer("");

    void (async () => {
      try {
        const canonicalSource = await resolveCurrentLearningSource(
          bookRef.current,
          readingContextRef.current,
        );
        const runtimeSession = await startReadBoxWorker(aiConfig);
        const derivedBinding = await ensureReadBoxBinding(runtimeSession, canonicalSource);
        if (cancelled) return;
        setSource(canonicalSource);
        setSession(runtimeSession);
        setBinding(derivedBinding);
        dispatch({ type: "READY" });
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
  }, [aiConfig, initializationKey]);

  const requireBridge = () => {
    if (!session || !binding || !source) throw new Error(t("learning.notReady"));
    return { session, binding, source };
  };

  const handleDigest = async () => {
    dispatch({ type: "DIGEST_LOADING" });
    try {
      const bridge = requireBridge();
      const digest = await createDigest(bridge.session, bridge.binding, bridge.source);
      dispatch({ type: "DIGEST_COMPLETE", digest });
    } catch (error) {
      dispatch({ type: "ERROR", error: error instanceof Error ? error.message : String(error) });
    }
  };

  const handleAsk = async () => {
    const trimmed = question.trim();
    if (!trimmed) {
      questionRef.current?.focus();
      return;
    }
    dispatch({ type: "QA_START" });
    try {
      const bridge = requireBridge();
      const result = await askReadBox(
        bridge.session,
        bridge.binding,
        bridge.source,
        trimmed,
        (chunk) => dispatch({ type: "QA_CHUNK", chunk }),
      );
      dispatch({ type: "QA_COMPLETE", citations: result.citations });
    } catch (error) {
      dispatch({ type: "ERROR", error: error instanceof Error ? error.message : String(error) });
    }
  };

  const handleStartQuiz = async () => {
    dispatch({ type: "QUIZ_LOADING" });
    setQuizAnswer("");
    try {
      const bridge = requireBridge();
      const questions = await startQuiz(bridge.session, bridge.binding);
      dispatch({ type: "QUIZ_ACTIVE", questions });
    } catch (error) {
      dispatch({ type: "ERROR", error: error instanceof Error ? error.message : String(error) });
    }
  };

  const handleAnswerQuiz = async () => {
    const currentQuestion = state.quizQuestions[state.quizIndex];
    if (!currentQuestion || !quizAnswer.trim()) return;
    try {
      const bridge = requireBridge();
      const judgement = await answerQuiz(
        bridge.session,
        bridge.binding,
        currentQuestion,
        quizAnswer.trim(),
      );
      dispatch({ type: "QUIZ_JUDGED", judgement });
      // Durable-first (PR-012): the judgement is enqueued to the evidence
      // outbox before it is applied, so a crash or failed write can no longer
      // silently lose it — pending rows replay on the next launch.
      // Fire-and-forget still: persistence must never disrupt the quiz UX.
      void recordQuizEvidence(judgement, bridge.source, currentQuestion).catch((error) =>
        console.error("Failed to record quiz evidence:", error),
      );
    } catch (error) {
      dispatch({ type: "ERROR", error: error instanceof Error ? error.message : String(error) });
    }
  };

  const handleFinishQuiz = async () => {
    try {
      const bridge = requireBridge();
      const done = await finishQuiz(bridge.session, bridge.binding);
      if (!done) throw new Error(t("learning.quizUnexpectedNext"));
      dispatch({ type: "QUIZ_COMPLETE" });
    } catch (error) {
      dispatch({ type: "ERROR", error: error instanceof Error ? error.message : String(error) });
    }
  };

  const busy = BUSY_PHASES.has(state.phase);
  const usable = Boolean(source && session && binding) && state.phase !== "unavailable";
  const currentQuizQuestion = state.quizQuestions[state.quizIndex];

  return (
    <div className="flex h-full min-h-0 flex-col" aria-busy={busy}>
      <div className="border-b border-border/40 px-4 py-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <BookOpenCheck className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="truncate">
            {source?.title || readingContext?.currentChapter.title || book.meta.title}
          </span>
        </div>
        <div
          className="mt-2 grid grid-cols-3 gap-1"
          role="tablist"
          aria-label={t("learning.sections")}
        >
          {(
            [
              ["digest", t("learning.digest"), Quote],
              ["qa", t("learning.ask"), MessageCircleQuestion],
              ["quiz", t("learning.quiz"), ListChecks],
            ] as const
          ).map(([value, label, Icon]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              className={`flex h-8 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                tab === value
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => {
                setTab(value);
                if (value === "qa") requestAnimationFrame(() => questionRef.current?.focus());
              }}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        <output className="mb-4 flex items-start gap-2 text-xs" aria-live="polite">
          {state.phase === "unavailable" || state.phase === "error" ? (
            <CircleAlert
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive"
              aria-hidden="true"
            />
          ) : state.phase.endsWith("complete") ? (
            <CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
          ) : (
            <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-primary/70" aria-hidden="true" />
          )}
          <div className="min-w-0">
            <p className="font-medium text-foreground">{t(`learning.phase.${state.phase}`)}</p>
            {(state.phase === "unavailable" || state.phase === "error") && state.error && (
              <p className="mt-1 break-words leading-5 text-muted-foreground">{state.error}</p>
            )}
          </div>
        </output>

        {(state.phase === "unavailable" || state.phase === "error") && (
          <Button variant="outline" size="sm" onClick={() => setRetryKey((value) => value + 1)}>
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            {t("learning.retry")}
          </Button>
        )}

        {tab === "digest" && state.phase !== "unavailable" && state.phase !== "error" && (
          <section aria-labelledby="learning-digest-heading">
            <h2 id="learning-digest-heading" className="text-sm font-semibold">
              {t("learning.chapterDigest")}
            </h2>
            {!state.digest && (
              <div className="mt-3 border-l-2 border-border pl-3 text-xs leading-5 text-muted-foreground">
                <p>{t("learning.digestEmpty")}</p>
                <Button
                  className="mt-3"
                  size="sm"
                  disabled={!usable || busy}
                  onClick={handleDigest}
                >
                  {state.phase === "digest-loading"
                    ? t("learning.digestRunning")
                    : t("learning.runDigest")}
                </Button>
              </div>
            )}
            {state.digest && (
              <div className="mt-3 space-y-5 text-sm leading-6">
                <div>
                  <h3 className="text-xs font-medium text-muted-foreground">
                    {t("learning.summary")}
                  </h3>
                  <p className="mt-1 whitespace-pre-wrap">{state.digest.summary}</p>
                </div>
                <div>
                  <h3 className="text-xs font-medium text-muted-foreground">
                    {t("learning.concepts")}
                  </h3>
                  <dl className="mt-1 space-y-2">
                    {state.digest.concepts.map((concept) => (
                      <div key={`${concept.term}-${concept.explanation}`}>
                        <dt className="font-medium">{concept.term}</dt>
                        <dd className="text-muted-foreground">{concept.explanation}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
                <div>
                  <h3 className="text-xs font-medium text-muted-foreground">
                    {t("learning.keyQuotes")}
                  </h3>
                  <div className="mt-1 space-y-3">
                    {state.digest.quotes.map((quote) => (
                      <blockquote
                        key={`${quote.quote}-${quote.reason}`}
                        className="border-l-2 border-primary/40 pl-3"
                      >
                        <p>“{quote.quote}”</p>
                        <p className="mt-1 text-xs text-muted-foreground">{quote.reason}</p>
                        <CitationButton
                          citation={quote.citation}
                          onNavigate={onNavigateToCitation}
                        />
                      </blockquote>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </section>
        )}

        {tab === "qa" && state.phase !== "unavailable" && state.phase !== "error" && (
          <section aria-labelledby="learning-qa-heading">
            <h2 id="learning-qa-heading" className="text-sm font-semibold">
              {t("learning.groundedQa")}
            </h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("learning.qaScope")}</p>
            <label className="mt-3 block text-xs font-medium" htmlFor="learning-question">
              {t("learning.question")}
            </label>
            <textarea
              ref={questionRef}
              id="learning-question"
              rows={4}
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder={t("learning.questionPlaceholder")}
              className="mt-1 w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              disabled={!usable || busy}
            />
            <Button
              className="mt-2"
              size="sm"
              disabled={!usable || busy || !question.trim()}
              onClick={handleAsk}
            >
              {state.phase === "qa-streaming"
                ? t("learning.answerStreaming")
                : t("learning.askAction")}
            </Button>
            {state.answer && (
              <div className="mt-5 border-t border-border/50 pt-4">
                <h3 className="text-xs font-medium text-muted-foreground">
                  {t("learning.answer")}
                </h3>
                <p className="mt-1 whitespace-pre-wrap text-sm leading-6">{state.answer}</p>
                {state.citations.map((citation) => (
                  <CitationButton
                    key={`${citation.readAnyChapterId}-${citation.displayExcerpt}`}
                    citation={citation}
                    onNavigate={onNavigateToCitation}
                  />
                ))}
              </div>
            )}
          </section>
        )}

        {tab === "quiz" && state.phase !== "unavailable" && state.phase !== "error" && (
          <section aria-labelledby="learning-quiz-heading">
            <h2 id="learning-quiz-heading" className="text-sm font-semibold">
              {t("learning.chapterQuiz")}
            </h2>
            {!currentQuizQuestion && state.phase !== "quiz-complete" && (
              <div className="mt-3 border-l-2 border-border pl-3 text-xs leading-5 text-muted-foreground">
                <p>{t("learning.quizEmpty")}</p>
                <Button
                  className="mt-3"
                  size="sm"
                  disabled={!usable || busy}
                  onClick={handleStartQuiz}
                >
                  {state.phase === "quiz-loading"
                    ? t("learning.quizStarting")
                    : t("learning.startQuiz")}
                </Button>
              </div>
            )}
            {currentQuizQuestion && state.phase !== "quiz-complete" && (
              <div className="mt-3">
                <p className="text-sm font-medium leading-6">{currentQuizQuestion.question}</p>
                {currentQuizQuestion.options?.length ? (
                  <div className="mt-3 grid gap-2">
                    {currentQuizQuestion.options.map((option) => (
                      <button
                        key={option}
                        type="button"
                        className={`rounded-md border px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                          quizAnswer === option
                            ? "border-primary bg-primary/5"
                            : "border-border hover:bg-muted/50"
                        }`}
                        onClick={() => setQuizAnswer(option)}
                        disabled={Boolean(state.quizJudgement)}
                      >
                        {option}
                      </button>
                    ))}
                  </div>
                ) : (
                  <textarea
                    rows={3}
                    value={quizAnswer}
                    onChange={(event) => setQuizAnswer(event.target.value)}
                    placeholder={t("learning.quizAnswerPlaceholder")}
                    className="mt-3 w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    disabled={Boolean(state.quizJudgement)}
                  />
                )}
                {!state.quizJudgement ? (
                  <Button
                    className="mt-3"
                    size="sm"
                    disabled={!quizAnswer.trim()}
                    onClick={handleAnswerQuiz}
                  >
                    {t("learning.submitAnswer")}
                  </Button>
                ) : (
                  <div className="mt-4 border-l-2 border-primary/40 pl-3">
                    <p className="text-sm font-medium">
                      {state.quizJudgement.correct
                        ? t("learning.correct")
                        : t("learning.needsReview")}
                    </p>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">
                      {state.quizJudgement.explanation}
                    </p>
                    <Button className="mt-3" size="sm" variant="outline" onClick={handleFinishQuiz}>
                      {t("learning.finishQuiz")}
                    </Button>
                  </div>
                )}
              </div>
            )}
            {state.phase === "quiz-complete" && (
              <div className="mt-3 flex items-start gap-2 border-l-2 border-primary/40 pl-3 text-sm">
                <CircleCheck className="mt-1 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                <div>
                  <p className="font-medium">{t("learning.quizComplete")}</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {t("learning.quizNotMastery")}
                  </p>
                </div>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

function CitationButton({
  citation,
  onNavigate,
}: {
  citation: LearningCitation;
  onNavigate: (citation: LearningCitation) => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className="mt-2 block max-w-full text-left text-xs text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      title={citation.displayExcerpt}
      onClick={() => onNavigate(citation)}
    >
      {t("learning.backToSource")} · {t(`learning.precision.${citation.precision.toLowerCase()}`)}
    </button>
  );
}
