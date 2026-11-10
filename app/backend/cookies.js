"use strict";
// Stale browser-session cookies in the Desktop app's Chromium cookie jar.
//
// The defect this module exists for (verified in the shipped source, not
// guessed):
//
//   * `@deepseek-ai/dsh-client-connection` names its auth cookie
//     `dsh-auth-<base64url(sha256(authority))>` where `authority` comes from
//     `requestAudience()` → `url.host` — so the PORT is part of the name.
//   * The cookie is written with `Path=/` and lands on host `127.0.0.1`, and
//     Chromium keys cookies by host WITHOUT the port. So every port the
//     random-port allocator picks gets its own name in one shared scope.
//   * `cookieMaxAgeDays` defaults to 30 (`Max-Age=2592000`).
//
// Randomising the port is the right call on its own; the problem is the three
// together. Each launch mints a new cookie, nothing ever removes the old ones,
// and the jar grows for a month at a time. The visible symptom is not a
// hard failure but a slow one: startup and request handling degrade as the
// `dsh-auth-*` population grows.
//
// Only stale entries are removable. The cookie belonging to the port the
// CURRENTLY RUNNING instance is using is live, and deleting it would log the
// running app out mid-session — so the module reads the live port from the
// running process table and spares its cookie.
//
// Reading the jar needs `node:sqlite` (built into Electron's Node, zero
// third-party deps). Chromium holds the file with an exclusive lock while the
// app runs, so every function here refuses to act on a live instance instead of
// quietly failing halfway through.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ensureDir, fileSizeOrZero, formatBytes, isFile, timestampId } = require("./util");

const APP_DIR_NAME = path.join("@deepseek-ai", "dsh-desktop");
const NETWORK_DIR = "Network";
const COOKIE_FILE = "Cookies";
const JOURNAL_FILE = "Cookies-journal";

// The cookie names this defect produces. Anything else in the jar belongs to
// the web app or to another feature and is never touched.
const AUTH_COOKIE_PREFIX = "dsh-auth-";

/** Chromium's epoch is 1601-01-01; `expires_utc` is microseconds since then. */
const CHROMIUM_EPOCH_OFFSET_SECONDS = 11_644_736_000;

/**
 * Every candidate directory the Desktop app may keep its user data in.
 *
 * Mirrors `paths.userDataDirs()` but kept local so this module has no opinion
 * about install detection: an absolute `appData` override lets `--verify` point
 * at a throwaway jar, exactly like `skillRoots()` does for skills.
 */
function cookieDirs({ appData } = {}) {
  const roots = [];
  const push = (value) => {
    if (typeof value !== "string" || value === "") return;
    const resolved = path.resolve(value);
    if (!roots.includes(resolved)) roots.push(resolved);
  };
  const explicit = typeof appData === "string" && appData !== "";
  const roaming = explicit ? appData : process.env.APPDATA;
  if (typeof roaming === "string" && roaming !== "") {
    push(path.join(roaming, APP_DIR_NAME));
    // Some Electron builds use the productName as the folder instead.
    push(path.join(roaming, "DSH Desktop"));
  }
  // Only when nothing told us where to look: this is a fallback for an
  // environment without APPDATA, never an extra place to write when the caller
  // has already named a directory. An override that still reached the real jar
  // would make `--verify` delete the user's cookies.
  if (!explicit) push(path.join(os.homedir(), "AppData", "Roaming", APP_DIR_NAME));
  return roots;
}

function cookieFileFor(dir) {
  return path.join(dir, NETWORK_DIR, COOKIE_FILE);
}

function journalFileFor(dir) {
  return path.join(dir, NETWORK_DIR, JOURNAL_FILE);
}

/**
 * Describe every jar the app could own, without reading any of them.
 *
 * `available` reports whether at least one jar exists; a jar that exists but
 * cannot be opened is reported with `error` so the panel can explain the lock
 * instead of showing an empty list.
 */
function locate({ appData } = {}) {
  const seen = [];
  for (const dir of cookieDirs({ appData })) {
    const file = cookieFileFor(dir);
    const journal = journalFileFor(dir);
    const hasFile = isFile(file);
    const hasJournal = isFile(journal);
    if (!hasFile && !hasJournal) continue;
    seen.push({
      dir,
      file,
      journal,
      exists: hasFile,
      journalExists: hasJournal,
      bytes: fileSizeOrZero(file),
      journalBytes: fileSizeOrZero(journal),
    });
  }
  return seen;
}

/** Load `node:sqlite` lazily so a runtime without it degrades to a message. */
function loadSqlite() {
  try {
    return { ok: true, DatabaseSync: require("node:sqlite").DatabaseSync };
  } catch (error) {
    return { ok: false, reason: `当前运行时不支持 node:sqlite（${error?.code ?? error?.message ?? "未知原因"}），无法读取 cookie 内容。删除仍然可用。` };
  }
}

/**
 * Copy the jar to a temp file and read the rows out of the copy.
 *
 * Copying first is what makes "the app is stopped but Chromium still has the
 * file mapped" survivable, and `EBUSY` is turned into the actionable message
 * the panel shows: you must quit DSH first.
 */
function readJar(file) {
  const sqlite = loadSqlite();
  if (sqlite.ok !== true) return { ok: false, reason: sqlite.reason };
  const temp = path.join(os.tmpdir(), `dsh-cookies-${process.pid}-${Date.now()}.db`);
  try {
    fs.copyFileSync(file, temp);
  } catch (error) {
    const code = error?.code;
    const reason =
      code === "EBUSY" || code === "EPERM" || code === "EACCES"
        ? "cookie 文件正被占用：DSH 还在运行（Chromium 会独占这个文件）。请先退出 DSH 再清理。"
        : `无法读取 cookie 文件：${error?.message ?? String(error)}`;
    return { ok: false, reason, code };
  }
  let db;
  try {
    db = new sqlite.DatabaseSync(temp, { readOnly: true });
    // `expires_utc` is a Chromium webkit timestamp: microseconds since 1601,
    // which for any real date is far beyond Number.MAX_SAFE_INTEGER. Reading it
    // as a JS number throws ("Value is too large to be represented…"), so it is
    // cast to TEXT in SQL and parsed as a BigInt by `chromiumToMillis`.
    const rows = db
      .prepare(
        "SELECT name, host_key, path, is_secure, is_httponly, CAST(expires_utc AS TEXT) AS expires_utc_text FROM cookies ORDER BY host_key, name",
      )
      .all();
    return {
      ok: true,
      rows: rows.map((row) => normaliseRow({ ...row, expires_utc: row.expires_utc_text })),
    };
  } catch (error) {
    return { ok: false, reason: `cookie 库无法解析：${error?.message ?? String(error)}` };
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
    try {
      fs.unlinkSync(temp);
    } catch {
      /* temp cleanup is best-effort */
    }
  }
}

/** Chromium webkit timestamp (microseconds since 1601) to epoch milliseconds. */
function chromiumToMillis(value) {
  // Parse as BigInt: the raw microseconds exceed Number.MAX_SAFE_INTEGER, and
  // going through Number first loses precision or throws.
  let micros;
  try {
    micros = typeof value === "bigint" ? value : BigInt(String(value ?? "0").trim() || "0");
  } catch {
    return undefined;
  }
  if (micros <= 0n) return undefined;
  const seconds = Number(micros / 1_000_000n) - CHROMIUM_EPOCH_OFFSET_SECONDS;
  const millis = seconds * 1000;
  // A timestamp outside JS's Date range is not a real expiry; report unknown
  // rather than a date in the year 40000.
  return Number.isFinite(millis) && Math.abs(millis) < 8.64e15 ? millis : undefined;
}

function normaliseRow(row) {
  const expiresAt = chromiumToMillis(row.expires_utc);
  return {
    name: String(row.name ?? ""),
    host: String(row.host_key ?? ""),
    path: typeof row.path === "string" ? row.path : "/",
    secure: row.is_secure === 1 || row.is_secure === true,
    httpOnly: row.is_httponly === 1 || row.is_httponly === true,
    expiresAt,
    expiresLabel: expiresAt === undefined ? "无过期时间（会话期）" : new Date(expiresAt).toLocaleString("zh-CN"),
  };
}

/**
 * Split the jar into what this defect owns and what must stay.
 *
 * `liveNames` are cookies belonging to the port the running instance is using:
 * they are never offered for deletion.
 */
function classify(rows, { now = Date.now(), liveNames = [] } = {}) {
  const live = new Set(liveNames);
  const auth = [];
  const other = [];
  for (const row of rows) {
    if (!row.name.startsWith(AUTH_COOKIE_PREFIX)) {
      other.push(row);
      continue;
    }
    const expired = row.expiresAt !== undefined && row.expiresAt <= now;
    auth.push({ ...row, expired, live: live.has(row.name) });
  }
  return { auth, other };
}

/** Aggregate counts for the panel headline. */
function summarizeJar({ rows, now = Date.now(), liveNames = [] } = {}) {
  const { auth, other } = classify(rows ?? [], { now, liveNames });
  return {
    total: (rows ?? []).length,
    auth: auth.length,
    other: other.length,
    expired: auth.filter((row) => row.expired).length,
    live: auth.filter((row) => row.live).length,
    // What a cleanup would actually free: stale auth cookies, never the live one.
    removable: auth.filter((row) => row.live !== true).length,
    oldest: auth.reduce((min, row) => (row.expiresAt === undefined ? min : min === undefined || row.expiresAt < min ? row.expiresAt : min), undefined),
    newest: auth.reduce((max, row) => (row.expiresAt === undefined ? max : max === undefined || row.expiresAt > max ? row.expiresAt : max), undefined),
  };
}

/**
 * Read every jar and merge the result into one panel-ready view.
 *
 * A running instance makes the jar unreadable, and that is reported as state,
 * not thrown: the panel still needs to explain why cleanup is unavailable.
 */
function inspect({ appData, running = false, livePorts = [], now = Date.now() } = {}) {
  const locations = locate({ appData });
  if (locations.length === 0) {
    return {
      available: false,
      reason: `没有找到 DSH 桌面端的 cookie 文件（查找位置：${cookieDirs({ appData }).join("、")}）`,
      dirs: cookieDirs({ appData }),
      jars: [],
      summary: { total: 0, auth: 0, other: 0, expired: 0, live: 0, removable: 0 },
      running,
    };
  }

  const jars = [];
  for (const location of locations) {
    if (location.exists !== true) {
      jars.push({ ...location, readable: false, reason: "只有 Cookies-journal，没有 Cookies", rows: [] });
      continue;
    }
    const read = readJar(location.file);
    if (read.ok !== true) {
      jars.push({ ...location, readable: false, reason: read.reason, rows: [] });
      continue;
    }
    const { auth, other } = classify(read.rows, { now });
    jars.push({
      ...location,
      readable: true,
      rows: auth,
      other,
      summary: summarizeJar({ rows: read.rows, now }),
      sizeLabel: formatBytes(location.bytes),
      journalLabel: location.journalExists ? formatBytes(location.journalBytes) : undefined,
    });
  }

  const summary = jars.reduce(
    (acc, jar) => {
      const own = jar.summary ?? { total: 0, auth: 0, other: 0, expired: 0, live: 0, removable: 0 };
      return {
        total: acc.total + own.total,
        auth: acc.auth + own.auth,
        other: acc.other + own.other,
        expired: acc.expired + own.expired,
        live: acc.live + own.live,
        removable: acc.removable + own.removable,
      };
    },
    { total: 0, auth: 0, other: 0, expired: 0, live: 0, removable: 0 },
  );

  const bytes = jars.reduce((sum, jar) => sum + (jar.bytes ?? 0), 0);
  return {
    available: true,
    dirs: cookieDirs({ appData }),
    jars,
    summary: { ...summary, bytes, sizeLabel: formatBytes(bytes) },
    running,
    livePorts,
    readable: jars.some((jar) => jar.readable === true),
  };
}

/**
 * Remove the cookie files of every jar we can see.
 *
 * Both `Cookies` and `Cookies-journal` go: the journal is SQLite's rollback
 * journal for the same database, and leaving it behind while deleting the
 * database lets a later open replay a torn transaction into a fresh file.
 *
 * A backup copy is taken first when `backupDir` is given — deleting a cookie
 * jar is not reversible otherwise, and a user who does not want to log in again
 * on every site deserves a way back.
 */
function clear({ appData, backupDir, now = Date.now(), dryRun = false } = {}) {
  const locations = locate({ appData });
  // Defensive: with an override in effect every path must live under it. A jar
  // found outside means the override leaked into the real profile, and deleting
  // that would silently wipe the user's logins from a test run.
  if (typeof appData === "string" && appData !== "") {
    const root = path.resolve(appData);
    const escaped = locations.filter((location) => {
      const relative = path.relative(root, path.resolve(location.file));
      return relative.startsWith("..") || path.isAbsolute(relative);
    });
    if (escaped.length > 0) {
      return {
        ok: false,
        cleared: [],
        error: `拒绝在备份目录之外删除 cookie（${escaped[0].file}）。这通常意味着路径解析出了问题，请报告。`,
      };
    }
  }
  if (locations.length === 0) {
    return { ok: true, cleared: [], backup: undefined, message: "没有找到 cookie 文件，无需清理。" };
  }
  const cleared = [];
  const failed = [];
  // Every removed file gets its own backup: `Cookies` is the database and
  // `Cookies-journal` is its empty rollback stub. Keeping only the last one
  // would "back up" the stub and throw the database away.
  const backups = [];
  for (const location of locations) {
    for (const [kind, file] of [
      ["cookies", location.file],
      ["journal", location.journal],
    ]) {
      if (!isFile(file)) continue;
      if (dryRun === true) {
        cleared.push({ kind, file, bytes: fileSizeOrZero(file), dryRun: true });
        continue;
      }
      if (backupDir !== undefined) {
        try {
          ensureDir(backupDir);
          const archive = path.join(backupDir, `${timestampId(new Date(now))}-${path.basename(file)}`);
          fs.copyFileSync(file, archive);
          backups.push({ kind, file: archive, bytes: fileSizeOrZero(archive), source: file });
        } catch (error) {
          failed.push({ file, error: `备份失败，已中止（没有删除任何文件）：${error?.message ?? String(error)}` });
          break;
        }
      }
      const bytes = fileSizeOrZero(file);
      try {
        fs.rmSync(file, { force: true });
        cleared.push({ kind, file, bytes });
      } catch (error) {
        failed.push({ file, error: error?.message ?? String(error) });
      }
    }
    if (failed.length > 0) break;
  }
  // `backup` keeps the shape callers already read (the database copy is the one
  // that can actually be restored); `backups` lists every archived file.
  const backup = backups.find((entry) => entry.kind === "cookies") ?? backups[0];
  if (failed.length > 0) {
    return { ok: false, cleared, failed, error: failed[0].error, backup, backups };
  }
  const countText = cleared.length === 0 ? "没有文件需要删除" : `已删除 ${cleared.length} 个文件（${formatBytes(cleared.reduce((sum, item) => sum + (item.bytes ?? 0), 0))}）`;
  return {
    ok: true,
    cleared,
    backup,
    backups,
    message: `${countText}。下次启动 DSH 会重新签发一个 cookie；其它网站的登录状态也会一并清除。`,
  };
}

/** Restore a backup copy over the live jar (used by the panel's undo). */
function restore({ backupFile, appData } = {}) {
  if (typeof backupFile !== "string" || backupFile === "" || !isFile(backupFile)) {
    return { ok: false, error: `备份文件不存在：${backupFile ?? "(未指定)"}` };
  }
  // After a clear, neither `Cookies` nor `Cookies-journal` exists any more, so
  // `locate()` — which only reports jars it can actually see — returns nothing.
  // Fall back to the primary candidate directory, which is exactly where a
  // restore has to land.
  const locations = locate({ appData });
  const target = locations[0] ?? { dir: cookieDirs({ appData })[0], file: cookieFileFor(cookieDirs({ appData })[0]), journal: journalFileFor(cookieDirs({ appData })[0]) };
  if (target === undefined || typeof target.dir !== "string") {
    return { ok: false, error: "找不到要恢复到的 Network 目录；请先正常启动一次 DSH 让它重建目录。" };
  }
  // The backup is named `<timestamp>-Cookies` / `<timestamp>-Cookies-journal`,
  // so the suffix test has to be the full file name, not a prefix guess.
  const name = path.basename(backupFile);
  const destination = name.endsWith(`-${JOURNAL_FILE}`) || name === JOURNAL_FILE ? target.journal : target.file;
  ensureDir(path.dirname(destination));
  fs.copyFileSync(backupFile, destination);
  return { ok: true, restoredTo: destination, message: `已从备份恢复 ${path.basename(destination)}` };
}

module.exports = {
  AUTH_COOKIE_PREFIX,
  CHROMIUM_EPOCH_OFFSET_SECONDS,
  classify,
  clear,
  cookieDirs,
  cookieFileFor,
  inspect,
  journalFileFor,
  locate,
  readJar,
  restore,
  summarizeJar,
};
