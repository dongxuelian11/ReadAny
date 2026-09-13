// WP-A (2026-09-13): the narrow atomic learner commit. The TypeScript engine
// computes BKT/FSRS outcomes and hands them over with EXPECTED prior-state
// markers; this command verifies the markers inside ONE rusqlite transaction
// (BEGIN IMMEDIATE) and writes the evidence row, review log, card, mastery,
// the completion record, and — for teaching answers — the guarded session
// advance. Outcomes: applied / alreadyApplied / stale / conflict /
// sessionStale. Everything rolls back unless every guard passes, so a
// partially applied attempt can never be reported done and a late answer can
// never advance a superseded session.
//
// This is deliberately NOT a generic SQL surface: one fixed request shape, one
// fixed set of statements.

use rusqlite::{Connection, OptionalExtension};
use serde::Deserialize;
use serde::Serialize;
use tauri::AppHandle;

use crate::storage::resolve_data_root;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceLocator {
    book_id: Option<String>,
    chapter_index: Option<i64>,
    cfi: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvidenceEvent {
    id: String,
    concept_id: String,
    source: String,
    task_type: String,
    question_type: Option<String>,
    difficulty: Option<i64>,
    result: String,
    confidence: f64,
    verification: Option<String>,
    timestamp: i64,
    source_locator: Option<SourceLocator>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewLog {
    concept_id: String,
    rating: i64,
    state: i64,
    due: i64,
    stability: f64,
    difficulty: f64,
    scheduled_days: i64,
    learning_steps: i64,
    review: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewCard {
    concept_id: String,
    due: i64,
    stability: f64,
    difficulty: f64,
    learning_steps: i64,
    reps: i64,
    lapses: i64,
    state: i64,
    last_review: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Mastery {
    concept_id: String,
    mastery: f64,
    confidence: f64,
    retention: Option<f64>,
    transfer: Option<f64>,
    last_verified: Option<i64>,
    next_review: Option<i64>,
    status: String,
    evidence_count: i64,
    updated_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionCommit {
    expected: SessionGuard,
    session: SessionRow,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionGuard {
    id: String,
    status: String,
    current_index: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionRow {
    id: String,
    goal_id: String,
    book_id: String,
    status: String,
    steps_json: String,
    current_index: i64,
    started_at: i64,
    completed_at: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitRequest {
    event: EvidenceEvent,
    payload_json: String,
    log: Option<ReviewLog>,
    card: ReviewCard,
    mastery: Mastery,
    expected_card_last_event_id: Option<String>,
    expected_mastery_last_event_id: Option<String>,
    session: Option<SessionCommit>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CommitOk {
    outcome: &'static str,
    mastery: Option<MasteryRow>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct MasteryRow {
    concept_id: String,
    mastery: f64,
    confidence: f64,
    retention: Option<f64>,
    transfer: Option<f64>,
    last_verified: Option<i64>,
    next_review: Option<i64>,
    status: String,
    evidence_count: i64,
    updated_at: i64,
    last_event_id: Option<String>,
}

fn open_db(app: &AppHandle) -> Result<Connection, String> {
    let root = resolve_data_root(app)?;
    let path = root.join("readany.db");
    let conn = Connection::open(&path).map_err(|e| format!("failed to open {}: {}", path.display(), e))?;
    conn.busy_timeout(std::time::Duration::from_millis(15_000))
        .map_err(|e| e.to_string())?;
    Ok(conn)
}

fn read_mastery(conn: &Connection, concept_id: &str) -> Result<Option<MasteryRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT concept_id, mastery, confidence, retention, transfer, last_verified,
                    next_review, status, evidence_count, updated_at, last_event_id
             FROM learner_concept_mastery WHERE concept_id = ?1",
        )
        .map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query([concept_id])
        .map_err(|e| e.to_string())?;
    if let Some(row) = rows.next().map_err(|e| e.to_string())? {
        return Ok(Some(MasteryRow {
            concept_id: row.get(0).map_err(|e| e.to_string())?,
            mastery: row.get(1).map_err(|e| e.to_string())?,
            confidence: row.get(2).map_err(|e| e.to_string())?,
            retention: row.get(3).map_err(|e| e.to_string())?,
            transfer: row.get(4).map_err(|e| e.to_string())?,
            last_verified: row.get(5).map_err(|e| e.to_string())?,
            next_review: row.get(6).map_err(|e| e.to_string())?,
            status: row.get(7).map_err(|e| e.to_string())?,
            evidence_count: row.get(8).map_err(|e| e.to_string())?,
            updated_at: row.get(9).map_err(|e| e.to_string())?,
            last_event_id: row.get(10).map_err(|e| e.to_string())?,
        }));
    }
    Ok(None)
}

#[tauri::command]
pub fn learner_commit(app: AppHandle, request: CommitRequest) -> Result<CommitOk, String> {
    let mut conn = open_db(&app)?;
    ensure_schema(&conn)?;
    commit_on_conn(&mut conn, &request)
}

/// PR32-followup (F03): rebuild learner_review_logs without the legacy
/// UNIQUE(concept_id, review) table constraint. Called from startup
/// (db::init_database_sync) on ONE real connection — the SQL plugin pool must
/// never be handed cross-statement BEGIN/COMMIT (each pooled execute can land
/// on a different connection, which silently no-ops the transaction).
/// Best-effort backup first; returns whether a rebuild ran.
pub fn migrate_review_logs_on_conn(
    conn: &mut Connection,
    backup_path: Option<&str>,
) -> Result<bool, String> {
    let legacy: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_index_list('learner_review_logs') WHERE origin = 'u'",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if legacy == 0 {
        return Ok(false);
    }
    if let Some(path) = backup_path {
        // Best-effort consistent snapshot BEFORE the rebuild; VACUUM cannot
        // run inside a transaction, and a pre-existing snapshot file makes
        // this fail harmlessly.
        let escaped = path.replace('\'', "''");
        let _ = conn.execute(format!("VACUUM INTO '{}'", escaped).as_str(), []);
    }
    let tx = conn
        .transaction()
        .map_err(|e| format!("failed to begin transaction: {}", e))?;
    // A scratch table left by an interrupted earlier attempt is dropped first;
    // at that point the real table is untouched.
    tx.execute("DROP TABLE IF EXISTS learner_review_logs_identity", [])
        .map_err(|e| e.to_string())?;
    tx.execute(
        "CREATE TABLE learner_review_logs_identity (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           concept_id TEXT NOT NULL,
           rating INTEGER NOT NULL,
           state INTEGER NOT NULL,
           due INTEGER NOT NULL,
           stability REAL NOT NULL,
           difficulty REAL NOT NULL,
           scheduled_days INTEGER NOT NULL,
           learning_steps INTEGER NOT NULL,
           review INTEGER NOT NULL,
           event_id TEXT
         )",
        [],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO learner_review_logs_identity
           (id, concept_id, rating, state, due, stability, difficulty,
            scheduled_days, learning_steps, review, event_id)
         SELECT id, concept_id, rating, state, due, stability, difficulty,
                scheduled_days, learning_steps, review, event_id
         FROM learner_review_logs",
        [],
    )
    .map_err(|e| e.to_string())?;
    tx.execute("DROP TABLE learner_review_logs", [])
        .map_err(|e| e.to_string())?;
    tx.execute(
        "ALTER TABLE learner_review_logs_identity RENAME TO learner_review_logs",
        [],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| format!("failed to commit: {}", e))?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_learner_review_logs_concept ON learner_review_logs(concept_id, review)",
        [],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_learner_review_logs_event ON learner_review_logs(event_id) WHERE event_id IS NOT NULL",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(true)
}

/// The whole commit against ONE connection (testable with in-memory SQLite).
pub fn commit_on_conn(conn: &mut Connection, request: &CommitRequest) -> Result<CommitOk, String> {
    let tx = conn
        .transaction()
        .map_err(|e| format!("failed to begin transaction: {}", e))?;

    // 1. Completion record gate: a replayed fully-applied attempt is a no-op;
    //    a different payload under the same id is a conflict — unless the
    //    stored fingerprint is the PRE-FIX degraded one (nested sourceLocator
    //    collapsed to `{}`), in which case the durable event row decides.
    let recorded: Option<String> = tx
        .query_row(
            "SELECT payload_json FROM learner_evidence_completions WHERE evidence_id = ?1",
            [&request.event.id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(payload) = recorded {
        if payload != request.payload_json {
            // PR32-followup (F04): a legacy fingerprint cannot arbitrate a
            // conflict — compare the stored event's immutable fields directly
            // and upgrade the fingerprint when they match the replay.
            let legacy_match: Option<i64> = tx
                .query_row(
                    "SELECT COUNT(*) FROM learner_evidence_events WHERE id = ?1
                     AND concept_id = ?2 AND source = ?3 AND task_type = ?4
                     AND question_type IS ?5 AND difficulty IS ?6 AND result = ?7
                     AND confidence = ?8 AND verification IS ?9
                     AND source_book_id IS ?10 AND source_chapter_index IS ?11
                     AND source_cfi IS ?12",
                    rusqlite::params![
                        request.event.id,
                        request.event.concept_id,
                        request.event.source,
                        request.event.task_type,
                        request.event.question_type,
                        request.event.difficulty,
                        request.event.result,
                        request.event.confidence,
                        request.event.verification,
                        request.event.source_locator.as_ref().and_then(|l| l.book_id.clone()),
                        request.event.source_locator.as_ref().and_then(|l| l.chapter_index),
                        request.event.source_locator.as_ref().and_then(|l| l.cfi.clone()),
                    ],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if legacy_match.unwrap_or(0) == 0 {
                return Err("__conflict__".into());
            }
            // The upgrade is a WRITE: it must be committed — the early-return
            // paths above rely on tx-drop rollback, which would silently undo
            // it here.
            tx.execute(
                "UPDATE learner_evidence_completions SET payload_json = ?2 WHERE evidence_id = ?1",
                rusqlite::params![request.event.id, request.payload_json],
            )
            .map_err(|e| e.to_string())?;
            let mastery = read_mastery(&tx, &request.event.concept_id)?;
            tx.commit().map_err(|e| format!("failed to commit: {}", e))?;
            return Ok(CommitOk { outcome: "alreadyApplied", mastery });
        }
        let mastery = read_mastery(&tx, &request.event.concept_id)?;
        return Ok(CommitOk { outcome: "alreadyApplied", mastery });
    }
    // 2. Existing ledger row: resume only when the immutable payload matches.
    let stored_payload: Option<(String, String, String)> = tx
        .query_row(
            "SELECT concept_id, result, source FROM learner_evidence_events WHERE id = ?1",
            [&request.event.id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })
        .map_err(|e| e.to_string())?;
    if stored_payload.is_none() {
        let locator = request.event.source_locator.as_ref();
        tx.execute(
            "INSERT INTO learner_evidence_events
              (id, concept_id, source, task_type, question_type, difficulty, result, confidence,
               verification, timestamp, source_book_id, source_chapter_index, source_cfi)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            rusqlite::params![
                request.event.id,
                request.event.concept_id,
                request.event.source,
                request.event.task_type,
                request.event.question_type,
                request.event.difficulty,
                request.event.result,
                request.event.confidence,
                request.event.verification,
                request.event.timestamp,
                locator.and_then(|l| l.book_id.clone()),
                locator.and_then(|l| l.chapter_index),
                locator.and_then(|l| l.cfi.clone()),
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    // 3. Compare-and-swap guards on the markers the engine read.
    //    PR32-followup (F02): the marker cells are NULLABLE — a placement-
    //    finalized mastery row legitimately has last_event_id = NULL. The old
    //    `query_row(...).map(Some)` chain inferred the cell type as String, so
    //    a present row with a NULL marker raised InvalidColumnType and broke
    //    the very first practice after placement. Read Option<String>
    //    explicitly; `optional()` only maps the no-rows case to None.
    let card_marker = tx
        .query_row(
            "SELECT last_event_id FROM learner_review_cards WHERE concept_id = ?1",
            [&request.card.concept_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })
        .map_err(|e| e.to_string())?;
    if card_marker != request.expected_card_last_event_id {
        return Err("__stale__".into());
    }
    let mastery_marker = tx
        .query_row(
            "SELECT last_event_id FROM learner_concept_mastery WHERE concept_id = ?1",
            [&request.mastery.concept_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })
        .map_err(|e| e.to_string())?;
    if mastery_marker != request.expected_mastery_last_event_id {
        return Err("__stale__".into());
    }

    // 4. Teaching-session guard: the answer only commits while the stored
    //    session is still the one the learner was answering.
    if let Some(session) = &request.session {
        let current: Option<(String, i64)> = tx
            .query_row(
                "SELECT status, current_index FROM learner_teaching_sessions WHERE id = ?1",
                [&session.expected.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })
            .map_err(|e| e.to_string())?;
        match current {
            Some((status, index))
                if status == session.expected.status
                    && index == session.expected.current_index => {}
            _ => return Err("__sessionStale__".into()),
        }
    }

    // 5. Writes: review log (idempotent per event id), card, mastery, session,
    //    completion record.
    //    PR32-followup (F03): the log insert is deduped by EVENT ID only. The
    //    old `INSERT OR IGNORE` also silently swallowed the legacy
    //    UNIQUE(concept_id, review) violation, dropping a genuinely different
    //    attempt that happened to share the same review millisecond while the
    //    rest of the commit still reported success. Check by event id, then
    //    plain-INSERT so any remaining constraint failure is LOUD.
    if let Some(log) = &request.log {
        let existing_log: Option<i64> = tx
            .query_row(
                "SELECT id FROM learner_review_logs WHERE event_id = ?1",
                [&request.event.id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if existing_log.is_none() {
            tx.execute(
                "INSERT INTO learner_review_logs
                  (concept_id, rating, state, due, stability, difficulty, scheduled_days,
                   learning_steps, review, event_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                rusqlite::params![
                    log.concept_id,
                    log.rating,
                    log.state,
                    log.due,
                    log.stability,
                    log.difficulty,
                    log.scheduled_days,
                    log.learning_steps,
                    log.review,
                    request.event.id,
                ],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    tx.execute(
        "INSERT OR REPLACE INTO learner_review_cards
          (concept_id, due, stability, difficulty, learning_steps, reps, lapses, state,
           last_review, last_event_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        rusqlite::params![
            request.card.concept_id,
            request.card.due,
            request.card.stability,
            request.card.difficulty,
            request.card.learning_steps,
            request.card.reps,
            request.card.lapses,
            request.card.state,
            request.card.last_review,
            request.event.id,
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT OR REPLACE INTO learner_concept_mastery
          (concept_id, mastery, confidence, retention, transfer, last_verified, next_review,
           status, evidence_count, updated_at, last_event_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        rusqlite::params![
            request.mastery.concept_id,
            request.mastery.mastery,
            request.mastery.confidence,
            request.mastery.retention,
            request.mastery.transfer,
            request.mastery.last_verified,
            request.mastery.next_review,
            request.mastery.status,
            request.mastery.evidence_count,
            request.mastery.updated_at,
            request.event.id,
        ],
    )
    .map_err(|e| e.to_string())?;
    if let Some(session) = &request.session {
        tx.execute(
            "INSERT OR REPLACE INTO learner_teaching_sessions
              (id, goal_id, book_id, status, steps_json, current_index, started_at, completed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                session.session.id,
                session.session.goal_id,
                session.session.book_id,
                session.session.status,
                session.session.steps_json,
                session.session.current_index,
                session.session.started_at,
                session.session.completed_at,
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.execute(
        "INSERT OR IGNORE INTO learner_evidence_completions (evidence_id, payload_json, applied_at)
         VALUES (?1, ?2, ?3)",
        rusqlite::params![request.event.id, request.payload_json, request.event.timestamp],
    )
    .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| format!("failed to commit: {}", e))?;
    Ok(CommitOk { outcome: "applied", mastery: None })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_request(event_id: &str, payload: &str) -> CommitRequest {
        CommitRequest {
            event: EvidenceEvent {
                id: event_id.into(),
                concept_id: "c1".into(),
                source: "REVIEW".into(),
                task_type: "review".into(),
                question_type: Some("mc".into()),
                difficulty: None,
                result: "correct".into(),
                confidence: 1.0,
                verification: Some("deterministic_keyed".into()),
                timestamp: 1000,
                source_locator: None,
            },
            payload_json: payload.into(),
            log: Some(ReviewLog {
                concept_id: "c1".into(),
                rating: 3,
                state: 0,
                due: 2000,
                stability: 1.0,
                difficulty: 5.0,
                scheduled_days: 1,
                learning_steps: 0,
                review: 1000,
            }),
            card: ReviewCard {
                concept_id: "c1".into(),
                due: 2000,
                stability: 1.0,
                difficulty: 5.0,
                learning_steps: 0,
                reps: 1,
                lapses: 0,
                state: 2,
                last_review: Some(1000),
            },
            mastery: Mastery {
                concept_id: "c1".into(),
                mastery: 0.5,
                confidence: 0.1,
                retention: Some(0.9),
                transfer: None,
                last_verified: Some(1000),
                next_review: Some(2000),
                status: "learning".into(),
                evidence_count: 1,
                updated_at: 1000,
            },
            expected_card_last_event_id: None,
            expected_mastery_last_event_id: None,
            session: None,
        }
    }

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open");
        conn.execute_batch(
            "CREATE TABLE learner_evidence_events (
               id TEXT PRIMARY KEY, concept_id TEXT NOT NULL, source TEXT NOT NULL,
               task_type TEXT NOT NULL, question_type TEXT, difficulty INTEGER, result TEXT NOT NULL,
               confidence REAL NOT NULL, verification TEXT, timestamp INTEGER NOT NULL,
               source_book_id TEXT, source_chapter_index INTEGER, source_cfi TEXT);
             CREATE TABLE learner_review_cards (
               concept_id TEXT PRIMARY KEY, due INTEGER NOT NULL, stability REAL NOT NULL,
               difficulty REAL NOT NULL, learning_steps INTEGER NOT NULL, reps INTEGER NOT NULL,
               lapses INTEGER NOT NULL, state INTEGER NOT NULL, last_review INTEGER,
               last_event_id TEXT);
             CREATE TABLE learner_review_logs (
               id INTEGER PRIMARY KEY AUTOINCREMENT, concept_id TEXT NOT NULL, rating INTEGER NOT NULL,
               state INTEGER NOT NULL, due INTEGER NOT NULL, stability REAL NOT NULL,
               difficulty REAL NOT NULL, scheduled_days INTEGER NOT NULL, learning_steps INTEGER NOT NULL,
               review INTEGER NOT NULL, event_id TEXT);
             CREATE UNIQUE INDEX idx_logs_event ON learner_review_logs(event_id) WHERE event_id IS NOT NULL;
             CREATE TABLE learner_concept_mastery (
               concept_id TEXT PRIMARY KEY, mastery REAL NOT NULL, confidence REAL NOT NULL,
               retention REAL, transfer REAL, last_verified INTEGER, next_review INTEGER,
               status TEXT NOT NULL, evidence_count INTEGER NOT NULL, updated_at INTEGER NOT NULL,
               last_event_id TEXT);
             CREATE TABLE learner_teaching_sessions (
               id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, book_id TEXT NOT NULL, status TEXT NOT NULL,
               steps_json TEXT NOT NULL, current_index INTEGER NOT NULL, started_at INTEGER NOT NULL,
               completed_at INTEGER);
             CREATE TABLE learner_evidence_completions (
               evidence_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, applied_at INTEGER NOT NULL);",
        )
        .expect("schema");
        conn
    }

    #[test]
    fn historical_replay_after_later_event_is_a_noop() {
        let mut conn = test_conn();
        // A
        let req_a = base_request("A", "payload-A");
        assert_eq!(commit_on_conn(&mut conn, &req_a).unwrap().outcome, "applied");
        // B (same concept, later event, different id) — the engine would pass
        // A's markers as the expected prior state.
        let mut req_b = base_request("B", "payload-B");
        req_b.event.timestamp = 2000;
        req_b.log.as_mut().unwrap().review = 2000;
        req_b.expected_card_last_event_id = Some("A".into());
        req_b.expected_mastery_last_event_id = Some("A".into());
        // The engine would have computed B's FSRS step from A's card.
        req_b.card.reps = 2;
        assert_eq!(commit_on_conn(&mut conn, &req_b).unwrap().outcome, "applied");
        // Replay of A long after B: alreadyApplied, no third write.
        let mut req_a_replay = base_request("A", "payload-A");
        req_a_replay.event.timestamp = 9000;
        let result = commit_on_conn(&mut conn, &req_a_replay).unwrap();
        assert_eq!(result.outcome, "alreadyApplied");

        let log_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM learner_review_logs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(log_count, 2);
        let reps: i64 = conn
            .query_row("SELECT reps FROM learner_review_cards WHERE concept_id = 'c1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(reps, 2);
        let last_event: String = conn
            .query_row("SELECT last_event_id FROM learner_concept_mastery WHERE concept_id = 'c1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(last_event, "B");
    }

    #[test]
    fn same_id_different_payload_is_conflict_and_rolls_back() {
        let mut conn = test_conn();
        let req = base_request("A", "payload-A");
        assert_eq!(commit_on_conn(&mut conn, &req).unwrap().outcome, "applied");
        // PR32-followup: the fingerprint is a pure function of the event's
        // immutable fields, so a GENUINE payload difference means a changed
        // field — here the verdict flips under the same attempt id.
        let mut conflicting = base_request("A", "payload-DIFFERENT");
        conflicting.event.result = "incorrect".into();
        conflicting.mastery.mastery = 0.99;
        let err = commit_on_conn(&mut conn, &conflicting).unwrap_err();
        assert_eq!(err, "__conflict__");
        let mastery: f64 = conn
            .query_row("SELECT mastery FROM learner_concept_mastery WHERE concept_id = 'c1'", [], |r| r.get(0))
            .unwrap();
        assert!((mastery - 0.5).abs() < 1e-9, "state must be untouched");
        let stored_result: String = conn
            .query_row("SELECT result FROM learner_evidence_events WHERE id = 'A'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stored_result, "correct", "the stored event is never overwritten");
    }

    #[test]
    fn stale_marker_rolls_back_everything() {
        let mut conn = test_conn();
        let mut req = base_request("A", "payload-A");
        req.expected_card_last_event_id = Some("GHOST".into());
        let err = commit_on_conn(&mut conn, &req).unwrap_err();
        assert_eq!(err, "__stale__");
        let evidence: i64 = conn
            .query_row("SELECT COUNT(*) FROM learner_evidence_events", [], |r| r.get(0))
            .unwrap();
        assert_eq!(evidence, 0, "no partial evidence row may survive a stale guard");
        let completions: i64 = conn
            .query_row("SELECT COUNT(*) FROM learner_evidence_completions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(completions, 0);
    }

    #[test]
    fn session_guard_refuses_a_superseded_session() {
        let mut conn = test_conn();
        conn.execute(
            "INSERT INTO learner_teaching_sessions VALUES ('s1','g','b','abandoned','[]',0,1,NULL)",
            [],
        )
        .unwrap();
        let mut req = base_request("A", "payload-A");
        req.session = Some(SessionCommit {
            expected: SessionGuard { id: "s1".into(), status: "active".into(), current_index: 0 },
            session: SessionRow {
                id: "s1".into(),
                goal_id: "g".into(),
                book_id: "b".into(),
                status: "completed".into(),
                steps_json: "[]".into(),
                current_index: 1,
                started_at: 1,
                completed_at: Some(2),
            },
        });
        let err = commit_on_conn(&mut conn, &req).unwrap_err();
        assert_eq!(err, "__sessionStale__");
        let status: String = conn
            .query_row("SELECT status FROM learner_teaching_sessions WHERE id = 's1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(status, "abandoned", "late answer must not revive the session");
        let evidence: i64 = conn
            .query_row("SELECT COUNT(*) FROM learner_evidence_events", [], |r| r.get(0))
            .unwrap();
        assert_eq!(evidence, 0, "the answer itself must not be recorded either");
    }

    // PR32-followup regression tests (F02/F03/F04). The test schema above uses
    // the REBUILT review-log shape (no legacy UNIQUE(concept_id, review)),
    // matching db-core.ts after the identity migration.

    #[test]
    fn null_markers_after_placement_are_read_as_none() {
        let mut conn = test_conn();
        // A placement finalize writes mastery/card rows WITHOUT last_event_id
        // (SQL NULL) — the normal "placement, then first practice" path.
        conn.execute(
            "INSERT INTO learner_concept_mastery VALUES ('c1',0.4,0.0,NULL,NULL,1000,NULL,'learning',0,1000,NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO learner_review_cards VALUES ('c1',2000,1.0,5.0,0,0,0,0,NULL,NULL)",
            [],
        )
        .unwrap();
        let req = base_request("A", "payload-A");
        let result = commit_on_conn(&mut conn, &req).unwrap();
        assert_eq!(result.outcome, "applied", "NULL markers must read as None, not raise");
        let marker: Option<String> = conn
            .query_row("SELECT last_event_id FROM learner_concept_mastery WHERE concept_id='c1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(marker.as_deref(), Some("A"));
    }

    #[test]
    fn two_attempts_same_concept_same_time_both_logged() {
        let mut conn = test_conn();
        let req_a = base_request("A", "payload-A");
        assert_eq!(commit_on_conn(&mut conn, &req_a).unwrap().outcome, "applied");
        // A genuinely different attempt at the SAME review instant (fixed-clock
        // batch replay) must get its OWN log row — never silently ignored.
        let mut req_b = base_request("B", "payload-B");
        req_b.expected_card_last_event_id = Some("A".into());
        req_b.expected_mastery_last_event_id = Some("A".into());
        req_b.card.reps = 2;
        assert_eq!(commit_on_conn(&mut conn, &req_b).unwrap().outcome, "applied");
        let logs: i64 = conn
            .query_row("SELECT COUNT(*) FROM learner_review_logs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(logs, 2, "both attempts keep their review log");
        // Same-attempt replay still does not duplicate the log.
        let replay = base_request("A", "payload-A");
        assert_eq!(commit_on_conn(&mut conn, &replay).unwrap().outcome, "alreadyApplied");
        let logs_after_replay: i64 = conn
            .query_row("SELECT COUNT(*) FROM learner_review_logs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(logs_after_replay, 2);
    }

    #[test]
    fn old_schema_same_time_second_attempt_fails_loudly_not_silently() {
        // Pre-migration databases still carry UNIQUE(concept_id, review). The
        // commit must FAIL there (so the user sees an error and the migration
        // runs) instead of OR IGNORE silently dropping the second attempt.
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE learner_evidence_events (
               id TEXT PRIMARY KEY, concept_id TEXT NOT NULL, source TEXT NOT NULL,
               task_type TEXT NOT NULL, question_type TEXT, difficulty INTEGER, result TEXT NOT NULL,
               confidence REAL NOT NULL, verification TEXT, timestamp INTEGER NOT NULL,
               source_book_id TEXT, source_chapter_index INTEGER, source_cfi TEXT);
             CREATE TABLE learner_review_cards (
               concept_id TEXT PRIMARY KEY, due INTEGER NOT NULL, stability REAL NOT NULL,
               difficulty REAL NOT NULL, learning_steps INTEGER NOT NULL, reps INTEGER NOT NULL,
               lapses INTEGER NOT NULL, state INTEGER NOT NULL, last_review INTEGER,
               last_event_id TEXT);
             CREATE TABLE learner_review_logs (
               id INTEGER PRIMARY KEY AUTOINCREMENT, concept_id TEXT NOT NULL, rating INTEGER NOT NULL,
               state INTEGER NOT NULL, due INTEGER NOT NULL, stability REAL NOT NULL,
               difficulty REAL NOT NULL, scheduled_days INTEGER NOT NULL, learning_steps INTEGER NOT NULL,
               review INTEGER NOT NULL, event_id TEXT, UNIQUE(concept_id, review));
             CREATE TABLE learner_concept_mastery (
               concept_id TEXT PRIMARY KEY, mastery REAL NOT NULL, confidence REAL NOT NULL,
               retention REAL, transfer REAL, last_verified INTEGER, next_review INTEGER,
               status TEXT NOT NULL, evidence_count INTEGER NOT NULL, updated_at INTEGER NOT NULL,
               last_event_id TEXT);
             CREATE TABLE learner_evidence_completions (
               evidence_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, applied_at INTEGER NOT NULL);",
        )
        .unwrap();
        let req_a = base_request("A", "payload-A");
        assert_eq!(commit_on_conn(&mut conn, &req_a).unwrap().outcome, "applied");
        let mut req_b = base_request("B", "payload-B");
        req_b.expected_card_last_event_id = Some("A".into());
        req_b.expected_mastery_last_event_id = Some("A".into());
        req_b.card.reps = 2;
        let result = commit_on_conn(&mut conn, &req_b);
        assert!(result.is_err(), "an un-migrated UNIQUE(concept_id, review) must fail loudly");
        // Nothing half-committed: no evidence row for B, no completion for B.
        let b_evidence: i64 = conn
            .query_row("SELECT COUNT(*) FROM learner_evidence_events WHERE id='B'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(b_evidence, 0);
        let b_completion: i64 = conn
            .query_row("SELECT COUNT(*) FROM learner_evidence_completions WHERE evidence_id='B'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(b_completion, 0);
    }

    #[test]
    fn legacy_completion_fingerprint_upgrades_from_the_stored_event() {
        let mut conn = test_conn();
        // The pre-fix engine recorded a payload whose nested sourceLocator was
        // collapsed to {}; the event ROW, however, carries the real locator.
        conn.execute(
            "INSERT INTO learner_evidence_events VALUES
              ('A','c1','REVIEW','review','mc',NULL,'correct',1.0,'deterministic_keyed',1000,'b',0,'epubcfi(/4)')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO learner_evidence_completions VALUES ('A','{\"sourceLocator\":{}}',1000)",
            [],
        )
        .unwrap();
        let mut req = base_request("A", "{\"sourceLocator\":{\"bookId\":\"b\",\"chapterIndex\":0,\"cfi\":\"epubcfi(/4)\"}}");
        req.event.source_locator = Some(SourceLocator {
            book_id: Some("b".into()),
            chapter_index: Some(0),
            cfi: Some("epubcfi(/4)".into()),
        });
        let result = commit_on_conn(&mut conn, &req).unwrap();
        assert_eq!(result.outcome, "alreadyApplied", "a same-attempt replay with a legacy fingerprint must not conflict");
        let upgraded: String = conn
            .query_row("SELECT payload_json FROM learner_evidence_completions WHERE evidence_id='A'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(upgraded, req.payload_json, "the fingerprint is upgraded to the canonical form");
    }

    #[test]
    fn legacy_fingerprint_with_different_cfi_still_conflicts() {
        let mut conn = test_conn();
        conn.execute(
            "INSERT INTO learner_evidence_events VALUES
              ('A','c1','REVIEW','review','mc',NULL,'correct',1.0,'deterministic_keyed',1000,'b',0,'epubcfi(/4)')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO learner_evidence_completions VALUES ('A','{\"sourceLocator\":{}}',1000)",
            [],
        )
        .unwrap();
        let mut req = base_request("A", "{\"sourceLocator\":{\"bookId\":\"b\",\"chapterIndex\":0,\"cfi\":\"epubcfi(/6)\"}}");
        req.event.source_locator = Some(SourceLocator {
            book_id: Some("b".into()),
            chapter_index: Some(0),
            cfi: Some("epubcfi(/6)".into()),
        });
        let err = commit_on_conn(&mut conn, &req).unwrap_err();
        assert_eq!(err, "__conflict__", "a genuinely different payload stays a conflict");
    }

    #[test]
    fn review_log_identity_migration_preserves_rows_and_is_one_shot() {
        // Legacy on-disk shape with the table-level UNIQUE constraint.
        let tmp = std::env::temp_dir().join(format!(
            "readany-log-migrate-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        {
            let conn = Connection::open(&tmp).expect("open");
            conn.execute_batch(
                "CREATE TABLE learner_review_logs (
                   id INTEGER PRIMARY KEY AUTOINCREMENT, concept_id TEXT NOT NULL, rating INTEGER NOT NULL,
                   state INTEGER NOT NULL, due INTEGER NOT NULL, stability REAL NOT NULL,
                   difficulty REAL NOT NULL, scheduled_days INTEGER NOT NULL, learning_steps INTEGER NOT NULL,
                   review INTEGER NOT NULL, event_id TEXT, UNIQUE(concept_id, review));",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO learner_review_logs (concept_id, rating, state, due, stability, difficulty, scheduled_days, learning_steps, review, event_id) VALUES ('c1',3,0,1000,1.0,5.0,1,0,1000,NULL)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO learner_review_logs (concept_id, rating, state, due, stability, difficulty, scheduled_days, learning_steps, review, event_id) VALUES ('c1',3,0,2000,2.0,5.0,1,0,2000,'ev-2')",
                [],
            )
            .unwrap();
        }
        {
            let mut conn = Connection::open(&tmp).expect("reopen");
            // An interrupted earlier attempt left a scratch table: must not block.
            conn.execute("CREATE TABLE learner_review_logs_identity (id INTEGER PRIMARY KEY)", [])
                .unwrap();
            let rebuilt = migrate_review_logs_on_conn(&mut conn, None).expect("migrate");
            assert!(rebuilt);
            let rows: i64 = conn
                .query_row("SELECT COUNT(*) FROM learner_review_logs", [], |r| r.get(0))
                .unwrap();
            assert_eq!(rows, 2, "every existing log row survives the rebuild");
            let ids: Vec<i64> = conn
                .prepare("SELECT id FROM learner_review_logs ORDER BY id")
                .unwrap()
                .query_map([], |r| r.get(0))
                .unwrap()
                .map(|r| r.unwrap())
                .collect();
            assert_eq!(ids, vec![1, 2], "legacy ids preserved");
            let legacy: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM pragma_index_list('learner_review_logs') WHERE origin = 'u'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(legacy, 0, "the time-unique constraint is gone");
            let event_index: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_learner_review_logs_event'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(event_index, 1);
            // Two legitimate same-instant attempts BOTH insert now.
            conn.execute(
                "INSERT INTO learner_review_logs (concept_id, rating, state, due, stability, difficulty, scheduled_days, learning_steps, review, event_id) VALUES ('c1',3,0,3000,3.0,5.0,1,0,3000,'ev-3a')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO learner_review_logs (concept_id, rating, state, due, stability, difficulty, scheduled_days, learning_steps, review, event_id) VALUES ('c1',3,0,3000,3.0,5.0,1,0,3000,'ev-3b')",
                [],
            )
            .unwrap();
            // Second run is a no-op.
            assert!(!migrate_review_logs_on_conn(&mut conn, None).expect("second run"));
        }
        let _ = std::fs::remove_file(&tmp);
    }

    /// The REAL TypeScript engine's first-answer atomic request, captured from
    /// `engine.commit.test.ts` (fixed clock, fixed event id) and replayed
    /// through the actual commit against a real SQLite file. This is the
    /// cross-boundary check: the TS-computed counts land in the DB verbatim.
    #[test]
    fn real_engine_first_answer_request_commits_to_sqlite() {
        const REQUEST_JSON: &str = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/learner_commit/engine-first-answer-request.json"
        ));
        let request: CommitRequest = serde_json::from_str(REQUEST_JSON).expect("fixture request");
        let tmp = std::env::temp_dir().join(format!(
            "readany-learner-commit-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        {
            let mut conn = Connection::open(&tmp).expect("open temp db");
            conn.execute_batch(
                "CREATE TABLE learner_evidence_events (
                   id TEXT PRIMARY KEY, concept_id TEXT NOT NULL, source TEXT NOT NULL,
                   task_type TEXT NOT NULL, question_type TEXT, difficulty INTEGER, result TEXT NOT NULL,
                   confidence REAL NOT NULL, verification TEXT, timestamp INTEGER NOT NULL,
                   source_book_id TEXT, source_chapter_index INTEGER, source_cfi TEXT);
                 CREATE TABLE learner_review_cards (
                   concept_id TEXT PRIMARY KEY, due INTEGER NOT NULL, stability REAL NOT NULL,
                   difficulty REAL NOT NULL, learning_steps INTEGER NOT NULL, reps INTEGER NOT NULL,
                   lapses INTEGER NOT NULL, state INTEGER NOT NULL, last_review INTEGER,
                   last_event_id TEXT);
                 CREATE TABLE learner_review_logs (
                   id INTEGER PRIMARY KEY AUTOINCREMENT, concept_id TEXT NOT NULL, rating INTEGER NOT NULL,
                   state INTEGER NOT NULL, due INTEGER NOT NULL, stability REAL NOT NULL,
                   difficulty REAL NOT NULL, scheduled_days INTEGER NOT NULL, learning_steps INTEGER NOT NULL,
                   review INTEGER NOT NULL, event_id TEXT);
                 CREATE UNIQUE INDEX idx_logs_event ON learner_review_logs(event_id) WHERE event_id IS NOT NULL;
                 CREATE TABLE learner_concept_mastery (
                   concept_id TEXT PRIMARY KEY, mastery REAL NOT NULL, confidence REAL NOT NULL,
                   retention REAL, transfer REAL, last_verified INTEGER, next_review INTEGER,
                   status TEXT NOT NULL, evidence_count INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                   last_event_id TEXT);
                 CREATE TABLE learner_evidence_completions (
                   evidence_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, applied_at INTEGER NOT NULL);",
            )
            .expect("schema");
            let ok = commit_on_conn(&mut conn, &request).expect("commit");
            assert_eq!(ok.outcome, "applied");
            // Post-commit database truth: exactly one of everything, and the
            // engine-computed count (1) is what actually landed.
            let evidence: i64 = conn
                .query_row("SELECT COUNT(*) FROM learner_evidence_events", [], |r| r.get(0))
                .unwrap();
            assert_eq!(evidence, 1);
            let logs: i64 = conn
                .query_row("SELECT COUNT(*) FROM learner_review_logs", [], |r| r.get(0))
                .unwrap();
            assert_eq!(logs, 1);
            let (count, confidence): (i64, f64) = conn
                .query_row(
                    "SELECT evidence_count, confidence FROM learner_concept_mastery WHERE concept_id='stats/mean'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            assert_eq!(count, 1, "the first answer counts itself");
            assert!(confidence > 0.0, "confidence reflects the post-commit event set");
            let completions: i64 = conn
                .query_row("SELECT COUNT(*) FROM learner_evidence_completions", [], |r| r.get(0))
                .unwrap();
            assert_eq!(completions, 1);
            // Replay of the same request through a fresh connection: no-op.
            let mut conn2 = Connection::open(&tmp).expect("reopen");
            let ok2 = commit_on_conn(&mut conn2, &request).expect("replay");
            assert_eq!(ok2.outcome, "alreadyApplied");
            let evidence2: i64 = conn2
                .query_row("SELECT COUNT(*) FROM learner_evidence_events", [], |r| r.get(0))
                .unwrap();
            assert_eq!(evidence2, 1, "the replay adds nothing");
        }
        let _ = std::fs::remove_file(&tmp);
    }
}

fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS learner_evidence_completions (
           evidence_id TEXT PRIMARY KEY,
           payload_json TEXT NOT NULL,
           applied_at INTEGER NOT NULL
         )",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
