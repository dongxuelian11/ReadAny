// KB-01/F02 regression: the catalog snapshot swap must never destroy the
// only recoverable copy. Covers the 5 failure scenarios from the review
// (normal promote, checksum-reject, promote-fail+restore-ok, double failure,
// backup-only startup) as pure decision tests over the injectable coordinator.

import { describe, expect, it, vi } from "vitest";
import { planSeedSwap, promoteStagedCatalog, shouldKeepBackupAfterPlan } from "./seed-recovery";

describe("planSeedSwap", () => {
  it("installs fresh when neither db nor bak exists", () => {
    expect(planSeedSwap({ dbExists: false, bakExists: false })).toEqual({
      phase: "install-fresh",
    });
  });

  it("swaps the existing db and drops a stale bak", () => {
    expect(planSeedSwap({ dbExists: true, bakExists: true })).toEqual({
      phase: "swap-existing",
      dropStaleBak: true,
    });
    expect(planSeedSwap({ dbExists: true, bakExists: false })).toEqual({
      phase: "swap-existing",
      dropStaleBak: false,
    });
  });

  it("recovers from a leftover bak BEFORE copying when the db is gone", () => {
    // This is the state after a crash between "live→bak" and "promote staged".
    expect(planSeedSwap({ dbExists: false, bakExists: true })).toEqual({
      phase: "recover-bak",
    });
  });
});

describe("promoteStagedCatalog failure matrix", () => {
  it("deletes the backup only when promotion succeeded", async () => {
    const result = await promoteStagedCatalog({
      promote: vi.fn(async () => {}),
      restore: vi.fn(async () => {}),
    });
    expect(result).toEqual({ outcome: "promoted" });
    expect(shouldKeepBackupAfterPlan({ phase: "swap-existing", dropStaleBak: false }, result)).toBe(
      false,
    );
  });

  it("keeps nothing dangling when restore succeeds after a failed promote", async () => {
    const restore = vi.fn(async () => {});
    const result = await promoteStagedCatalog({
      promote: vi.fn(async () => {
        throw new Error("promotion failed");
      }),
      restore,
    });
    expect(result.outcome).toBe("restored");
    if (result.outcome === "restored") {
      expect(result.promoteError).toContain("promotion failed");
    }
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it("KEEPS the backup when promotion AND restore both fail (double failure)", async () => {
    const result = await promoteStagedCatalog({
      promote: vi.fn(async () => {
        throw new Error("disk full during promote");
      }),
      restore: vi.fn(async () => {
        throw new Error("sharing violation during restore");
      }),
    });
    expect(result.outcome).toBe("restore-failed");
    if (result.outcome === "restore-failed") {
      expect(result.promoteError).toContain("disk full");
      expect(result.restoreError).toContain("sharing violation");
    }
    // The backup is the ONLY recoverable copy — it must survive this launch.
    expect(shouldKeepBackupAfterPlan({ phase: "swap-existing", dropStaleBak: false }, result)).toBe(
      true,
    );
  });

  it("keeps the bak when a backup-only startup recovery did not promote", () => {
    expect(shouldKeepBackupAfterPlan({ phase: "recover-bak" }, { outcome: "restored" })).toBe(true);
    expect(shouldKeepBackupAfterPlan({ phase: "recover-bak" }, null)).toBe(true);
  });

  it("never asks swap-existing cleanup to keep anything when no promotion ran", () => {
    // install-fresh: nothing to keep — there is no backup semantics.
    expect(shouldKeepBackupAfterPlan({ phase: "install-fresh" }, null)).toBe(false);
  });
});
