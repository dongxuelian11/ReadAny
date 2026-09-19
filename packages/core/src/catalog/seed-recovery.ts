/**
 * Catalog seed swap recovery decisions (KB-01/F02).
 *
 * Pure decision logic + an injectable promotion coordinator so the failure
 * matrix of the catalog snapshot swap can be regression-tested without any
 * Tauri/FS dependency. The app's seed.ts supplies the real rename/cleanup IO.
 *
 * Invariants:
 *  - The backup (previous catalog) is the ONLY recoverable copy while a swap
 *    is in flight. It may be deleted ONLY after the new snapshot verifiably
 *    took over ("promoted").
 *  - A failed promotion whose restore also fails MUST keep the backup on disk
 *    — the next launch retries recovery from it instead of seeding over it.
 *  - A leftover backup without a live catalog is recovered FIRST at startup;
 *    if that recovery fails the backup stays and the caller reports the real
 *    error instead of pretending an "existing copy" is in use.
 */

export interface SeedSwapEnvironment {
  dbExists: boolean;
  bakExists: boolean;
}

export type SeedSwapPlan =
  | { phase: "install-fresh" }
  | { phase: "swap-existing"; dropStaleBak: boolean }
  | { phase: "recover-bak" };

/** Decide what to do at startup BEFORE any copying happens. */
export function planSeedSwap(env: SeedSwapEnvironment): SeedSwapPlan {
  if (env.dbExists) {
    // A live catalog exists. A leftover backup is from an older completed or
    // interrupted swap and can be dropped (the live DB is the current copy).
    return { phase: "swap-existing", dropStaleBak: env.bakExists };
  }
  if (env.bakExists) {
    // Previous launch died between "rename live→bak" and "promote staged".
    // The backup IS the newest catalog — recover it before anything else.
    return { phase: "recover-bak" };
  }
  return { phase: "install-fresh" };
}

export type SeedPromotionResult =
  | { outcome: "promoted" }
  | { outcome: "restored"; promoteError: string }
  | { outcome: "restore-failed"; promoteError: string; restoreError: string };

/**
 * Promote the staged snapshot over the live catalog. On promotion failure,
 * attempt exactly one restore of the backup. The caller deletes the backup
 * only for outcome "promoted"; for "restored" the backup file has already
 * moved back into place (rename semantics); for "restore-failed" it MUST stay.
 */
export async function promoteStagedCatalog(io: {
  promote: () => Promise<void>;
  restore: () => Promise<void>;
}): Promise<SeedPromotionResult> {
  try {
    await io.promote();
    return { outcome: "promoted" };
  } catch (promoteError) {
    const promoteMessage =
      promoteError instanceof Error ? promoteError.message : String(promoteError);
    try {
      await io.restore();
      return { outcome: "restored", promoteError: promoteMessage };
    } catch (restoreError) {
      return {
        outcome: "restore-failed",
        promoteError: promoteMessage,
        restoreError: restoreError instanceof Error ? restoreError.message : String(restoreError),
      };
    }
  }
}

/** True when the backup file must survive this launch (caller cleanup rule). */
export function shouldKeepBackupAfterPlan(
  plan: SeedSwapPlan,
  result: SeedPromotionResult | null,
): boolean {
  if (plan.phase === "recover-bak") return result?.outcome !== "promoted";
  if (plan.phase === "swap-existing") {
    return result !== null && result.outcome !== "promoted";
  }
  return false;
}
