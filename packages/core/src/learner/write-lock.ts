// Learner write lock (PR-012). The learner Authority mutates state through
// read-modify-write cycles across several stores (evidence → BKT → FSRS →
// mastery; goal/teaching/placement supersession). The db write-retry queue
// serializes individual statements, not logical operations, so two concurrent
// cycles can interleave their reads and silently lose an update. The app is
// single-user and local-first, so one in-process mutex is a complete
// mutual-exclusion boundary for every learner writer.
//
// Lock discipline: only leaf mutation entry points take the lock, and the lock
// is NOT reentrant. applyEvidenceEvent / evaluateConceptMastery /
// putGoalWithSupersession / startTeachingSession / startPlacementSession /
// finalizePlacement each hold it; no holder may call another holder while the
// lock is held (verified by the callers: answer flows call applyEvidenceEvent
// but never hold the lock themselves).

let tail: Promise<unknown> = Promise.resolve();

export async function withLearnerWriteLock<T>(operation: () => Promise<T>): Promise<T> {
  const queued = tail.then(operation, operation);
  tail = queued.then(
    () => undefined,
    () => undefined,
  );
  return queued;
}
