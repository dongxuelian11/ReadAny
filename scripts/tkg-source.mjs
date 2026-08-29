#!/usr/bin/env node
// Acquire and verify the pinned The Knowledge Guy source (PR-002).
// Mirrors scripts/readbox-source.mjs: reproducible checkout pinned to the
// exact full SHA, fail-closed verification of HEAD, clean tree, the frozen
// prompt/contract files the pipeline ports, and the verified MIT license.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const TKG_REPO = "https://github.com/vitalysim/the-knowledge-guy.git";
export const TKG_REF = "052049f45f7baa57c23f24c6e0ac5aba9f5133bb";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);
export const tkgCheckoutDir = join(repoRoot, ".tkg", "upstream", TKG_REF);

const FROZEN_CONTRACT_FILES = [
  "LICENSE",
  ".claude/skills/book-to-skill/SKILL.md",
  ".claude/skills/book-to-skill/reference/chapter-template.md",
  ".claude/skills/book-to-skill/reference/concept-map-spec.md",
  ".claude/skills/book-to-skill/reference/genre-profiles.md",
  ".claude/skills/book-to-skill/scripts/lint_chapters.py",
  ".claude/skills/the-knowledge-guy/SKILL.md",
];

function git(args, cwd = tkgCheckoutDir) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export function verifyTkgSource() {
  if (!existsSync(join(tkgCheckoutDir, ".git"))) {
    throw new Error(`TKG source not found at ${tkgCheckoutDir}; run the ensure command first`);
  }
  const head = git(["rev-parse", "HEAD"]);
  if (head !== TKG_REF) {
    throw new Error(`TKG checkout HEAD ${head} does not match the pinned ref ${TKG_REF}`);
  }
  const status = git(["status", "--porcelain"]);
  if (status.length > 0) {
    throw new Error(`TKG checkout is dirty:\n${status}`);
  }
  for (const relative of FROZEN_CONTRACT_FILES) {
    if (!existsSync(join(tkgCheckoutDir, relative))) {
      throw new Error(`TKG checkout is missing the frozen contract file ${relative}`);
    }
  }
  const licenseFirstLine = readFileSync(join(tkgCheckoutDir, "LICENSE"), "utf8")
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0);
  if (!licenseFirstLine || !licenseFirstLine.includes("MIT License")) {
    throw new Error(`TKG LICENSE no longer declares MIT: ${JSON.stringify(licenseFirstLine)}`);
  }
  return {
    repo: TKG_REPO,
    exactRef: TKG_REF,
    checkoutDir: tkgCheckoutDir,
    license: "VERIFIED_MIT",
  };
}

export function ensureTkgSource() {
  if (!existsSync(tkgCheckoutDir)) {
    if (existsSync(tkgCheckoutDir)) {
      throw new Error(`TKG checkout path exists but is not a git checkout: ${tkgCheckoutDir}`);
    }
    mkdirSync(dirname(tkgCheckoutDir), { recursive: true });
    execFileSync(
      "git",
      ["clone", "--filter=blob:none", "--no-checkout", TKG_REPO, tkgCheckoutDir],
      { stdio: "inherit" },
    );
    git(["checkout", "--detach", TKG_REF]);
  }
  return verifyTkgSource();
}

function main() {
  const command = process.argv[2] ?? "ensure";
  const result = command === "verify" ? verifyTkgSource() : ensureTkgSource();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
