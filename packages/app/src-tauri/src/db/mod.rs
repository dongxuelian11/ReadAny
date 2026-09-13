pub mod schema;

use crate::storage;
use anyhow::Result;
use tauri::AppHandle;

/// Initialize the SQLite database synchronously (called in setup before frontend loads)
pub fn init_database_sync(app: &AppHandle) -> Result<()> {
    let app_dir = storage::resolve_data_root(app).expect("failed to resolve data root");
    std::fs::create_dir_all(&app_dir)?;

    let db_path = app_dir.join("readany.db");
    schema::initialize(&db_path)?;

    // PR32-followup (F03): rebuild the legacy learner review-log uniqueness
    // BEFORE the SQL plugin pool opens. This runs on one real connection —
    // cross-statement BEGIN/COMMIT through the pooled JS adapter is not a
    // same-connection transaction and silently no-ops. Best-effort: a failure
    // here is logged; the learner commit itself fails loudly (never silently
    // drops logs) on an un-migrated table.
    match rusqlite::Connection::open(&db_path) {
        Ok(mut conn) => {
            let backup_path = app_dir.join("readany.db.bak-learner-v3");
            if let Err(error) =
                crate::learner_commit::migrate_review_logs_on_conn(&mut conn, backup_path.to_str())
            {
                eprintln!("[DB] learner review-log identity migration skipped: {}", error);
            }
        }
        Err(error) => eprintln!("[DB] learner identity migration could not open db: {}", error),
    }

    Ok(())
}
