// KB-01 followup / F02 regression: after a catalog snapshot swap whose
// promotion fails but whose restore succeeds ("restored"), the version
// markers MUST stay on the OLD values and installed MUST be false — otherwise
// the next launch thinks the upgrade already happened and never retries.
// Runs the REAL ensureCatalogSeeded against a real temp directory through a
// node:fs-backed plugin-fs stand-in (rename failures are injected, everything
// else — copy, verify, rename, KV markers — is the actual code path).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  tempRoot: "",
  failPromoteRenameOnce: false,
  kv: new Map<string, string>(),
}));

function nodeJoin(...parts: string[]): string {
  return path.join(...parts);
}

vi.mock("@tauri-apps/plugin-fs", () => ({
  copyFile: async (src: string, dest: string) => {
    writeFileSync(dest, readFileSync(src));
  },
  exists: async (p: string) => existsSync(p),
  mkdir: async (p: string, _opts?: unknown) => {
    mkdirSync(p, { recursive: true });
  },
  readFile: async (p: string) => new Uint8Array(readFileSync(p)),
  readTextFile: async (p: string) => readFileSync(p, "utf8"),
  remove: async (p: string) => {
    if (existsSync(p)) rmSync(p);
  },
  rename: async (from: string, to: string) => {
    if (state.failPromoteRenameOnce && to.endsWith("catalog.sqlite")) {
      state.failPromoteRenameOnce = false;
      throw new Error("injected rename failure (promotion)");
    }
    if (existsSync(to)) rmSync(to);
    writeFileSync(to, readFileSync(from));
    rmSync(from);
  },
}));

vi.mock("@tauri-apps/api/path", () => ({
  join: async (...parts: string[]) => nodeJoin(...parts),
  resourceDir: async () => nodeJoin(state.tempRoot, "seed-root"),
}));

vi.mock("@readany/core/services", () => ({
  getPlatformService: () => ({
    kvGetItem: async (k: string) => state.kv.get(k) ?? null,
    kvSetItem: async (k: string, v: string) => {
      state.kv.set(k, v);
    },
  }),
}));

vi.mock("@readany/core/db", () => ({
  initDatabase: async () => {},
}));

vi.mock("@readany/core/db/catalog-acquire-queries", () => ({
  resetStaleDownloadingTasks: async () => 0,
}));

vi.mock("@/lib/storage/data-root-bootstrap", () => ({
  getDataRootReady: async () => {},
}));

vi.mock("@/lib/storage/desktop-library-root", () => ({
  resolveDesktopDataPath: async (p: string) => nodeJoin(state.tempRoot, p),
}));

const SEED_VERSION_KEY = "readany-catalog-seed-version";
const SEED_BUILT_AT_KEY = "readany-catalog-seed-builtat";
const OLD_BUILT_AT = "2026-09-01T00:00:00.000Z";
const NEW_BUILT_AT = "2026-09-19T00:00:00.000Z";

function makeCatalogFile(file: string, marker: string) {
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE IF NOT EXISTS probe(id TEXT PRIMARY KEY, marker TEXT NOT NULL)");
  db.prepare("INSERT OR REPLACE INTO probe(id, marker) VALUES ('p1', ?)").run(marker);
  db.close();
}

function readDbMarker(file: string): string {
  const db = new DatabaseSync(file);
  const row = db.prepare("SELECT marker FROM probe WHERE id='p1'").get() as {
    marker: string;
  };
  db.close();
  return row.marker;
}

/** Fresh module instance per scenario (seed.ts caches single-flight state). */
async function loadSeed() {
  vi.resetModules();
  return import("@/lib/catalog/seed");
}

function seedDbPath() {
  return nodeJoin(state.tempRoot, "catalog", "catalog.sqlite");
}

beforeEach(() => {
  state.tempRoot = path.join(
    tmpdir(),
    `readany-seed-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  state.failPromoteRenameOnce = false;
  state.kv.clear();
  mkdirSync(nodeJoin(state.tempRoot, "seed-root", "catalog-seed"), { recursive: true });
  mkdirSync(nodeJoin(state.tempRoot, "catalog"), { recursive: true });
});

describe("ensureCatalogSeeded version markers (F02)", () => {
  it("restored swap keeps OLD markers and installed=false; next launch retries", async () => {
    // Old catalog in place (already seeded with OLD_BUILT_AT markers).
    makeCatalogFile(seedDbPath(), "old");
    state.kv.set(SEED_VERSION_KEY, "1");
    state.kv.set(SEED_BUILT_AT_KEY, OLD_BUILT_AT);
    // New snapshot in resources.
    const seedBase = nodeJoin(state.tempRoot, "seed-root", "catalog-seed");
    makeCatalogFile(nodeJoin(seedBase, "catalog.sqlite"), "new");
    writeFileSync(
      nodeJoin(seedBase, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        builtAt: NEW_BUILT_AT,
        counts: { totalEditions: 1, bundled: 0, online: 0, metadataOnly: 0 },
        books: [],
      }),
    );

    // Promotion fails once, restore succeeds → "restored" branch.
    state.failPromoteRenameOnce = true;
    const first = await loadSeed();
    const result1 = await first.ensureCatalogSeeded();

    expect(readDbMarker(seedDbPath())).toBe("old");
    // REGRESSION (pre-fix): installed=true + NEW marker told the next launch
    // the upgrade already happened. After the fix both must stay old/false.
    expect(result1.installed).toBe(false);
    expect(state.kv.get(SEED_BUILT_AT_KEY)).toBe(OLD_BUILT_AT);
    expect(state.kv.get(SEED_VERSION_KEY)).toBe("1");

    // Next launch (module reloaded, no injected failure): the upgrade retries.
    const second = await loadSeed();
    const result2 = await second.ensureCatalogSeeded();
    expect(readDbMarker(seedDbPath())).toBe("new");
    expect(result2.installed).toBe(true);
    expect(state.kv.get(SEED_BUILT_AT_KEY)).toBe(NEW_BUILT_AT);
  });

  it("normal promote still writes NEW markers and installed=true", async () => {
    makeCatalogFile(seedDbPath(), "old");
    state.kv.set(SEED_VERSION_KEY, "1");
    state.kv.set(SEED_BUILT_AT_KEY, OLD_BUILT_AT);
    const seedBase = nodeJoin(state.tempRoot, "seed-root", "catalog-seed");
    makeCatalogFile(nodeJoin(seedBase, "catalog.sqlite"), "new");
    writeFileSync(
      nodeJoin(seedBase, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        builtAt: NEW_BUILT_AT,
        counts: { totalEditions: 1, bundled: 0, online: 0, metadataOnly: 0 },
        books: [],
      }),
    );

    const mod = await loadSeed();
    const result = await mod.ensureCatalogSeeded();
    expect(readDbMarker(seedDbPath())).toBe("new");
    expect(result.installed).toBe(true);
    expect(state.kv.get(SEED_BUILT_AT_KEY)).toBe(NEW_BUILT_AT);
  });

  it("backup-only startup recovers the previous catalog (double-failure leftover)", async () => {
    // Simulate a previous crash: only the .bak exists, no live db.
    const bakPath = nodeJoin(state.tempRoot, "catalog", "catalog.sqlite.bak");
    makeCatalogFile(bakPath, "old-from-bak");
    const seedBase = nodeJoin(state.tempRoot, "seed-root", "catalog-seed");
    makeCatalogFile(nodeJoin(seedBase, "catalog.sqlite"), "new");
    writeFileSync(
      nodeJoin(seedBase, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        builtAt: NEW_BUILT_AT,
        counts: { totalEditions: 1, bundled: 0, online: 0, metadataOnly: 0 },
        books: [],
      }),
    );

    const mod = await loadSeed();
    const result = await mod.ensureCatalogSeeded();
    // Recovered from bak first, then the refresh promoted the new snapshot.
    expect(readDbMarker(seedDbPath())).toBe("new");
    expect(result.installed).toBe(true);
  });
});
