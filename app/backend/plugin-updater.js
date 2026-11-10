"use strict";
// Plugin update/repair engine shared by the recovery console and the
// `dsh-plugin-doctor` CLI.
//
// Why this exists: two defects in DSH Desktop 0.2.1-rc.2 make in-app plugin
// updates unreliable —
//
//   1. `@deepseek-ai/dsh-plugin-manager`'s `removeBundle()` runs pnpm (which
//      succeeds and deletes the package), then calls `configure()` →
//      `hmr.runExclusive()`. That queue is serialised with no timeout and no
//      cancellation, so one unsettled head blocks every later operation: the
//      `add` half of the same update, the next update, the market's own lock.
//      pnpm already finished, so the UI sticks on "Removing…" while the package
//      is gone — and after a restart the plugin is simply missing.
//
//   2. `dshmarket`'s `installOrReinstall()` refuses to update itself
//      (`market-self-update`): removing the market unloads the code that would
//      run the reinstall. The app's Plugins page has no update entry either,
//      so pnpm against the profile with DSH fully quit is the only path.
//
// Both are avoided the same way: mutate the profile with the app stopped.
//
// This module only uses Node built-ins, so it works while the target profile
// itself cannot boot. It never prints; every operation returns a result object
// so a CLI and a UI can both render it.

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const https = require("node:https");

// The packages that ship inside the application. `profile.js` owns this list
// (it is the module that classifies plugins); importing it here instead of
// keeping a second copy is what keeps "is this a core bundle?" from having two
// answers that can drift apart.
const { CORE_BUNDLES } = require("./profile");
const SPEC_PATTERN = /^[A-Za-z0-9@:./_#+~^=-]+$/;

// The market the console itself is able to install. `dsh-market` is the older
// package name, kept so a profile that still uses it is recognised as "already
// has a market" instead of being offered a second, parallel copy.
const MARKET_SPEC = "dshmarket";
const MARKET_NAMES = ["dshmarket", "dsh-market"];

// ---------------------------------------------------------------------------
// Small filesystem helpers
// ---------------------------------------------------------------------------

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function pathExists(target) {
  try {
    fs.accessSync(target);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** Write a file through a sibling temp file plus rename, so readers never see half a manifest. */
function writeJsonAtomic(file, value) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now().toString(36)}.tmp`);
  fs.writeFileSync(temp, `${JSON.stringify(value, undefined, 2)}\n`, "utf8");
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {}
    throw error;
  }
}

function profileManifestPath(dir) {
  return path.join(dir, "package.json");
}

function installedManifest(dir, name) {
  try {
    return readJson(path.join(dir, "node_modules", ...name.split("/"), "package.json"));
  } catch {
    return undefined;
  }
}

function installedVersion(dir, name) {
  return installedManifest(dir, name)?.version;
}

/**
 * Resolve a pasted GitHub reference to the npm package it publishes.
 *
 * Installing from a URL is only safe when it resolves to a *published npm
 * package*: `pnpm add owner/repo` would clone the repository, run its build
 * scripts, and usually fail, because DSH plugins ship built output that is not
 * committed. So the URL is used to discover the package name, and the install
 * itself still comes from the registry — the same artifact everyone else gets.
 *
 * Accepted shapes (anything a person or an AI might paste):
 *   https://github.com/owner/repo            (optionally /tree/<ref>/<subpath>)
 *   github.com/owner/repo, owner/repo, owner/repo#subpath
 *   git+https://…, git@github.com:owner/repo.git
 */
function parseGithubRef(raw) {
  const input = typeof raw === "string" ? raw.trim() : "";
  if (input === "") return undefined;
  const bare = input.replace(/^git\+/u, "").replace(/\.git$/u, "").replace(/\/+$/u, "");
  const scp = /^git@([^:]+):(.+)$/u.exec(bare);
  const rest = scp === null ? bare : `${scp[1]}/${scp[2]}`;
  const match =
    /^(?:(?:https?|ssh|git):\/\/)?(?:www\.)?github\.com[/:]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)(?:\/tree\/([^/\s]+)(?:\/(.+?))?)?$/u.exec(
      rest,
    );
  if (match !== null) {
    return { owner: match[1], repo: match[2], ref: match[3], subpath: match[4] === undefined ? undefined : match[4] };
  }
  // `owner/repo#subpath` — accepted because the `#` makes it unambiguous repo
  // syntax. Bare `owner/repo` is deliberately NOT treated as a repository: a
  // scoped npm package is written `@scope/name`, and someone typing
  // `dsh-ops/extra` means a package, not a GitHub path. Only an explicit
  // github.com host or the `#` form switches into repository mode.
  const short = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)#([^\s]+)$/u.exec(bare);
  if (short !== null) return { owner: short[1], repo: short[2], subpath: short[3] };
  return undefined;
}

/** Whether an input should be treated as a repository reference rather than a spec. */
function looksLikeGithub(raw) {
  return parseGithubRef(raw) !== undefined;
}

function fetchGithubJson(url, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let request;
    try {
      request = https.get(
        url,
        { headers: { "user-agent": "dsh-recovery", accept: "application/vnd.github+json" }, timeout: timeoutMs },
        (response) => {
          if (response.statusCode !== 200) {
            response.resume();
            const limited = response.headers["x-ratelimit-remaining"] === "0";
            done({
              ok: false,
              status: response.statusCode,
              reason:
                response.statusCode === 404
                  ? "仓库或文件不存在（私有仓库也会是 404）"
                  : limited
                    ? "GitHub API 额度已用尽，请稍后再试"
                    : `GitHub 返回 ${response.statusCode}`,
            });
            return;
          }
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            body += chunk;
            if (body.length > 512 * 1024) request.destroy();
          });
          response.on("end", () => {
            try {
              done({ ok: true, value: JSON.parse(body) });
            } catch {
              done({ ok: false, status: "invalid-json", reason: "仓库返回的不是有效 JSON" });
            }
          });
        },
      );
      request.on("timeout", () => {
        request.destroy();
        done({ ok: false, status: "timeout", reason: "连接 GitHub 超时" });
      });
      request.on("error", (error) => done({ ok: false, status: "network", reason: `网络错误: ${error.message}` }));
    } catch (error) {
      done({ ok: false, status: "network", reason: `无法连接: ${error.message}` });
    }
  });
}

/**
 * Read a repository's own package.json to learn which npm package it publishes.
 *
 * raw.githubusercontent is tried first: it has no rate limit and the manifest is
 * all this needs. A monorepo keeps the plugin one level down, so that layout is
 * tried as well.
 *
 * Transient network failures are retried: GitHub's raw host resets connections
 * under load, and failing the whole install because of one `ECONNRESET` would
 * claim the repository is broken when it is not.
 */
async function resolveGithubPackage(raw, options = {}) {
  const ref = parseGithubRef(raw);
  if (ref === undefined) return undefined;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15000;
  const attempts = Number.isFinite(options.attempts) ? options.attempts : 3;
  const refOrBranch = ref.ref === undefined ? "HEAD" : ref.ref;
  const prefix = ref.subpath === undefined ? "" : `${ref.subpath.replace(/^\/+|\/+$/gu, "")}/`;
  const base = `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${refOrBranch}/${prefix}`;
  const candidates = [
    `${base}package.json`,
    `${base}packages/${ref.repo.replace(/^dsh-/u, "")}/package.json`,
    `${base}packages/${ref.repo}/package.json`,
  ];
  const tried = [];
  for (const url of candidates) {
    let response;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      response = await fetchGithubJson(url, timeoutMs);
      // Retry only what can plausibly succeed on a second try; a 404 is final.
      const transient = response.ok !== true && (response.status === "network" || response.status === "timeout");
      if (!transient || attempt === attempts) break;
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
    if (response.ok !== true) {
      tried.push(`${url} → ${response.reason ?? response.status}`);
      continue;
    }
    const manifest = response.value;
    const name = typeof manifest?.name === "string" ? manifest.name.trim() : "";
    if (name === "") {
      tried.push(`${url} → 该 package.json 没有 name 字段`);
      continue;
    }
    return {
      name,
      version: typeof manifest.version === "string" ? manifest.version : undefined,
      description: typeof manifest.description === "string" ? manifest.description : undefined,
      isBundle: manifest?.dsh?.bundle !== undefined,
      repository: `https://github.com/${ref.owner}/${ref.repo}`,
      manifestUrl: url,
    };
  }
  return { error: `无法从 ${ref.owner}/${ref.repo} 的仓库里读到 package.json`, details: tried };
}

/**
 * Whether a plugin is a local working copy or came from a registry.
 *
 * A `link:`/`file:` specifier, or a `node_modules` entry that is actually a
 * junction to somewhere else, means the profile is pointing at a folder the
 * user edits. pnpm has no "upgrade" for that: `pnpm add name@latest` would
 * resolve the *registry* package and replace the link with a downloaded copy,
 * silently detaching the user's working copy. The console therefore must not
 * offer 升级 for these — only 检查.
 */
function originOf(dir, name, declared) {
  const spec = typeof declared === "string" ? declared : "";
  const isLocalSpec = /^(?:link|file):/iu.test(spec);
  let linked = false;
  try {
    linked = fs.lstatSync(path.join(dir, "node_modules", ...String(name).split("/"))).isSymbolicLink();
  } catch {
    linked = false;
  }
  if (!isLocalSpec && !linked) return "registry";
  return "local";
}

/**
 * Which plugin market the profile has, if any.
 *
 * "Has a market" means the package is on disk, not merely declared: a
 * `package.json` entry whose `node_modules` copy is gone is the broken-profile
 * shape this console exists for, and offering 「升级到最新」 for it would fail on
 * "not installed" instead of repairing it. Such a profile gets 「安装插件市场」,
 * which reinstalls and restores the layer row in one step.
 */
function marketState(dir) {
  const manifest = readJson(profileManifestPath(dir));
  const dependencies = manifest.dependencies ?? {};
  const bundles = bundleList(manifest);
  for (const name of MARKET_NAMES) {
    const onDisk = installedManifest(dir, name);
    const declared = dependencies[name];
    if (onDisk === undefined && declared === undefined) continue;
    return {
      name,
      version: onDisk?.version,
      declared: typeof declared === "string" ? declared : undefined,
      installed: onDisk !== undefined,
      inBundles: bundles.includes(name),
    };
  }
  return { name: MARKET_SPEC, version: undefined, declared: undefined, installed: false, inBundles: false };
}

/**
 * Install the market into a profile that never had one.
 *
 * This is the same `pnpm add` the market's own installer would run, done with
 * the application stopped — which is also why it is the only place this can be
 * arranged when the market is what is missing: without the market there is no
 * in-app page to install it from.
 */
async function installMarket(dir, options = {}) {
  const before = marketState(dir);
  if (before.installed) throw new Error(`${before.name} 已经安装在这个 profile 里；请改用「升级到最新」`);
  const outcome = await install(dir, MARKET_SPEC, options);
  // A dry run writes nothing, so "is it installed now?" is still false — that
  // is the expected result of a preview, not a failure.
  if (outcome.dryRun === true) return { ...outcome, market: before };
  const after = marketState(dir);
  const lines = [...(outcome.lines ?? [])];
  if (after.installed && !after.inBundles) {
    lines.push({
      level: "warn",
      text: `${after.name} 已装好，但不在 dsh.profile.bundles 里 —— 它没有声明 dsh.bundle，重启后需要在应用内启用`,
    });
  } else if (after.installed) {
    lines.push({ level: "ok", text: `${after.name}@${after.version} 已加入插件层，重启 DSH 后生效` });
  }
  return {
    ...outcome,
    ok: outcome.ok === true && after.installed,
    name: after.name,
    version: after.version,
    lines,
    market: after,
  };
}

function isBundle(manifest) {
  return manifest !== undefined && manifest.dsh !== undefined && manifest.dsh.bundle !== undefined;
}

function bundleList(manifest) {
  return manifest.dsh?.profile?.bundles ?? [];
}

function setBundleList(manifest, bundles) {
  manifest.dsh = manifest.dsh ?? {};
  manifest.dsh.profile = manifest.dsh.profile ?? {};
  manifest.dsh.profile.bundles = bundles;
}

/**
 * Whether the package declares a host entry at all.
 *
 * A patch-only bundle is legitimate: it ships `dsh.bundle.patch` and uses only
 * `exports` subpaths for assets, with no `main` and no "." export. Such a
 * package has no host half to load, so a missing entry file is not a defect.
 */
function declaresEntry(manifest) {
  if (typeof manifest.main === "string") return true;
  if (manifest.dsh?.client !== undefined) return true;
  const exportsField = manifest.exports;
  if (typeof exportsField === "string") return true;
  if (exportsField === null || typeof exportsField !== "object") return false;
  return [".", "./index", "./server", "./host"].some((key) => exportsField[key] !== undefined);
}

/** The entry file a package declares, if it exists on disk. */
function entryFile(dir, name, manifest) {
  const packageDir = path.join(dir, "node_modules", ...name.split("/"));
  const candidates = [];
  if (typeof manifest.main === "string") candidates.push(manifest.main);
  const exportsField = manifest.exports;
  if (typeof exportsField === "string") candidates.push(exportsField);
  else if (exportsField !== null && typeof exportsField === "object") {
    for (const key of [".", "./index", "./server", "./host"]) {
      const value = exportsField[key];
      if (typeof value === "string") candidates.push(value);
      else if (value !== null && typeof value === "object") {
        for (const condition of ["import", "require", "default"]) {
          if (typeof value[condition] === "string") candidates.push(value[condition]);
        }
      }
    }
  }
  for (const fallback of ["index.js", "lib/index.js", "dist/index.js", "index.mjs"]) candidates.push(fallback);
  for (const candidate of candidates) {
    const absolute = path.join(packageDir, candidate);
    if (pathExists(absolute) && fs.statSync(absolute).isFile()) return candidate;
  }
  return undefined;
}

/**
 * Bundle patch files declared by `dsh.bundle`.
 *
 * The host's own reader (`bundlePatchFiles()` in dsh-app-boot) accepts exactly
 * `{ patch: string | string[] }` and throws on anything else, so this mirrors
 * that shape rather than inventing a wider one.
 */
function bundlePatchFiles(dir, name, manifest) {
  const bundle = manifest?.dsh?.bundle;
  if (bundle === undefined) return [];
  const declared = typeof bundle.patch === "string" ? [bundle.patch] : bundle.patch;
  if (!Array.isArray(declared) || !declared.every((file) => typeof file === "string")) {
    return [{ file: undefined, exists: false, invalid: "dsh.bundle.patch 必须是文件路径或其列表" }];
  }
  return declared.map((relative) => {
    const file = path.join(dir, "node_modules", ...name.split("/"), relative);
    return { file, exists: pathExists(file) };
  });
}

function missingBundlePatch(dir, name, manifest) {
  return bundlePatchFiles(dir, name, manifest).find((patch) => patch.exists === false) ?? null;
}

/** `dshmarket@1.66.45` → `dshmarket`; anything that is not a registry name stays unparsed. */
function registryNameOf(spec) {
  const at = spec.indexOf("@", 1);
  const name = at === -1 ? spec : spec.slice(0, at);
  return /^(@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+$/.test(name) ? name : spec;
}

// ---------------------------------------------------------------------------
// Install layout / pnpm discovery
// ---------------------------------------------------------------------------

/**
 * The DSH installation directory, from a recovery-console target.
 *
 * The console selects a target either by its install folder or by the app
 * executable; both name the same directory one level below.
 */
function installDirOf(target) {
  if (target === undefined || target === null) return undefined;
  if (typeof target.dir === "string" && target.dir !== "") return path.resolve(target.dir);
  if (typeof target.exe === "string" && target.exe !== "") return path.dirname(target.exe);
  return undefined;
}

function bundledRuntime(installDir) {
  if (installDir === undefined) return undefined;
  const root = path.join(installDir, "resources", "runtime", "primary-runtime", "dependencies");
  const pnpm = path.join(root, "pnpm", "bin", "pnpm.mjs");
  const node = path.join(root, "node", "bin", process.platform === "win32" ? "node.exe" : "node");
  if (!pathExists(pnpm)) return undefined;
  return { pnpm, node: pathExists(node) ? node : undefined };
}

/**
 * How to run pnpm: an executable plus leading arguments and extra env.
 *
 * Preference order is the installation's own runtime (exactly what DSH itself
 * uses, and present even when PATH is not), then an explicit override, then a
 * PATH pnpm. A host that is itself Electron runs pnpm through itself with
 * ELECTRON_RUN_AS_NODE, which needs no separate Node install.
 */
function resolvePnpm(installDir) {
  const runtime = bundledRuntime(installDir);
  if (runtime !== undefined) {
    return runtime.node === undefined
      ? { command: process.execPath, prefix: [runtime.pnpm], env: { ELECTRON_RUN_AS_NODE: "1" }, source: "DSH 自带运行时" }
      : { command: runtime.node, prefix: [runtime.pnpm], env: {}, node: runtime.node, source: "DSH 自带运行时" };
  }
  const override = process.env.DSH_PNPM_ENTRY;
  if (typeof override === "string" && override !== "" && pathExists(override)) {
    const isScript = /\.[cm]?js$/u.test(override);
    return {
      command: isScript ? process.execPath : override,
      prefix: isScript ? [override] : [],
      env: isScript ? { ELECTRON_RUN_AS_NODE: "1" } : {},
      source: "环境变量 DSH_PNPM_ENTRY",
    };
  }
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  // A broken `pnpm.cmd` on PATH can hang instead of exiting; probing it must
  // not become the thing that freezes the console.
  const probe = spawnSync(command, ["--version"], {
    encoding: "utf8",
    windowsHide: true,
    shell: process.platform === "win32",
    timeout: 20000,
  });
  if (probe.status === 0) {
    return { command, prefix: [], env: {}, source: "PATH", shell: process.platform === "win32" };
  }
  return undefined;
}

function pnpmVersion(runner) {
  const result = spawnSync(runner.command, [...runner.prefix, "--version"], {
    encoding: "utf8",
    windowsHide: true,
    shell: runner.shell === true,
    env: { ...process.env, ...runner.env },
    timeout: 20000,
  });
  return result.status === 0 ? String(result.stdout).trim() : undefined;
}

// pnpm downloads, verifies the lockfile against supply-chain policy, and runs
// each package's lifecycle scripts. Any of those can stall on a flaky registry
// or a hanging `postinstall`; a few minutes is generous for a single package.
const PNPM_TIMEOUT_MS = 6 * 60 * 1000;

/**
 * Run pnpm without ever freezing the caller.
 *
 * Two separate hazards, both confirmed by a real stalled run in this profile:
 *
 *   1. `spawnSync` blocks its own process for as long as the child lives. Inside
 *      Electron that is the *main* process, which also paints the window and
 *      answers IPC — so one slow pnpm made the console look dead ("更新插件把
 *      软件卡死"). The child is therefore launched from `pnpm-runner.js`, a
 *      separate process, and this call simply waits for its single JSON line.
 *   2. Even a well-behaved child can stall indefinitely (registry retry loops,
 *      a lockfile policy check against an unreachable network, a lifecycle
 *      script that never exits). The runner enforces PNPM_TIMEOUT_MS and kills
 *      the tree, which surfaces as a normal failure instead of a hang.
 */
function runPnpm(dir, runner, args, options = {}) {
  const budget = Number.isFinite(options.timeoutMs) ? options.timeoutMs : PNPM_TIMEOUT_MS;
  const job = {
    command: runner.command,
    prefix: runner.prefix,
    args,
    cwd: dir,
    env: runner.env ?? {},
    shell: runner.shell === true,
    timeoutMs: budget,
  };
  const encoded = Buffer.from(JSON.stringify(job), "utf8").toString("base64");
  // The runner is ordinary Node code, so it needs a Node runtime. Prefer the
  // pnpm runtime's own node; fall back to Electron in node mode, which is the
  // same thing the pnpm invocation itself would have used.
  const nodeForRunner = runner.node ?? process.execPath;
  // Async `spawn`, not `spawnSync`: the main process must keep painting while
  // pnpm works, otherwise a slow update still looks like a frozen window. The
  // outer budget is a safety net in case the runner process itself dies silently.
  return new Promise((resolve, reject) => {
    const child = spawn(nodeForRunner, [path.join(__dirname, "pnpm-runner.js"), `--job=${encoded}`], {
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      fn(value);
    };
    const guard = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      finish(reject, new Error(`pnpm 运行器超过 ${budget + 30000} 毫秒没有返回，已中止。`));
    }, budget + 45000);
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 64 * 1024 * 1024) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 64 * 1024 * 1024) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish(reject, new Error(`无法启动 pnpm 运行器: ${error.message}`)));
    child.on("close", (status) => {
      try {
        finish(resolve, interpret({ status, stdout, stderr }, budget));
      } catch (error) {
        finish(reject, error);
      }
    });
  });
}

/** Turn the runner's single JSON line into either a result or a readable throw. */
function interpret(result, budget) {
  if (result.error !== undefined) throw new Error(`无法启动 pnpm 运行器: ${result.error.message}`);
  const line = String(result.stdout ?? "")
    .trim()
    .split("\n")
    .reverse()
    .find((entry) => entry.startsWith("{"));
  if (line === undefined) {
    const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    throw new Error(`pnpm 运行器没有返回结果（退出码 ${result.status}）\n${detail.slice(-2000)}`);
  }

  let payload;
  try {
    payload = JSON.parse(line);
  } catch {
    throw new Error(`pnpm 运行器返回了无法解析的结果: ${line.slice(0, 500)}`);
  }

  const output = `${payload.stdout ?? ""}${payload.stderr ?? ""}`;
  if (payload.ok !== true) {
    if (payload.reason === "timeout") {
      const minutes = Math.max(1, Math.round(budget / 60000));
      throw new Error(
        `pnpm 超过约 ${minutes} 分钟没有结束，已强制中止（这一轮不会继续卡住）。\n` +
          "常见原因：registry 连不上而在反复重试、lockfile 的供应链策略校验超时、或某个包的生命周期脚本一直不退出。\n" +
          "建议：先点「修复插件状态」，再检查网络与 registry 设置后重试。\n\n最后输出：\n" +
          output.trim().slice(-2000),
      );
    }
    throw new Error(`pnpm 无法启动: ${payload.message ?? payload.reason}`);
  }
  return { status: payload.status, output };
}

/**
 * Flags every mutating pnpm call gets.
 *
 * `minimum-release-age=0` matters because a user-initiated update must not be
 * silently held back by pnpm's fresh-release window.
 *
 * `--ignore-scripts` is the difference between "update one package" and "run
 * arbitrary code from that package with full user rights while the console
 * waits". A plugin whose `postinstall` prompts, downloads, or hangs is the most
 * direct way an update turns into a frozen window; the packages that need a
 * build are built by the host at startup anyway, and `--ignore-scripts` does
 * not affect resolution or linking.
 *
 * `--config.side-effects-cache=false` keeps the store from replaying a previous
 * build's effects for a version that just changed.
 */
function pnpmFlags(options = {}) {
  const list = [
    "--config.minimum-release-age=0",
    "--ignore-scripts",
    "--config.side-effects-cache=false",
  ];
  if (typeof options.registry === "string" && options.registry !== "") list.push(`--config.registry=${options.registry}`);
  return list;
}

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------

/** Packages the DSH installation itself ships (they resolve from inside the app). */
function installationProvides(name, installDir) {
  if (installDir !== undefined) {
    const prefix = name.split("/");
    const roots = [
      path.join(installDir, "resources", "app.asar", "dsh", "node_modules", ...prefix),
      path.join(installDir, "resources", "app.asar.unpacked", "dsh", "node_modules", ...prefix),
      path.join(installDir, "resources", "runtime", "primary-runtime", "dependencies", ...prefix),
    ];
    for (const root of roots) if (pathExists(path.join(root, "package.json"))) return true;
  }
  return name.startsWith("@deepseek-ai/");
}

/**
 * Conditions that make a pnpm mutation slow or prone to stalling.
 *
 * Reported *before* the run so the panel can warn instead of leaving the user
 * staring at a disabled button. Every entry was observed on a real profile:
 * a stale lockfile that fails the supply-chain policy check after a minute of
 * registry retries, a `pnpm-workspace.yaml` whose pins disagree with it, and a
 * store on a different drive than the profile (no hard links, so every update
 * copies instead of linking).
 */
function updateRisks(dir, options = {}) {
  const risks = [];
  const lockfile = path.join(dir, "pnpm-lock.yaml");
  const workspace = path.join(dir, "pnpm-workspace.yaml");

  if (!pathExists(lockfile)) {
    risks.push({
      level: "info",
      text: "没有 pnpm-lock.yaml：本次会用 registry 最新解析，速度取决于网络。",
    });
  } else {
    const age = ageHours(lockfile);
    if (age !== undefined && age > 24 * 7) {
      risks.push({
        level: "warn",
        text: `pnpm-lock.yaml 已有约 ${Math.round(age / 24)} 天没更新；pnpm 会先做一遍供应链策略校验，网络不好时这一步可能耗时数十秒甚至超时。`,
      });
    }
  }

  if (pathExists(workspace)) {
    const text = fs.readFileSync(workspace, "utf8");
    if (/minimumReleaseAge/i.test(text)) {
      risks.push({
        level: "info",
        text: "pnpm-workspace.yaml 固定了发布等待期例外（minimumReleaseAgeExclude）。更新时会改写这个文件，属于预期行为。",
      });
    }
  }

  const storeDir = process.env.PNPM_HOME ?? process.env.npm_config_store_dir;
  if (typeof storeDir === "string" && storeDir !== "" && path.parse(storeDir).root.toLowerCase() !== path.parse(dir).root.toLowerCase()) {
    risks.push({
      level: "info",
      text: `pnpm store 与 Profile 不在同一个盘（${storeDir}），无法硬链接，更新会走复制，比平常慢。`,
    });
  }

  const stale = staleArtifacts(dir).filter((item) => item.alive !== true);
  if (stale.length > 0) {
    risks.push({
      level: "warn",
      text: `发现 ${stale.length} 个上次留下的锁/运行记录，它们会让 pnpm 等着一个已经不在的进程。先点「修复插件状态」再更新。`,
    });
  }

  return risks;
}

/** File age in hours, or undefined when it cannot be read. */
function ageHours(file) {
  try {
    return (Date.now() - fs.statSync(file).mtimeMs) / 3_600_000;
  } catch {
    return undefined;
  }
}

function staleArtifacts(dir) {
  const found = [];
  const lock = path.join(dir, "package.json.lock");
  if (pathExists(lock)) {
    const raw = fs.readFileSync(lock, "utf8").trim();
    const pid = Number.parseInt(raw.split("\n")[0], 10);
    found.push({ kind: "file-lock", path: lock, pid, alive: pidAlive(pid), label: "写入锁 package.json.lock" });
  }
  const runRecord = path.join(dir, ".plugin-manager", "run.json");
  if (pathExists(runRecord)) {
    let pid;
    try {
      pid = JSON.parse(fs.readFileSync(runRecord, "utf8"))?.pid;
    } catch {
      pid = undefined;
    }
    found.push({ kind: "run-record", path: runRecord, pid, alive: pidAlive(pid), label: "上次运行记录 run.json" });
  }
  return found;
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** One row per package the profile knows about, with every inconsistency spelled out. */
function inspectProfile(dir, options = {}) {
  const manifest = readJson(profileManifestPath(dir));
  const dependencies = manifest.dependencies ?? {};
  const bundles = bundleList(manifest);
  const installDir = options.installDir;
  const rows = [];

  for (const name of [...new Set([...Object.keys(dependencies), ...bundles])].sort()) {
    const declared = dependencies[name];
    const onDisk = installedManifest(dir, name);
    const version = onDisk?.version;
    rows.push({
      name,
      declared,
      version,
      bundle: isBundle(onDisk),
      inBundles: bundles.includes(name),
      core: CORE_BUNDLES.includes(name),
      // Where this plugin came from decides which buttons make sense: a local
      // working copy cannot be "upgraded" without replacing the link.
      origin: originOf(dir, name, declared),
      entryDeclared: onDisk === undefined ? false : declaresEntry(onDisk),
      entry: onDisk === undefined ? undefined : entryFile(dir, name, onDisk),
      patchMissing: onDisk === undefined ? null : missingBundlePatch(dir, name, onDisk),
      installationProvided: false,
      stale: false,
      problems: [],
    });
  }

  for (const row of rows) {
    if (row.declared === undefined && row.version === undefined) {
      // A bundle row can name an installation-provided package (dsh-base,
      // dsh-web-app) or one that is simply gone. Only the second is a defect.
      row.installationProvided = row.inBundles && installationProvides(row.name, installDir);
      row.stale = row.inBundles && !row.installationProvided;
      if (row.stale) row.problems.push("列在插件层里，但既没有安装也没有在依赖中声明（会让 profile 组不起来）");
      else continue;
    }
    if (row.declared === undefined && row.version !== undefined) row.problems.push("磁盘上已安装，但没有写进 package.json");
    if (row.declared !== undefined && row.version === undefined) row.problems.push("package.json 里有声明，但 node_modules 里没有（重启后组不起来）");
    // An installed plugin that is not in `dsh.profile.bundles` is DISABLED, not
    // broken. Leaving a package out of the layer is the supported way to turn a
    // plugin off while keeping it installed, so treating it as an inconsistency
    // made the console cry wolf about a state the user chose on purpose — and
    // 「修复插件状态」 would then helpfully re-enable it. Only the opposite
    // direction (in the layer but declares no dsh.bundle) actually breaks
    // composition.
    if (!row.bundle && row.inBundles && row.version !== undefined) row.problems.push("列在 dsh.profile.bundles 里，但没有声明 dsh.bundle（会让组合失败）");
    if (row.entryDeclared && row.entry === undefined) row.problems.push("声明了入口文件，但文件不存在（构建不完整）");
    if (row.patchMissing !== null) row.problems.push(row.patchMissing?.invalid ?? `补丁文件不存在: ${row.patchMissing.file}`);
    if (typeof row.declared === "string" && /^\d+\.\d+\.\d+/u.test(row.declared) && row.version !== undefined && row.declared !== row.version) {
      row.problems.push(`package.json 记为 ${row.declared}，实际安装的是 ${row.version}`);
    }
  }

  return { dir, manifest, dependencies, bundles, rows, inconsistent: rows.filter((row) => row.problems.length > 0) };
}

/**
 * Explain the market's own log: an operation that started and never reported a
 * result is the HMR-hang signature, and its pnpm log tells whether the package
 * manager had already finished when the stall began.
 */
function diagnose(dir, options = {}) {
  const installDir = options.installDir;
  const findings = { stuck: [], stale: [], problems: [], notes: [] };
  const marketLog = path.join(dir, ".dsh-market", "log.ndjson");
  let events = [];
  if (pathExists(marketLog)) {
    events = fs
      .readFileSync(marketLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }
  if (events.length === 0) findings.notes.push("没有找到市场日志（.dsh-market/log.ndjson），无法判断上次操作停在哪。");

  // Match a start to its finish by PACKAGE NAME over the whole log: an
  // `update-start` names `pkg -> pkg@1.2.3`, while the same work is reported as
  // `install pkg@1.2.3 …`, so a prefix comparison would call every successful
  // update stuck.
  const started = new Map();
  const finishedAt = new Map();
  for (const event of events) {
    const key = registryNameOf(String(event.detail ?? "").split(" ")[0]);
    if (/^(install|update|uninstall)-start$/u.test(event.event)) {
      if (!started.has(key)) started.set(key, event);
    }
    if (/^(install|update|uninstall)$/u.test(event.event)) finishedAt.set(key, event);
  }

  const report = inspectProfile(dir, { installDir });
  const referenced = new Set(report.rows.filter((row) => row.declared !== undefined || row.version !== undefined).map((row) => row.name));

  for (const [name, event] of started) {
    const finish = finishedAt.get(name);
    if (finish !== undefined && Date.parse(finish.at) >= Date.parse(event.at)) continue;
    const entry = { name, at: event.at, event: event.event, pnpmFinished: false, removed: false, logDir: undefined, resolved: !referenced.has(name) };
    const logsRoot = path.join(dir, ".plugin-manager", "logs");
    if (isDirectory(logsRoot)) {
      const startedAt = Date.parse(event.at);
      const near = fs
        .readdirSync(logsRoot, { withFileTypes: true })
        .filter((item) => item.isDirectory())
        .map((item) => ({ entry: item.name, at: fs.statSync(path.join(logsRoot, item.name)).mtimeMs }))
        .filter(({ at }) => !Number.isFinite(startedAt) || Math.abs(at - startedAt) <= 5 * 60 * 1000)
        .sort((a, b) => Math.abs(a.at - startedAt) - Math.abs(b.at - startedAt))
        .slice(0, 1);
      for (const candidate of near) {
        const log = path.join(logsRoot, candidate.entry, "pnpm.log");
        if (!pathExists(log)) continue;
        const text = fs.readFileSync(log, "utf8");
        entry.logDir = candidate.entry;
        entry.pnpmFinished = /\bDone in [\d.]+s/u.test(text);
        entry.removed = /^- /mu.test(text);
      }
    }
    if (entry.resolved) {
      findings.notes.push(`${name}: ${event.at} 的操作没有收尾，但 profile 已不再引用它（那次卡死已被重启清掉）。`);
    } else {
      findings.stuck.push(entry);
    }
  }

  findings.stale = staleArtifacts(dir);
  findings.problems = report.inconsistent.map((row) => ({ name: row.name, problems: row.problems }));
  findings.ok = findings.stuck.length === 0 && findings.stale.length === 0 && findings.problems.length === 0;
  return findings;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function requirePnpm(installDir) {
  const runner = resolvePnpm(installDir);
  if (runner === undefined) {
    throw new Error(
      "找不到可用的 pnpm：DSH 安装目录里没有自带运行时，环境变量 DSH_PNPM_ENTRY 也没有指向可执行文件，PATH 上也没有 pnpm。",
    );
  }
  return runner;
}

/**
 * Clear state that blocks the in-app plugin manager, and make
 * `dsh.profile.bundles` agree with what is actually installed.
 */
function repair(dir, options = {}) {
  const { installDir, dryRun } = options;
  const lines = [];
  let changes = 0;

  for (const item of staleArtifacts(dir)) {
    if (item.alive && item.kind === "file-lock") {
      lines.push({ level: "warn", text: `${item.label} 被仍在运行的进程 ${item.pid} 占用，保留不动` });
      continue;
    }
    if (item.alive && item.kind === "run-record") {
      lines.push({ level: "warn", text: `${item.label} 指向仍在运行的进程 ${item.pid}，保留不动` });
      continue;
    }
    if (dryRun === true) {
      lines.push({ level: "info", text: `将删除${item.label}: ${item.path}` });
      changes += 1;
      continue;
    }
    fs.rmSync(item.path, { force: true });
    lines.push({ level: "ok", text: `已删除${item.label}（进程 ${item.pid ?? "未知"} 已不在）` });
    changes += 1;
  }

  const manifest = readJson(profileManifestPath(dir));
  const bundles = bundleList(manifest);
  const dependencies = manifest.dependencies ?? {};
  const next = [];
  let bundlesChanged = false;

  for (const name of bundles) {
    if (installedManifest(dir, name) === undefined && dependencies[name] === undefined) {
      // Never drop a bundle the installation provides: it resolves from inside
      // the app, so "not in the profile" is its normal state, and removing
      // dsh-base or dsh-web-app leaves a profile that cannot boot.
      if (installationProvides(name, installDir)) {
        next.push(name);
        continue;
      }
      lines.push({ level: "bad", text: `${name}: 列在插件层里，但既没安装也没声明 —— 已从插件层移除` });
      bundlesChanged = true;
      continue;
    }
    next.push(name);
  }
  for (const name of Object.keys(dependencies)) {
    // Deliberately NOT re-added to `dsh.profile.bundles`.
    //
    // This used to say "已安装为插件但不在插件层 —— 已补回", on the theory that a
    // missing layer entry was always host damage. It is not: leaving a package
    // out of the layer is how a plugin gets disabled while staying installed,
    // and 修复插件状态 is supposed to repair breakage, not overrule a choice.
    // Silently re-enabling a plugin the user turned off is exactly the kind of
    // "repair that changes what I configured" nobody wants.
  }

  if (bundlesChanged) {
    if (dryRun === true) lines.push({ level: "info", text: "将重写 dsh.profile.bundles" });
    else {
      setBundleList(manifest, next);
      writeJsonAtomic(profileManifestPath(dir), manifest);
      lines.push({ level: "ok", text: `dsh.profile.bundles 现在有 ${next.length} 项` });
    }
    changes += 1;
  } else {
    lines.push({ level: "ok", text: "dsh.profile.bundles 与磁盘一致" });
  }

  const report = inspectProfile(dir, { installDir });
  const needReinstall = report.inconsistent.filter((row) =>
    row.problems.some((problem) => problem.includes("node_modules 里没有") || problem.includes("构建不完整")),
  );
  for (const row of needReinstall) {
    lines.push({ level: "bad", text: `${row.name}: 需要重新安装 —— 用「安装 / 升级」装回去` });
  }

  return {
    ok: needReinstall.length === 0,
    changes,
    needReinstall: needReinstall.map((row) => ({ name: row.name, version: row.version })),
    lines,
    message:
      needReinstall.length === 0
        ? changes === 0
          ? "没有需要修复的项目"
          : `已修复 ${changes} 处`
        : `已修复 ${changes} 处；${needReinstall.length} 个插件需要重新安装`,
  };
}

/**
 * Install whatever the user typed into the install box.
 *
 * Three shapes, one entry point:
 *   - a GitHub URL or `owner/repo` → resolve to its npm package, install that;
 *   - an ordinary spec (`name`, `name@1.2.3`, `@scope/name`) → install it;
 *   - anything else → refused by `install()`'s own spec check.
 *
 * A repository that is not published to npm is reported as such instead of
 * being cloned from source: `pnpm add owner/repo` builds the working tree and
 * fails for most DSH plugins, whose `lib/` output is not committed.
 */
async function installFromInput(dir, input, options = {}) {
  const raw = typeof input === "string" ? input.trim() : "";
  if (raw === "") throw new Error("请先填入包名或 GitHub 地址");
  if (!looksLikeGithub(raw)) return install(dir, raw, options);

  const resolved = await resolveGithubPackage(raw, options);
  if (resolved === undefined) throw new Error(`无法解析 ${raw}`);
  if (resolved.error !== undefined) {
    throw new Error(
      `${resolved.error}\n` +
        "请确认仓库地址正确、仓库是公开的，并且根目录（或 packages/<名字>/）有一份 package.json。\n" +
        `${(resolved.details ?? []).join("\n")}`,
    );
  }
  const outcome = await install(dir, resolved.name, options);
  const lines = [
    {
      level: "info",
      text: `${resolved.repository} → npm 包 ${resolved.name}${resolved.version === undefined ? "" : `@${resolved.version}`}`,
    },
    {
      level: "info",
      text: "安装的是该仓库发布到 npm 的版本（不是仓库源码），与你手动填包名装到的是同一个东西。",
    },
    ...(outcome.lines ?? []),
  ];
  if (resolved.isBundle !== true) {
    lines.push({
      level: "warn",
      text: `${resolved.name} 的 package.json 没有声明 dsh.bundle，装好后可能不会作为插件加载。`,
    });
  }
  return { ...outcome, lines, source: resolved };
}

async function install(dir, spec, options = {}) {
  const { installDir, dryRun, registry } = options;
  if (!SPEC_PATTERN.test(spec)) throw new Error(`拒绝把 ${JSON.stringify(spec)} 交给 pnpm`);
  const name = registryNameOf(spec);
  const lines = [];
  const before = readJson(profileManifestPath(dir));
  const previous = before.dependencies?.[name];

  if (dryRun === true) {
    lines.push({ level: "info", text: `将执行: pnpm add ${spec} ${pnpmFlags({ registry }).join(" ")}` });
    return { ok: true, dryRun: true, name, lines, message: "预览完成" };
  }

  const run = await runPnpm(dir, requirePnpm(installDir), ["add", spec, ...pnpmFlags({ registry })]);
  if (run.status !== 0) throw new Error(`pnpm add ${spec} 失败（退出码 ${run.status}）\n${run.output.trim()}`);

  const manifest = readJson(profileManifestPath(dir));
  const onDisk = installedManifest(dir, name);
  if (onDisk === undefined) throw new Error(`pnpm 报告成功，但 ${name} 仍不在 node_modules 里`);
  if (previous === spec && previous === manifest.dependencies?.[name]) {
    lines.push({ level: "info", text: `package.json 原本就固定为 ${previous}，已按该版本重新安装` });
  }
  if (isBundle(onDisk) && !bundleList(manifest).includes(name)) {
    setBundleList(manifest, [...bundleList(manifest), name]);
    writeJsonAtomic(profileManifestPath(dir), manifest);
    lines.push({ level: "ok", text: `已把 ${name} 加入 dsh.profile.bundles` });
  }
  const verdict = check(dir, name, { installDir });
  return { ok: verdict.ok, name, version: onDisk.version, lines: [...lines, ...verdict.lines], message: verdict.message };
}

async function update(dir, spec, options = {}) {
  const { installDir, dryRun, registry } = options;
  const name = registryNameOf(spec);
  const explicitVersion = spec === name ? undefined : spec.slice(name.length + 1);
  const lines = [];
  const current = installedVersion(dir, name);
  if (current === undefined) throw new Error(`${name} 没有安装在这个 profile 里；请改用安装`);
  // Refuse before anything else: an "upgrade" here would not upgrade the user's
  // working copy, it would replace the link with a registry download.
  if (originOf(dir, name, readJson(profileManifestPath(dir)).dependencies?.[name]) === "local") {
    throw new Error(
      `${name} 是本地插件（${readJson(profileManifestPath(dir)).dependencies?.[name] ?? "符号链接"}），不能升级。\n` +
        "它是 profile 指向的一个本机工作副本，pnpm 升级会把链接换成 registry 下载的副本，你的工作副本就被断开了。\n" +
        "要更新它请在它自己的目录里改代码；要改成联网版本，请先用「卸载」再「安装」。",
    );
  }
  lines.push({ level: "info", text: `${name} 当前版本 ${current}` });

  const target = explicitVersion === undefined ? `${name}@latest` : `${name}@${explicitVersion}`;
  if (dryRun === true) {
    lines.push({ level: "info", text: `将执行: pnpm add ${target} ${pnpmFlags({ registry }).join(" ")}` });
    return { ok: true, dryRun: true, name, from: current, lines, message: "预览完成" };
  }

  const wasBundle = isBundle(installedManifest(dir, name));
  const run = await runPnpm(dir, requirePnpm(installDir), ["add", target, ...pnpmFlags({ registry })]);
  if (run.status !== 0) throw new Error(`pnpm add ${target} 失败（退出码 ${run.status}）\n${run.output.trim()}`);

  const after = readJson(profileManifestPath(dir));
  const installed = installedVersion(dir, name);
  if (installed === undefined) throw new Error(`${name} 从 node_modules 里消失了 —— 这个 profile 会起不来`);
  // The bundle row is the difference between "installed" and "loads": the host
  // drops it during a remove, so restore it whenever the package still declares
  // a bundle.
  if (wasBundle && !bundleList(after).includes(name)) {
    setBundleList(after, [...bundleList(after), name]);
    writeJsonAtomic(profileManifestPath(dir), after);
    lines.push({ level: "ok", text: `已补回 ${name} 的插件层条目（宿主在移除时会先删掉它）` });
  }
  if (installed === current) {
    lines.push({ level: "warn", text: `版本仍是 ${current}：registry 上可能没有更新的版本，或新版本被发布等待期挡住` });
  } else {
    lines.push({ level: "ok", text: `已更新 ${current} → ${installed}` });
  }
  const verdict = check(dir, name, { installDir });
  return { ok: verdict.ok, name, from: current, to: installed, lines: [...lines, ...verdict.lines], message: verdict.message };
}

function check(dir, name, options = {}) {
  const manifest = readJson(profileManifestPath(dir));
  const onDisk = installedManifest(dir, name);
  if (onDisk === undefined) {
    return { ok: false, name, lines: [{ level: "bad", text: `${name}: 没有安装` }], message: `${name} 没有安装` };
  }
  const problems = [];
  if (declaresEntry(onDisk) && entryFile(dir, name, onDisk) === undefined) problems.push("声明的入口文件不存在");
  if (isBundle(onDisk) && !bundleList(manifest).includes(name)) problems.push("不在 dsh.profile.bundles 里");
  const missingPatch = missingBundlePatch(dir, name, onDisk);
  if (missingPatch !== null) problems.push(missingPatch.invalid ?? `补丁文件不存在: ${missingPatch.file}`);
  if (manifest.dependencies?.[name] === undefined) problems.push("没有写进 package.json");

  const lines = problems.length === 0
    ? [{ level: "ok", text: `${name}@${onDisk.version} 一致，可正常加载` }]
    : problems.map((problem) => ({ level: "bad", text: `${name}@${onDisk.version}: ${problem}` }));
  return {
    ok: problems.length === 0,
    name,
    version: onDisk.version,
    problems,
    lines,
    message: problems.length === 0 ? `${name}@${onDisk.version} 校验通过` : `${name} 校验未通过: ${problems.join("；")}`,
  };
}

/** One call for the console: inspect + diagnose + the package manager it would use. */
function summarize(dir, options = {}) {
  const installDir = options.installDir;
  const report = inspectProfile(dir, { installDir });
  const runner = resolvePnpm(installDir);
  return {
    profileDir: dir,
    pnpm: runner === undefined ? undefined : { source: runner.source, version: pnpmVersion(runner) },
    dependencies: Object.keys(report.dependencies).length,
    bundles: report.bundles.length,
    rows: report.rows,
    inconsistent: report.inconsistent.map((row) => ({ name: row.name, problems: row.problems })),
    stale: staleArtifacts(dir),
    // The panel shows 「安装插件市场」 when this is not installed and 「升级到最新」
    // when it is, so the decision is made from data rather than in the renderer.
    market: marketState(dir),
    diagnose: diagnose(dir, { installDir }),
    // Shown above the action list: an update that will take a long time (or is
    // about to wait on a dead process) should say so before the user clicks.
    risks: updateRisks(dir),
  };
}

function profileDirOf(home, name) {
  return path.join(home, "profiles", name);
}

module.exports = {
  CORE_BUNDLES,
  MARKET_NAMES,
  MARKET_SPEC,
  SPEC_PATTERN,
  bundleList,
  check,
  declaresEntry,
  diagnose,
  entryFile,
  inspectProfile,
  install,
  installDirOf,
  installFromInput,
  looksLikeGithub,
  parseGithubRef,
  resolveGithubPackage,
  installMarket,
  installedVersion,
  isBundle,
  marketState,
  pidAlive,
  profileDirOf,
  registryNameOf,
  repair,
  resolvePnpm,
  staleArtifacts,
  summarize,
  updateRisks,
  update,
  // Exposed for `--verify`: the stall/timeout behaviour is the whole point of
  // the runner process, and it is not reachable through the public commands
  // without a package manager and network.
  __runPnpm: runPnpm,
  PNPM_TIMEOUT_MS,
};
