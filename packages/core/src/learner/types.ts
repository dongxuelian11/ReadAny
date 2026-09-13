// PR-004 Learner Core — deterministic learner state types (handoff §9 schemas
// adapted). Pure data and interfaces only: the LLM is never the Authority, and
// nothing in this module imports a model client. Storage lives behind
// interfaces so hosts implement SQLite adapters (wiring PR) while tests use
// in-memory stores (skillcoco-core structural pattern, PR-003 audit).

export type EvidenceSource =
  | "TEACHING"
  | "READ_BOX_QUIZ"
  | "BOOK_QUIZ"
  | "PLACEMENT"
  | "REVIEW"
  | "MANUAL"
  /** LLM observations are evidence CANDIDATES only (handoff §9) — they must be
   * admitted through a deterministic gate before they can appear here. */
  | "LLM_OBSERVATION";

export type EvidenceTaskType = "quiz" | "teach_back" | "transfer" | "review" | "placement";

/** Question shape of the evidence (drives the OpenTutor guess/slip table). */
export type EvidenceQuestionType =
  | "mc"
  | "tf"
  | "short_answer"
  | "fill_blank"
  | "matching"
  | "select_all"
  | "free_response";

export type EvidenceResult = "correct" | "incorrect";

/**
 * How the evidence was verified — the admission-authority axis (PR-014).
 * The weight this evidence carries into BKT is derived from this, not from
 * the `confidence` field. Absent = legacy unclassified evidence (full weight,
 * transitional); `llm_judged` evidence is down-weighted; `LLM_OBSERVATION`
 * events MUST carry an admitted verification or the engine rejects them.
 */
export type EvidenceVerification =
  | "deterministic_keyed"
  | "llm_judged"
  | "user_confirmed"
  | "placement_inferred";

export interface EvidenceSourceLocator {
  bookId?: string;
  chapterIndex?: number;
  cfi?: string;
}

/** One immutable learning-evidence record (handoff §9 EvidenceEvent). */
export interface EvidenceEvent {
  /** Caller-supplied unique id; the append-only store rejects duplicates. */
  id: string;
  conceptId: string;
  source: EvidenceSource;
  taskType: EvidenceTaskType;
  questionType?: EvidenceQuestionType;
  /** OpenTutor difficulty layer: 1=recall, 2=application, 3=trap. */
  difficulty?: 1 | 2 | 3;
  result: EvidenceResult;
  /** Evidence confidence in [0,1], recorded for future weighting. The ported
   * references update BKT from the result alone, so this never silently
   * rescales mastery. */
  confidence: number;
  /** Admission authority (PR-014): how this evidence was verified. Drives the
   * BKT admission weight; see EvidenceVerification. */
  verification?: EvidenceVerification;
  /** Epoch millis, supplied by the injected learner clock. */
  timestamp: number;
  sourceLocator?: EvidenceSourceLocator;
}

export type MasteryStatus = "unseen" | "learning" | "stable" | "needs_review";

/** Per-concept mastery state (handoff §9 ConceptMastery). */
export interface ConceptMastery {
  conceptId: string;
  /** BKT posterior in [0,1]. */
  mastery: number;
  /** Evidence-backed confidence in [0,1] — saturates at the audit's 15-observation EM-upgrade gate. */
  confidence: number;
  /** FSRS retrievability in [0,1] at evaluation time; null before any review. */
  retention: number | null;
  /** Reserved for the future transfer component (PR-003 verdict: BUILD_FRESH). */
  transfer: number | null;
  /** Epoch millis of the last evidence event; null when unseen. */
  lastVerified: number | null;
  /** FSRS due time as epoch millis; null before any review. */
  nextReview: number | null;
  status: MasteryStatus;
  evidenceCount: number;
  updatedAt: number;
  /** Commit marker (iter-1): id of the evidence event this row already
   * reflects. Rows written before the marker protocol have no marker; they are
   * prior state, never treated as an already-applied event. */
  lastEventId?: string | null;
}

/** Serializable FSRS card state for one concept (epoch millis; deliberately
 * excludes ts-fsrs's deprecated elapsed_days/last_elapsed_days fields). */
export interface LearnerReviewCardData {
  conceptId: string;
  due: number;
  stability: number;
  difficulty: number;
  learningSteps: number;
  reps: number;
  lapses: number;
  /** ts-fsrs State enum value (New=0, Learning=1, Review=2, Relearning=3). */
  state: number;
  lastReview: number | null;
  /** Commit marker (iter-1): id of the evidence event whose FSRS review this
   * card already reflects. Cards written before the marker protocol have no
   * marker; they are prior state, never treated as an already-applied event. */
  lastEventId?: string | null;
}

/** Serializable FSRS review log (audit trail; append-only like evidence).
 * Field semantics follow ts-fsrs ReviewLog: `state`/`stability`/`difficulty`/
 * `due` describe the card AS IT WAS BEFORE this review. */
export interface LearnerReviewLogEntry {
  conceptId: string;
  /** ts-fsrs Rating value (Again=1, Hard=2, Good=3, Easy=4). */
  rating: number;
  state: number;
  due: number;
  stability: number;
  difficulty: number;
  scheduledDays: number;
  learningSteps: number;
  review: number;
  /** Commit marker (iter-1): the evidence event that produced this review.
   * Durable adapters key a partial unique index on it so a replayed write is a
   * no-op; legacy rows have no event id. */
  eventId?: string | null;
}

/** Injected wall clock (skillcoco-core pattern) — tests pass a fixed clock. */
export interface LearnerClock {
  now(): Date;
}

export interface LearnerEvidenceStore {
  /** Append one event; must reject duplicate ids (append-only, never upserted). */
  append(event: EvidenceEvent): Promise<void>;
  /** One event by id, or null; used to distinguish a replayed append from an
   * input conflict when the ledger rejects a duplicate id. */
  getById(id: string): Promise<EvidenceEvent | null>;
  /** All events for a concept, ascending by timestamp. */
  listByConcept(conceptId: string): Promise<EvidenceEvent[]>;
  countByConcept(conceptId: string): Promise<number>;
}

export interface LearnerMasteryStore {
  get(conceptId: string): Promise<ConceptMastery | null>;
  put(mastery: ConceptMastery): Promise<void>;
}

export interface LearnerReviewStore {
  getCard(conceptId: string): Promise<LearnerReviewCardData | null>;
  putCard(card: LearnerReviewCardData): Promise<void>;
  appendLog(entry: LearnerReviewLogEntry): Promise<void>;
  /** Cards whose due time is at or before the given epoch millis, ascending by due. */
  listCardsDueBefore(timestamp: number, limit?: number): Promise<LearnerReviewCardData[]>;
  /** Whether a review log row exists for this event id (optional: legacy
   * stores without event-id logging return false). Used by the upgrade
   * boundary to tell a genuine partial apply apart from a pre-completion
   * legacy row whose FSRS step already ran. */
  hasLogForEvent?(eventId: string): Promise<boolean>;
}

/**
 * Confirmation metadata for evidence the learner vouched for (iter-1). A
 * confirmation is a pure annotation: it must never produce a second BKT update
 * or a second FSRS review — those happen once, through the evidence event
 * itself. Append-only: one row per evidence id.
 */
export interface LearnerEvidenceConfirmationStore {
  /** Record the learner's confirmation of one evidence event (idempotent). */
  record(evidenceId: string, confirmedAt: number): Promise<void>;
  /** Confirmation time in epoch millis, or null when not confirmed. */
  get(evidenceId: string): Promise<number | null>;
}
