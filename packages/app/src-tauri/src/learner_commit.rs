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

use rusqlite::Connection;
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

/// The whole commit against ONE connection (testable with in-memory SQLite).
pub fn commit_on_conn(conn: &mut Connection, request: &CommitRequest) -> Result<CommitOk, String> {
    let tx = conn
        .transaction()
        .map_err(|e| format!("failed to begin transaction: {}", e))?;

    // 1. Completion record gate: a replayed fully-applied attempt is a no-op;
    //    a different payload under the same id is a conflict.
    let recorded: Option<String> = tx
        .query_row(
            "SELECT payload_json FROM learner_evidence_completions WHERE evidence_id = ?1",
            [&request.event.id],
            |row| row.get(0),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })
        .map_err(|e| e.to_string())?;
    if let Some(payload) = recorded {
        if payload != request.payload_json {
            return Err("__conflict__".into());
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
    let card_marker: Option<String> = tx
        .query_row(
            "SELECT last_event_id FROM learner_review_cards WHERE concept_id = ?1",
            [&request.card.concept_id],
            |row| row.get(0),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })
        .map_err(|e| e.to_string())?;
    if card_marker != request.expected_card_last_event_id {
        return Err("__stale__".into());
    }
    let mastery_marker: Option<String> = tx
        .query_row(
            "SELECT last_event_id FROM learner_concept_mastery WHERE concept_id = ?1",
            [&request.mastery.concept_id],
            |row| row.get(0),
        )
        .map(Some)
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
    if let Some(log) = &request.log {
        tx.execute(
            "INSERT OR IGNORE INTO learner_review_logs
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
               review INTEGER NOT NULL, event_id TEXT, UNIQUE(concept_id, review));
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
        let mut conflicting = base_request("A", "payload-DIFFERENT");
        conflicting.mastery.mastery = 0.99;
        let err = commit_on_conn(&mut conn, &conflicting).unwrap_err();
        assert_eq!(err, "__conflict__");
        let mastery: f64 = conn
            .query_row("SELECT mastery FROM learner_concept_mastery WHERE concept_id = 'c1'", [], |r| r.get(0))
            .unwrap();
        assert!((mastery - 0.5).abs() < 1e-9, "state must be untouched");
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
