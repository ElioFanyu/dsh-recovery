"use strict";
// Updating the console itself.
//
// How "the console" is installed on this machine decides what an update even
// means, so that comes first:
//
//   * `.runtime/resources/app` is a **directory junction** pointing at
//     `<project>/app` (see setup-runtime.js). The running code IS this git
//     working copy — there is no packaged installer per version to swap out.
//   * `app/renderer` is plain static JS/HTML/CSS with no build step
//     (`package.json.scripts.test` is the only script).
//
// So updating means: fetch from the git remote, check whether the working copy
// can fast-forward, and let git do it. Replacing files by hand would break the
// junction, lose the user's local commits, and dirty a repo that `--verify`
// assumes it can reason about.
//
// Two rules shape the implementation:
//
//   1. **Never `spawnSync`.** The previous "update froze the app" bug was a
//      synchronous child in the Electron main process. Every git call here is
//      async with a timeout, so the window keeps painting.
//   2. **Never update over uncommitted work.** A dirty tree means the user has
//      local edits; a pull would either fail halfway or silently merge. Report
//      it and stop.
//
// A remote that cannot be reached is a normal outcome, not an exception: the
// console has to stay usable offline.

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { formatBytes, isDirectory } = require("./util");

// Long enough for a cold `git fetch` over ssh on a slow link, short enough that
// a dead remote does not leave the button spinning forever.
const GIT_TIMEOUT_MS = 90_000;

function runGit(args, options = {}) {
  const cwd = options.cwd;
  const timeout = options.timeout ?? GIT_TIMEOUT_MS;
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", LC_ALL: "C" },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      // Kill the whole tree: git may have spawned ssh, which ignores a polite
      // SIGTERM propagated only to the parent.
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish({ status: -1, stdout, stderr: `${stderr}\n超时（${Math.round(timeout / 1000)} 秒）` });
    }, timeout);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish({ status: -1, stdout, stderr: error.message }));
    child.on("close", (status) => finish({ status: status ?? -1, stdout, stderr }));
  });
}

/** The project checkout the console runs from (`.runtime/resources/app` → `..`/`..`). */
function projectRoot() {
  return path.resolve(__dirname, "..", "..");
}

/**
 * Whether this copy can update itself at all.
 *
 * A zip copied from somewhere else has no `.git` and therefore no remote to
 * fetch from — that is a valid installation, just not a self-updating one, so
 * it reports why instead of failing.
 */
function inspect(options = {}) {
  const root = options.root ?? projectRoot();
  const gitDir = path.join(root, ".git");
  const available = isDirectory(gitDir);
  const result = {
    available,
    root,
    version: readVersion(root),
    gitDir,
    reason: undefined,
  };
  if (!available) {
    result.reason =
      "这不是一份 git 工作副本（没有 .git 目录），无法自动更新。请重新克隆或下载新版本覆盖。";
    return result;
  }
  return result;
}

/** Read `<root>/app/package.json`'s version, which is what the console displays. */
function readVersion(root) {
  try {
    const raw = fs.readFileSync(path.join(root, "app", "package.json"), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

/** `1.9.0` vs `1.10.0` — string comparison would call 1.10 older than 1.9. */
function compareVersions(left, right) {
  const parse = (value) =>
    String(value ?? "")
      .replace(/^v/u, "")
      .split(/[.+-]/u)
      .map((part) => Number.parseInt(part, 10))
      .map((part) => (Number.isFinite(part) ? part : 0));
  const a = parse(left);
  const b = parse(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/** Count lines of a git command's output without splitting on a trailing newline. */
function lineCount(text) {
  const trimmed = String(text ?? "").trim();
  return trimmed === "" ? 0 : trimmed.split(/\n/u).length;
}

/**
 * Ask the remote whether there is anything new.
 *
 * Read-only in the sense that matters: it writes only `refs/remotes/*`, never
 * the working tree, so it is safe to call on a dirty checkout and safe to run
 * repeatedly. `fetch` is what makes the answer trustworthy — comparing against a
 * stale `origin/main` is how an updater reports "already current" forever.
 */
async function check(options = {}) {
  const root = options.root ?? projectRoot();
  const info = inspect({ root });
  if (info.available !== true) return { ...info, ok: false, error: info.reason };

  const remote = await runGit(["remote", "get-url", "origin"], { cwd: root, timeout: 10_000 });
  const branch = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, timeout: 10_000 });
  const currentBranch = branch.status === 0 ? branch.stdout.trim() : "";
  const base = {
    ...info,
    remote: remote.status === 0 ? remote.stdout.trim() : undefined,
    branch: currentBranch,
    head: await revParse(root, "HEAD"),
  };
  if (base.remote === undefined) {
    return { ...base, ok: false, error: "没有名为 origin 的远端仓库，无法检查更新。" };
  }

  const fetched = await runGit(["fetch", "--quiet", "origin", currentBranch === "" ? "HEAD" : currentBranch], { cwd: root });
  if (fetched.status !== 0) {
    return {
      ...base,
      ok: false,
      offline: true,
      error: `无法连接远端仓库：${firstLine(fetched.stderr) || `git fetch 退出码 ${fetched.status}`}`,
    };
  }

  const upstreamRef = `origin/${currentBranch}`;
  const upstream = await revParse(root, upstreamRef);
  if (upstream === undefined) {
    return { ...base, ok: false, error: `远端没有 ${upstreamRef}，无法比对版本。` };
  }

  const counts = await runGit(["rev-list", "--left-right", "--count", `${upstreamRef}...HEAD`], { cwd: root, timeout: 20_000 });
  const [behind, ahead] = counts.status === 0 ? counts.stdout.trim().split(/\s+/u).map((value) => Number.parseInt(value, 10)) : [0, 0];

  // What the incoming commits are, so the panel can show more than a number.
  const log = await runGit(["log", "--oneline", "--no-decorate", `HEAD..${upstreamRef}`], { cwd: root, timeout: 20_000 });
  const commits = log.status === 0 ? log.stdout.split(/\n/u).map((line) => line.trim()).filter((line) => line !== "") : [];

  const dirty = await runGit(["status", "--porcelain"], { cwd: root, timeout: 20_000 });
  const dirtyFiles = dirty.status === 0 ? lineCount(dirty.stdout) : 0;

  const upstreamVersion = await readUpstreamVersion(root, upstreamRef);

  return {
    ...base,
    ok: true,
    upstream: upstream,
    upstreamVersion,
    behind: Number.isFinite(behind) ? behind : 0,
    ahead: Number.isFinite(ahead) ? ahead : 0,
    commits,
    dirty: dirtyFiles > 0,
    dirtyFiles,
    // Two independent signals must agree before the UI claims "有新版": a new
    // commit on the remote, or a higher version in its package.json (someone may
    // bump the version without us having fetched that commit's tree yet).
    hasUpdate: (Number.isFinite(behind) ? behind : 0) > 0,
    versionNewer: compareVersions(upstreamVersion, info.version) > 0,
    checkedAt: new Date().toISOString(),
  };
}

async function revParse(root, ref) {
  const result = await runGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: root, timeout: 10_000 });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/** The version `app/package.json` has on the remote tip, without checking it out. */
async function readUpstreamVersion(root, ref) {
  const result = await runGit(["show", `${ref}:app/package.json`], { cwd: root, timeout: 20_000 });
  if (result.status !== 0) return undefined;
  try {
    const parsed = JSON.parse(result.stdout);
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

function firstLine(text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed === "") return "";
  return trimmed.split(/\n/u)[0];
}

/**
 * Fast-forward the working copy to the remote.
 *
 * Only `--ff-only`: if local commits exist, a merge could conflict or rewrite
 * history, and neither is something an "update" button may decide on its own.
 * The reason is returned verbatim so the panel can show git's own words.
 */
async function apply(options = {}) {
  const root = options.root ?? projectRoot();
  const checked = await check({ root });
  if (checked.ok !== true) return { ok: false, error: checked.error, check: checked };
  if (checked.hasUpdate !== true) {
    return { ok: true, changed: false, from: checked.head, to: checked.head, message: "已经是最新版本。", check: checked };
  }
  if (checked.dirty === true) {
    return {
      ok: false,
      error: `工作区有 ${checked.dirtyFiles} 个未提交的改动，已停止。请先提交或撤销这些改动再更新（自动更新只做快进合并，不碰你本地的改动）。`,
      check: checked,
    };
  }

  const before = checked.head;
  const pull = await runGit(["merge", "--ff-only", `origin/${checked.branch}`], { cwd: root });
  if (pull.status !== 0) {
    return {
      ok: false,
      error: `快进合并失败：${firstLine(pull.stderr) || firstLine(pull.stdout) || `git merge 退出码 ${pull.status}`}`,
      check: checked,
    };
  }
  const after = await revParse(root, "HEAD");
  const version = readVersion(root);
  return {
    ok: true,
    changed: before !== after,
    from: before,
    to: after,
    version,
    branches: checked.branch,
    message:
      before === after
        ? "本地已经是远端的最新提交（分支没有变化）。"
        : `已更新到 ${String(after ?? "").slice(0, 7)}${version === undefined ? "" : `（v${version}）`}。重启恢复器后生效。`,
    // The renderer/renderer files are already on disk — no build step — but the
    // Electron main process holds the old module instances in memory.
    needsRestart: before !== after,
    check: checked,
  };
}

/** Size of the tracked source, for the panel's context line (not the runtime). */
function checkoutSize(root = projectRoot()) {
  // `.runtime` is the generated Electron runtime (hundreds of MB, hard-linked
  // from the installed app) and `.git` is history; neither is what an update
  // downloads, so including them would show "384 MB" for a 1 MB update.
  const SKIP = new Set(["node_modules", ".git", ".runtime", ".safemode", "diagnostics", "backups", "cookie-backups"]);
  let total = 0;
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else {
        try {
          total += fs.statSync(full).size;
        } catch {}
      }
    }
  };
  walk(root, 0);
  return { bytes: total, label: formatBytes(total) };
}

module.exports = {
  GIT_TIMEOUT_MS,
  apply,
  check,
  checkoutSize,
  compareVersions,
  inspect,
  projectRoot,
  readVersion,
  runGit,
};
