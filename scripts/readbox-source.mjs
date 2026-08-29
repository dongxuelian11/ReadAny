import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const READBOX_REPO = "https://github.com/wenhui426/read-box.git";
export const READBOX_REF = "15f766f19f1ab204535f1947983fa397540352c8";

const workspace = path.resolve(import.meta.dirname, "..");
export const checkoutDir = path.join(workspace, ".readbox", "upstream", READBOX_REF);
export const backendDir = path.join(checkoutDir, "code", "backend");

function git(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

export function verifyReadBoxSource() {
  if (!existsSync(path.join(checkoutDir, ".git"))) {
    throw new Error(`Pinned Read-Box checkout is missing: ${checkoutDir}`);
  }
  const head = git(["-C", checkoutDir, "rev-parse", "HEAD"]);
  if (head !== READBOX_REF) {
    throw new Error(`Read-Box checkout mismatch: expected ${READBOX_REF}, found ${head}`);
  }
  const dirty = git(["-C", checkoutDir, "status", "--porcelain"]);
  if (dirty) {
    throw new Error(
      "Pinned Read-Box checkout is modified; refusing to use an unverified source tree",
    );
  }
  if (!existsSync(path.join(backendDir, "app", "main.py"))) {
    throw new Error(`Read-Box backend entrypoint is missing from ${backendDir}`);
  }
  return { repo: READBOX_REPO, exactRef: head, backendDir };
}

export function ensureReadBoxSource() {
  if (existsSync(path.join(checkoutDir, ".git"))) {
    return verifyReadBoxSource();
  }

  const parent = path.dirname(checkoutDir);
  mkdirSync(parent, { recursive: true });
  if (existsSync(checkoutDir) && readdirSync(checkoutDir).length > 0) {
    throw new Error(`Refusing to overwrite non-empty Read-Box checkout path: ${checkoutDir}`);
  }

  execFileSync("git", ["clone", "--filter=blob:none", "--no-checkout", READBOX_REPO, checkoutDir], {
    stdio: "inherit",
  });
  execFileSync("git", ["-C", checkoutDir, "checkout", "--detach", READBOX_REF], {
    stdio: "inherit",
  });
  return verifyReadBoxSource();
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const command = process.argv[2] || "verify";
  try {
    const result = command === "ensure" ? ensureReadBoxSource() : verifyReadBoxSource();
    process.stdout.write(
      `${JSON.stringify({ ...result, license: "README_DECLARED_MIT_LICENSE_FILE_ABSENT" }, null, 2)}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
