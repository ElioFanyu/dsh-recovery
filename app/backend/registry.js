"use strict";
// "Which of my plugins have a new version published?"
//
// Reading the profile tells us what is installed; it cannot tell us what the
// registry currently offers. This module asks the registry directly, one
// metadata document per package (`<registry>/<name>/latest`), and reports the
// comparison. It is deliberately read-only: nothing here installs anything.
//
// Two things make this less trivial than it looks:
//
//   * **Scoped names.** `@scope/name` has to be `@scope%2Fname` in the URL, and
//     getting that wrong returns a 404 that reads like "no such package".
//   * **`latest` dist-tag vs. what pnpm would resolve.** `latest` is what
//     `pnpm add name@latest` installs, so comparing against it reports exactly
//     the change an upgrade would make. Comparing against the highest published
//     version instead would flag prereleases the user never asked for.
//
// Network failures are reported per package and never fail the whole scan: on a
// offline machine the panel should say "5 个查不到" and still show the ones that
// did resolve.

const https = require("node:https");
const path = require("node:path");

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const REQUEST_TIMEOUT_MS = 15_000;
// Enough to be quick on a big profile, few enough that a rate-limited registry
// does not see a burst.
const CONCURRENCY = 6;

/** `@scope/name` → `@scope%2Fname`; plain names pass through. */
function encodePackageName(name) {
  const value = String(name ?? "");
  if (value.startsWith("@")) return value.replace("/", "%2F");
  return value;
}

/**
 * The registry this profile would use.
 *
 * pnpm reads `registry` from `.npmrc` (project, then user). Honouring it means
 * the scan reports the same versions an upgrade would install — a corporate
 * mirror would otherwise look like "everything is out of date".
 */
function registryFor(profileDir, options = {}) {
  if (typeof options.registry === "string" && options.registry !== "") return trimSlash(options.registry);
  const candidates = [];
  if (typeof profileDir === "string" && profileDir !== "") candidates.push(path.join(profileDir, ".npmrc"));
  if (typeof process.env.USERPROFILE === "string") candidates.push(path.join(process.env.USERPROFILE, ".npmrc"));
  if (typeof process.env.HOME === "string") candidates.push(path.join(process.env.HOME, ".npmrc"));
  const fs = require("node:fs");
  for (const file of candidates) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const raw of text.split(/\r?\n/u)) {
      const line = raw.trim();
      if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
      const match = /^registry\s*=\s*(.+)$/u.exec(line);
      if (match !== null) return trimSlash(match[1].trim());
    }
  }
  return DEFAULT_REGISTRY;
}

function trimSlash(value) {
  return String(value).replace(/\/+$/u, "");
}

/** One GET returning parsed JSON, with a timeout that kills the socket. */
function getJson(url) {
  return new Promise((resolve) => {
    let request;
    const finish = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        request?.destroy(new Error("timeout"));
      } catch {}
      finish({ ok: false, error: `请求超时（${Math.round(REQUEST_TIMEOUT_MS / 1000)} 秒）` });
    }, REQUEST_TIMEOUT_MS);
    try {
      request = https.get(url, { timeout: REQUEST_TIMEOUT_MS, headers: { accept: "application/json" } }, (response) => {
        if (response.statusCode === 404) {
          response.resume();
          finish({ ok: false, notFound: true, error: "registry 上没有这个包" });
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          finish({ ok: false, error: `HTTP ${response.statusCode}` });
          return;
        }
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
          // A runaway response must not eat memory; npm metadata is small but a
          // misconfigured registry could stream anything.
          if (body.length > 4_000_000) {
            try {
              request?.destroy();
            } catch {}
            finish({ ok: false, error: "响应过大，已中止" });
          }
        });
        response.on("end", () => {
          try {
            finish({ ok: true, value: JSON.parse(body) });
          } catch {
            finish({ ok: false, error: "registry 返回的不是 JSON" });
          }
        });
      });
      request.on("error", (error) => finish({ ok: false, error: error?.message ?? String(error) }));
      request.on("timeout", () => {
        try {
          request.destroy(new Error("timeout"));
        } catch {}
        finish({ ok: false, error: "请求超时" });
      });
    } catch (error) {
      finish({ ok: false, error: error?.message ?? String(error) });
    }
  });
}

/** Compare two semver strings; returns -1 / 0 / 1. */
function compareVersions(left, right) {
  const parse = (value) => {
    const text = String(value ?? "").replace(/^v/u, "");
    const [core, prerelease] = text.split("-", 2);
    const parts = core.split(".").map((part) => Number.parseInt(part, 10));
    return { parts: parts.map((part) => (Number.isFinite(part) ? part : 0)), prerelease };
  };
  const a = parse(left);
  const b = parse(right);
  const length = Math.max(a.parts.length, b.parts.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (a.parts[index] ?? 0) - (b.parts[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  // A prerelease is LOWER than its release: 1.2.0-rc.1 < 1.2.0.
  if (a.prerelease === undefined && b.prerelease === undefined) return 0;
  if (a.prerelease === undefined) return 1;
  if (b.prerelease === undefined) return -1;
  return a.prerelease === b.prerelease ? 0 : a.prerelease > b.prerelease ? 1 : -1;
}

/** Run `worker` over `items` with a bounded number in flight. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Ask the registry for the current `latest` of every package in `names`.
 *
 * `names` is a list of `{ name, version }` (version = what is installed). The
 * result keeps one row per input, in input order, so the caller can render it
 * without re-joining.
 */
async function checkVersions(names, options = {}) {
  const registry = trimSlash(options.registry ?? DEFAULT_REGISTRY);
  const results = await mapLimit(names, CONCURRENCY, async (entry) => {
    const name = typeof entry === "string" ? entry : entry.name;
    const installed = typeof entry === "string" ? undefined : entry.version;
    const url = `${registry}/${encodePackageName(name)}/latest`;
    const response = await getJson(url);
    if (response.ok !== true) {
      return { name, installed, registry, ok: false, error: response.error, notFound: response.notFound === true };
    }
    const latest = typeof response.value?.version === "string" ? response.value.version : undefined;
    if (latest === undefined) {
      return { name, installed, registry, ok: false, error: "registry 没有返回 version 字段" };
    }
    const comparison = installed === undefined ? undefined : compareVersions(latest, installed);
    return {
      name,
      installed,
      latest,
      registry,
      ok: true,
      // Only a strictly higher `latest` is an update. A lower one means the
      // installed copy came from somewhere else (a link, a dist-tag, a fork) and
      // "upgrading" would DOWNgrade it — reported, not acted on.
      outdated: comparison === 1,
      same: comparison === 0,
      behind: comparison === -1,
      deprecated: typeof response.value?.deprecated === "string" ? response.value.deprecated : undefined,
    };
  });
  const outdated = results.filter((row) => row.outdated === true);
  return {
    registry,
    checked: results.length,
    rows: results,
    outdated,
    failed: results.filter((row) => row.ok !== true),
    hasUpdates: outdated.length > 0,
    checkedAt: new Date().toISOString(),
  };
}

module.exports = {
  CONCURRENCY,
  DEFAULT_REGISTRY,
  checkVersions,
  compareVersions,
  encodePackageName,
  getJson,
  mapLimit,
  registryFor,
};
