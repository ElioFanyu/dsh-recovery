"use strict";
// `--verify`: end-to-end self test of the *mutating* actions (插件管理 / 回滚 /
// 启动·停止), run against a throwaway fixture inside `.runtime\verify-*`.
//
// It must never touch the real DSH home, the installed application, or the
// console's own config file: the fixture is a synthetic install plus a synthetic
// profile, and every check runs with the controller pointed at that fixture.
// The real config file is byte-compared before and after as an invariant.

const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const checkpoints = require("./checkpoints");
const launcher = require("./launcher");
const paths = require("./paths");
const awesome = require("./awesome");
const { withoutAsar } = require("./asar");
const { ensureDir, isDirectory, isFile, readJson, removeEntry, writeJsonAtomic } = require("./util");

const FIXTURE_PROFILE = "demo";
const FIXTURE_BUNDLE = "fake-bundle";
const FIXTURE_DEP = "fake-dep";
// Declared as `link:<folder>` and installed as a junction, so 插件管理 has a
// local (working copy) plugin to classify next to the registry one.
const FIXTURE_LINKED = "fake-linked";
// A registry package that declares no homepage and no repository.
const FIXTURE_NOHOME = "fake-no-home";
const CORE_BUNDLE = "@deepseek-ai/dsh-base";

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(120);
  }
  return predicate();
}

// sha256 of a raw file, read in chunks. Must run inside `withoutAsar` when the
// file is an archive: Electron's patched fs otherwise reports `app.asar` as a
// directory and reads archive members instead of the raw pickle (see asar.js).
function hashFileSync(file) {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

// The official `resources\app.asar` this checkout ships, taken from the state
// resolved with the real config *before* the controller is pointed at the
// fixture. Returns the digest the archive must still have afterwards, or a
// `problem` describing why the invariant could not be established.
function realArchive(targets, stamp) {
  const harness = (targets ?? []).find(
    (entry) => entry.kind === "deepseek-harness" && typeof entry.resourcesDir === "string" && !String(entry.dir).includes(stamp),
  );
  const file = harness === undefined ? undefined : path.join(harness.resourcesDir, "app.asar");
  if (file === undefined) return { problem: `未找到 deepseek-harness 目标（共 ${targets?.length ?? 0} 个）` };
  return withoutAsar(() => {
    if (!isFile(file)) return { problem: `app.asar 不存在：${file}` };
    try {
      return { file, size: fs.statSync(file).size, sha256: hashFileSync(file) };
    } catch (error) {
      return { problem: `无法读取 app.asar：${file} ${error instanceof Error ? error.message : String(error)}` };
    }
  });
}

function report() {
  const checks = [];
  const add = (name, ok, detail) => {
    checks.push(detail === undefined ? { name, ok } : { name, ok, detail });
    return ok;
  };
  return {
    checks,
    ok(name, condition, detail) {
      return add(name, condition === true, detail);
    },
    fail(name, detail) {
      return add(name, false, detail);
    },
    get passed() {
      return checks.filter((entry) => entry.ok).length;
    },
    get failed() {
      return checks.filter((entry) => entry.ok !== true).length;
    },
  };
}

function snapshotFile(file) {
  try {
    return { exists: true, bytes: fs.readFileSync(file) };
  } catch {
    return { exists: false };
  }
}

function unchanged(file, before) {
  const after = snapshotFile(file);
  if (before.exists !== after.exists) return false;
  return !before.exists || before.bytes.equals(after.bytes);
}

function errorText(response) {
  return typeof response?.error === "string" && response.error !== "" ? response.error : undefined;
}

/** Locate a stub executable that can run a short, observable command. */
function stubExecutable() {
  const candidates = [
    process.env.SystemRoot === undefined ? undefined : path.join(process.env.SystemRoot, "System32", "cmd.exe"),
    "C:\\Windows\\System32\\cmd.exe",
  ].filter((entry) => typeof entry === "string");
  return candidates.find((entry) => isFile(entry));
}

/**
 * Build the fixture: a synthetic install (so target detection finds it without
 * touching the real one) plus a synthetic Harness home with two packages.
 */
function buildFixture(root) {
  const installDir = path.join(root, "install");
  const home = path.join(root, "home");
  const profileDir = path.join(home, "profiles", FIXTURE_PROFILE);
  const work = path.join(root, "work");

  ensureDir(path.join(installDir, "resources", "app"));
  ensureDir(path.join(profileDir, "node_modules", FIXTURE_BUNDLE));
  ensureDir(path.join(profileDir, "node_modules", FIXTURE_DEP));
  ensureDir(work);
  fs.copyFileSync(stubExecutable(), path.join(installDir, "verify-stub.exe"));
  fs.writeFileSync(path.join(installDir, "version"), "44.0.0\n");
  writeJsonAtomic(path.join(installDir, "resources", "app", "package.json"), {
    name: "@deepseek-ai/dsh-desktop",
    version: "0.0.0-verify",
    description: "dsh-recovery --verify fixture; not a real installation",
  });
  writeJsonAtomic(path.join(profileDir, "package.json"), {
    name: `dsh-profile-${FIXTURE_PROFILE}`,
    private: true,
    dependencies: { [FIXTURE_BUNDLE]: "1.0.0", [FIXTURE_DEP]: "1.0.0", [CORE_BUNDLE]: "0.0.0-verify" },
    dsh: { profile: { bundles: [FIXTURE_BUNDLE] } },
  });
  writeJsonAtomic(path.join(profileDir, "node_modules", FIXTURE_BUNDLE, "package.json"), {
    name: FIXTURE_BUNDLE,
    version: "1.0.0",
    dsh: { bundle: { patch: "./patch.yml" } },
  });
  // The bundle declares patch.yml, so the fixture must actually contain it —
  // otherwise the updater's own "declared patch exists" check is right to fail.
  fs.writeFileSync(path.join(profileDir, "node_modules", FIXTURE_BUNDLE, "patch.yml"), "- insert: []\n");
  writeJsonAtomic(path.join(profileDir, "node_modules", FIXTURE_DEP, "package.json"), {
    name: FIXTURE_DEP,
    version: "1.0.0",
  });
  fs.writeFileSync(path.join(profileDir, "cordis.patch.yml"), `- id: fake-row\n  name: ${FIXTURE_BUNDLE}\n`);

  // A built-in component (they ship with the application, so the fixture needs
  // a real package.json for 插件管理 to classify it as `builtin`), and a
  // registry package that declares its homepage so the row's "open" button has
  // a URL to offer.
  ensureDir(path.join(profileDir, "node_modules", ...CORE_BUNDLE.split("/")));
  writeJsonAtomic(path.join(profileDir, "node_modules", ...CORE_BUNDLE.split("/"), "package.json"), {
    name: CORE_BUNDLE,
    version: "0.0.0-verify",
    dsh: { bundle: { patch: "./patch.yml" } },
  });
  writeJsonAtomic(path.join(profileDir, "node_modules", FIXTURE_BUNDLE, "package.json"), {
    name: FIXTURE_BUNDLE,
    version: "1.0.0",
    homepage: "https://example.invalid/fake-bundle",
    dsh: { bundle: { patch: "./patch.yml" } },
  });

  // A synthetic plugin repository plus a synthetic clone of the awesome-list,
  // so 收录插件 checks run on exactly the shapes contributing.md describes
  // (a good submission, a client-only one, and a duplicate of another entry).
  const pluginRepo = path.join(root, "plugin-repo");
  ensureDir(path.join(pluginRepo, "lib"));
  writeJsonAtomic(path.join(pluginRepo, "package.json"), {
    name: "verify-plugin",
    version: "1.0.0",
    description: "A verify fixture plugin.",
    main: "lib/index.js",
    dsh: { bundle: { patch: "./cordis.patch.yml" }, client: { platform: "web" } },
  });
  fs.writeFileSync(path.join(pluginRepo, "lib", "index.js"), `"use strict";\nmodule.exports = { apply() {} };\n`.repeat(8));
  fs.writeFileSync(path.join(pluginRepo, "cordis.patch.yml"), "- insert:\n    - id: verify-plugin\n      name: verify-plugin\n");
  fs.writeFileSync(path.join(pluginRepo, "README.md"), "# verify-plugin\n");

  const clientOnlyRepo = path.join(root, "client-only-repo");
  ensureDir(clientOnlyRepo);
  writeJsonAtomic(path.join(clientOnlyRepo, "package.json"), {
    name: "verify-client-only",
    version: "0.0.1",
    dsh: { client: { platform: "web" } },
  });
  fs.writeFileSync(path.join(clientOnlyRepo, "README.md"), "# placeholder\n");

  const listDir = path.join(root, "awesome-list");
  ensureDir(path.join(listDir, "data", "plugins"));
  writeJsonAtomic(path.join(listDir, "package.json"), { name: "awesome-dsh-plugin", version: "0.1.0" });
  // The "somebody else's entry" is listed under a *legacy* filename on purpose.
  // R13 reports the same URL under the filename this submission would generate
  // as the submitter's own uncommitted draft (not a duplicate), so a genuine
  // clash has to be a different file. Naming it differently also keeps the
  // duplicate check independent of `readdir` order, which `listEntries` does not
  // sort: with two files sharing the URL, `find` could return either.
  fs.writeFileSync(
    path.join(listDir, "data", "plugins", "someone__verify-plugin-legacy.yml"),
    "url: https://github.com/someone/verify-plugin\nname: someone/verify-plugin\ncategory: tools\ndescription:\n  en: Another plugin.\n",
  );

  return { root, installDir, home, profileDir, work, pluginRepo, clientOnlyRepo, listDir };
}

/**
 * 收录插件: every check runs against the synthetic repositories above, so the
 * rules are exercised without touching the network, the real DSH home, or any
 * real submission.
 */
/**
 * 环境备份: export → inspect → restore into a second, empty home.
 *
 * The point of this feature is that it survives a *different machine*, so the
 * restore half runs against a home that starts out empty rather than the one
 * the bundle came from — restoring over the source would pass even if every
 * path were hard-coded to it.
 */
async function verifyBackup(controller, fixture, result) {
  const home = fixture.home;
  const profileDir = path.join(home, "profiles", FIXTURE_PROFILE);

  // A `link:` dependency is set up here rather than borrowed from the plugin
  // tests, which remove theirs before this runs. The bundle has to carry the
  // real path and git origin of a working copy, so this is asserted against a
  // folder created for exactly that purpose.
  const linkedTarget = path.join(fixture.work, "local-plugin-src");
  ensureDir(linkedTarget);
  writeJsonAtomic(path.join(linkedTarget, "package.json"), { name: "fake-backup-linked", version: "1.0.0" });
  // A git config is INI, not JSON: `writeJsonAtomic` would serialise the string
  // and the section header would no longer be found.
  ensureDir(path.join(linkedTarget, ".git"));
  fs.writeFileSync(path.join(linkedTarget, ".git", "config"), '[remote "origin"]\n\turl = https://example.invalid/fake-backup-linked.git\n');
  fs.writeFileSync(path.join(linkedTarget, ".git", "HEAD"), "0123456789abcdef0123456789abcdef01234567\n");
  const manifestPath = path.join(profileDir, "package.json");
  const withLink = readJson(manifestPath);
  withLink.value.dependencies = { ...withLink.value.dependencies, "fake-backup-linked": `link:${linkedTarget}` };
  writeJsonAtomic(manifestPath, withLink.value);
  await controller.dispatch("recovery:refresh", []);

  result.ok(
    "环境备份: 面板能看到要打包的内容",
    controller.state.environmentBackup?.available === true &&
      controller.state.environmentBackup.plan.registryPlugins.length >= 1,
    controller.state.environmentBackup?.reason,
  );

  const exported = await controller.dispatch("recovery:backup-export", [{ includeSecrets: false }]);
  const file = exported.result?.backup?.file;
  result.ok(
    "环境备份: 导出成为一个可读的文件",
    exported.ok === true && isFile(file ?? "") && exported.result.backup.bytes > 0,
    errorText(exported) ?? exported.result?.backup?.sizeLabel,
  );
  result.ok(
    "环境备份: 默认不含凭据",
    exported.result?.backup?.includesSecrets === false,
    String(exported.result?.backup?.includesSecrets),
  );

  // The archive must describe itself: a bundle that unpacks to opaque bytes is
  // useless for a user who wants to check what they are about to restore.
  let peeked;
  try {
    peeked = require("./backup").peekBackup(file);
  } catch (error) {
    result.ok("环境备份: 包内含可读的 manifest.json", false, error instanceof Error ? error.message : String(error));
    return;
  }
  const manifest = peeked.manifest;
  result.ok(
    "环境备份: manifest 记录了插件与技能",
    manifest.format === "dsh-environment-backup" && manifest.registryPlugins.length >= 1 && Array.isArray(manifest.skills),
    `${manifest.registryPlugins.length} 个联网插件 / ${manifest.skills.length} 个技能`,
  );
  const localRow = (manifest.localPlugins ?? []).find((plugin) => plugin.name === "fake-backup-linked");
  result.ok(
    "环境备份: 本地插件记录了路径与 git remote",
    localRow !== undefined && localRow.path === linkedTarget && localRow.remote === "https://example.invalid/fake-backup-linked.git" && localRow.commit === "0123456789abcdef0123456789abcdef01234567",
    localRow === undefined ? "本地插件没有进清单" : JSON.stringify({ path: localRow.path, remote: localRow.remote, commit: localRow.commit }),
  );
  result.ok(
    "环境备份: 明确列出未进包的内容",
    Array.isArray(manifest.excluded) && manifest.excluded.some((entry) => String(entry.match).includes("node_modules")),
    `${manifest.excluded?.length ?? 0} 条`,
  );

  // Preview must describe the target home, and must not write anything.
  const before = fs.readFileSync(path.join(profileDir, "package.json"), "utf8");
  const preview = await controller.dispatch("recovery:backup-preview", [file]);
  result.ok(
    "环境备份: 预览统计新增/覆盖/相同",
    preview.ok === true && Number.isFinite(preview.result?.restore?.counts?.same),
    errorText(preview) ?? JSON.stringify(preview.result?.restore?.counts),
  );
  result.ok(
    "环境备份: 预览后源文件未被改动",
    fs.readFileSync(path.join(profileDir, "package.json"), "utf8") === before,
  );

  // Restore into an empty home: the real "new machine" case.
  const target = path.join(fixture.work, "restored-home");
  const agentsBase = path.join(fixture.work, "restored-agents");
  const plan = require("./backup").planRestore(target, file, { profileName: FIXTURE_PROFILE, agentsBase });
  result.ok(
    "环境备份: 空目录恢复计划全部为新增",
    plan.counts.create > 0 && plan.counts.overwrite === 0,
    JSON.stringify(plan.counts),
  );
  const applied = require("./backup").applyRestore(plan, { home: target });
  const restoredManifest = path.join(target, "profiles", FIXTURE_PROFILE, "package.json");
  result.ok(
    "环境备份: 恢复到空目录后 Profile 清单可解析",
    applied.written.length > 0 && readJson(restoredManifest).ok === true,
    `${applied.written.length} 个文件`,
  );
  result.ok(
    "环境备份: 恢复出的清单与打包时逐字节一致",
    fs.readFileSync(restoredManifest).equals(fs.readFileSync(path.join(profileDir, "package.json"))),
  );
  result.ok(
    "环境备份: 恢复出的插件层条目与原来一致",
    JSON.stringify(readJson(restoredManifest).value?.dsh?.profile?.bundles) === JSON.stringify(readJson(path.join(profileDir, "package.json")).value?.dsh?.profile?.bundles),
  );

  // A skill restore must land inside one of the configured roots, never in the
  // real home: `agentsBase` above is the point of this check.
  const skillTargets = applied.written.filter((entry) => entry.group === "skill").map((entry) => entry.target);
  const skillRoots = [path.join(target, "skills"), path.join(agentsBase, "skills")];
  result.ok(
    "环境备份: 技能只写进指定的根目录",
    skillTargets.every((skillTarget) => skillRoots.some((root) => skillTarget.startsWith(root))),
    skillTargets.join(", ") || "本机 fixture 没有技能",
  );

  // Tampering: a bundle whose bytes no longer match its manifest must be refused
  // rather than written, or a corrupted download would silently win.
  const tampered = path.join(fixture.work, "tampered.zip");
  const bytes = fs.readFileSync(file);
  const at = bytes.indexOf(Buffer.from("dsh-profile-"));
  if (at > 0) {
    bytes.write("XXXXX", at + 11, "utf8");
    fs.writeFileSync(tampered, bytes);
    const badPlan = require("./backup").planRestore(target, tampered, { profileName: FIXTURE_PROFILE, agentsBase });
    result.ok(
      "环境备份: 内容与清单哈希不符的文件被跳过",
      badPlan.warnings.some((warning) => warning.includes("哈希")),
      badPlan.warnings.join(" | "),
    );
  } else {
    result.ok("环境备份: 内容与清单哈希不符的文件被跳过", false, "找不到可篡改的位置（fixture 结构变了）");
  }

  // A bundle is user-supplied input, so it is hostile input. Three shapes are
  // refused; each is asserted because "the restore wrote somewhere it should
  // not have" is unrecoverable after the fact.
  const hostile = path.join(fixture.work, "hostile.zip");
  fs.writeFileSync(
    hostile,
    require("./zip").createZip([
      {
        name: "manifest.json",
        data: JSON.stringify({
          format: "dsh-environment-backup",
          version: 1,
          createdAt: new Date().toISOString(),
          source: { profileName: FIXTURE_PROFILE, home: "elsewhere" },
          includesSecrets: false,
          registryPlugins: [],
          localPlugins: [],
          skills: [],
          files: [
            { group: "profile", source: "escape", entry: "files/home/../../../../escaped.txt" },
            { group: "profile", source: "nm", entry: "files/home/profiles/demo/node_modules/injected.js" },
            { group: "secret", source: "cred", entry: "files/home/.credentials.yaml" },
          ],
          excluded: [],
          notes: [],
        }),
      },
      { name: "files/home/../../../../escaped.txt", data: "x" },
      { name: "files/home/profiles/demo/node_modules/injected.js", data: "x" },
      { name: "files/home/.credentials.yaml", data: "x" },
    ]),
  );
  const hostileHome = path.join(fixture.work, "hostile-home");
  const hostilePlan = require("./backup").planRestore(hostileHome, hostile, { profileName: FIXTURE_PROFILE, agentsBase: agentsBase });
  require("./backup").applyRestore(hostilePlan, { home: hostileHome });
  result.ok(
    "环境备份: 拒绝写到数据目录之外",
    hostilePlan.actions.length === 0 && !fs.existsSync(path.join(fixture.work, "escaped.txt")) && !fs.existsSync(path.join(fixture.work, "..", "escaped.txt")),
    hostilePlan.warnings.join(" | "),
  );
  result.ok(
    "环境备份: 拒绝写进 node_modules",
    !fs.existsSync(path.join(hostileHome, "profiles", FIXTURE_PROFILE, "node_modules", "injected.js")),
  );
  result.ok(
    "环境备份: 声明不含凭据的包不还原凭据",
    !fs.existsSync(path.join(hostileHome, ".credentials.yaml")) &&
      hostilePlan.warnings.some((warning) => warning.includes("凭据")),
    hostilePlan.warnings.join(" | "),
  );

  const deleted = await controller.dispatch("recovery:backup-delete", [file]);
  result.ok("环境备份: 可以删除自己生成的备份", deleted.ok === true && !isFile(file), errorText(deleted));
}

async function verifyAwesome(controller, fixture, result) {
  const check = (options) => controller.dispatch("recovery:awesome-check", [options]);
  const EN = "Verify plugin: adds one row to the settings page.";
  const ZH = "验证插件：在设置页新增一行。";

  const pass = await check({ dir: fixture.pluginRepo, repo: "acme/verify-plugin", descriptionEn: EN, descriptionZh: ZH, category: "ui" });
  const passed = pass.awesome;
  result.ok(
    "收录: 合规仓库生成条目并通过检查",
    pass.ok === true && passed?.fileName === "acme__verify-plugin.yml" && /^url: https:\/\/github\.com\/acme\/verify-plugin$/mu.test(passed?.yaml ?? ""),
    errorText(pass) ?? JSON.stringify(passed?.counts),
  );
  result.ok(
    "收录: 条目按 contributing.md 的字段顺序生成",
    (passed?.yaml ?? "").startsWith("url: ") && /^name: acme\/verify-plugin$/mu.test(passed?.yaml ?? "") && /^category: ui$/mu.test(passed?.yaml ?? ""),
    passed?.yaml,
  );
  result.ok(
    "收录: 冒号后带空格的描述被加引号",
    (() => {
      const single = awesome.renderEntry({
        url: "https://github.com/acme/x",
        name: "acme/x",
        category: "vision",
        description: { en: "Vision toolkit: OCR, grounding and pixel diff." },
      });
      return single.includes("en: 'Vision toolkit: OCR, grounding and pixel diff.'");
    })(),
  );

  const clientOnly = await check({ dir: fixture.clientOnlyRepo, repo: "acme/verify-client-only", descriptionEn: EN });
  result.ok(
    "收录: 只声明 dsh.client 被拒并说明原因",
    clientOnly.ok === false && (clientOnly.awesome?.findings ?? []).some((item) => item.rule === "bundle" && item.level === "fail"),
    errorText(clientOnly) ?? JSON.stringify(clientOnly.awesome?.counts),
  );

  // A missing description is the one required field: no entry is generated, so
  // no YAML can contain the literal text `undefined`. The manifest's own
  // description is offered as a draft instead of a hard failure, because an
  // untyped field is not the same as a wrong description.
  const noDescription = await check({ dir: fixture.pluginRepo, repo: "acme/verify-plugin", category: "ui" });
  const noDescFinding = (noDescription.awesome?.findings ?? []).find((item) => item.rule === "description");
  result.ok(
    "收录: 缺 description.en 时不生成条目，但以 package.json 的描述作为草稿提示",
    noDescription.awesome?.yaml === undefined &&
      noDescription.awesome?.entry === undefined &&
      noDescFinding?.level === "warn" &&
      String(noDescFinding?.detail ?? "").includes("A verify fixture plugin"),
    JSON.stringify({ level: noDescFinding?.level, yaml: noDescription.awesome?.yaml }),
  );

  // Blocking items must be copyable in a form that is self-contained enough for
  // someone else (or an AI) to act on: repo, every rule, and the rule source.
  const blocked = await check({ dir: fixture.clientOnlyRepo, repo: "acme/verify-client-only" });
  const fixes = blocked.awesome?.fixesText;
  result.ok(
    "收录: 必须修正可整理成给 AI 的完整说明",
    blocked.ok === false &&
      typeof fixes?.prompt === "string" &&
      fixes.prompt.includes("仓库目录：") &&
      fixes.prompt.includes("R2") &&
      fixes.prompt.includes("contributing.md") &&
      fixes.prompt.includes("不要手工编辑"),
    JSON.stringify({ hasPrompt: typeof fixes?.prompt, len: fixes?.prompt?.length }),
  );
  result.ok(
    "收录: 问题清单只含必须修正项",
    typeof fixes?.list === "string" && fixes.list.startsWith("必须修正：") && fixes.list.includes("R2"),
    fixes?.list?.slice(0, 120),
  );
  // A passing check has nothing to hand over.
  result.ok(
    "收录: 无必须修正项时说明为空",
    (pass.awesome?.fixesText?.prompt ?? "").includes("以下项目前不通过") &&
      !(pass.awesome?.fixesText?.list ?? "").split("\n").some((line) => line.startsWith("- ")),
    pass.awesome?.fixesText?.list,
  );

  await controller.dispatch("recovery:awesome-set-dir", ["list", fixture.listDir, { persist: false }]);
  const duplicated = await check({ dir: fixture.pluginRepo, repo: "someone/verify-plugin", descriptionEn: EN });
  result.ok(
    "收录: 与已有条目重复时给出提示",
    (duplicated.awesome?.findings ?? []).some((item) => item.rule === "duplicate" && item.level === "warn"),
    JSON.stringify(duplicated.awesome?.findings?.filter((item) => item.rule === "duplicate")),
  );

  const four = await check({ dir: fixture.pluginRepo, repo: "acme/verify-plugin", descriptionEn: EN, countInPr: 4 });
  result.ok(
    "收录: 一个 PR 超过 3 条被拒",
    four.ok === false && (four.awesome?.findings ?? []).some((item) => item.rule === "count" && item.level === "fail"),
    errorText(four),
  );

  // A category is required before an entry file can exist: without one there is
  // nothing to write, so this call supplies it explicitly.
  const updated = await check({ dir: fixture.pluginRepo, repo: "acme/verify-plugin", descriptionEn: EN, category: "ui" });
  const firstWrite = await controller.dispatch("recovery:awesome-write", [{}]);
  const writtenFile = path.join(fixture.listDir, "data", "plugins", "acme__verify-plugin.yml");
  result.ok(
    "收录: 写入条目文件",
    firstWrite.ok === true && isFile(writtenFile) && fs.readFileSync(writtenFile, "utf8") === updated.awesome?.yaml,
    JSON.stringify({
      error: errorText(firstWrite),
      updatedOk: updated.ok,
      updatedVerdict: updated.awesome?.verdict,
      updatedFileName: updated.awesome?.fileName,
      hasYaml: typeof updated.awesome?.yaml,
      configList: controller.config.awesomeListDir,
    }),
  );
  // Writing the same content again is a no-op, not an error.
  const sameAgain = await controller.dispatch("recovery:awesome-write", [{}]);
  result.ok("收录: 相同内容重复写入不报错", sameAgain.ok === true && sameAgain.result?.unchanged === true, errorText(sameAgain));

  // A changed entry over somebody's existing file must be refused unless the
  // caller explicitly opts into updating their own entry.
  await check({ dir: fixture.pluginRepo, repo: "acme/verify-plugin", descriptionEn: "Changed wording for the same plugin.", category: "ui" });
  const conflicting = await controller.dispatch("recovery:awesome-write", [{}]);
  result.ok("收录: 同名但内容不同时拒绝覆盖", conflicting.ok === false, errorText(conflicting));
  const forced = await controller.dispatch("recovery:awesome-write", [{ allowUpdate: true }]);
  result.ok("收录: 明确允许时才更新已有条目", forced.ok === true && forced.result?.updated === true, errorText(forced));

  // The entry belongs to somebody else and must survive untouched — including
  // the write below, which generates `someone__verify-plugin.yml` (the filename
  // this submission maps to) and must not overwrite the legacy-named file.
  result.ok(
    "收录: 不触碰别人的条目",
    fs.readFileSync(path.join(fixture.listDir, "data", "plugins", "someone__verify-plugin-legacy.yml"), "utf8").includes("Another plugin."),
  );

  // Writing needs a real clone: a directory without data/plugins is refused.
  const notAList = await controller.dispatch("recovery:awesome-set-dir", ["list", fixture.pluginRepo, { persist: false }]);
  result.ok("收录: 非列表目录被拒绝", notAList.ok === false, errorText(notAList));
  // ...and the previous selection must not have been clobbered by the refusal.
  result.ok(
    "收录: 拒绝时不改写已选目录",
    controller.config.awesomeListDir === path.resolve(fixture.listDir),
    controller.config.awesomeListDir,
  );
}

async function verifyPluginManagement(controller, fixture, result) {
  const manifestPath = path.join(fixture.profileDir, "package.json");
  const patchPath = path.join(fixture.profileDir, "cordis.patch.yml");
  const bundlesOf = (state) => state.selectedProfileDetail?.bundles ?? [];

  const disabled = await controller.dispatch("recovery:set-bundle-enabled", [FIXTURE_BUNDLE, false]);
  result.ok(
    "插件管理: 禁用组合包",
    disabled.ok === true && !bundlesOf(disabled.state).includes(FIXTURE_BUNDLE),
    errorText(disabled),
  );
  const afterDisable = readJson(manifestPath);
  result.ok(
    "插件管理: 禁用写入 package.json",
    afterDisable.ok === true && !(afterDisable.value?.dsh?.profile?.bundles ?? []).includes(FIXTURE_BUNDLE),
    afterDisable.error,
  );

  const enabled = await controller.dispatch("recovery:set-bundle-enabled", [FIXTURE_BUNDLE, true]);
  result.ok(
    "插件管理: 重新启用组合包",
    enabled.ok === true && bundlesOf(enabled.state).includes(FIXTURE_BUNDLE),
    errorText(enabled),
  );

  const coreGuard = await controller.dispatch("recovery:set-bundle-enabled", [CORE_BUNDLE, false]);
  result.ok(
    "插件管理: 拒绝禁用核心组件",
    coreGuard.ok === false && /不能禁用/u.test(errorText(coreGuard) ?? ""),
    errorText(coreGuard),
  );

  const nonBundle = await controller.dispatch("recovery:set-bundle-enabled", [FIXTURE_DEP, true]);
  result.ok(
    "插件管理: 拒绝启用非组合包",
    nonBundle.ok === false && /不是插件组合包/u.test(errorText(nonBundle) ?? ""),
    errorText(nonBundle),
  );

  const allOff = await controller.dispatch("recovery:set-bundle-enabled", [FIXTURE_BUNDLE, false]);
  // Plant a patch-layer disable: a bundle listed in dsh.profile.bundles would
  // still not load while its id is disabled here, so "enable all" must fix it.
  fs.writeFileSync(
    patchPath,
    `- id: fake-row\n  name: ${FIXTURE_BUNDLE}\n- id: fake-usage\n  disabled: true\n  config:\n    enabled: false\n`,
  );
  const enableAll = await controller.dispatch("recovery:enable-all-bundles", []);
  const skippedNames = (enableAll.result?.bundles?.skipped ?? []).map((item) => item.name);
  const patchAfterAll = fs.readFileSync(patchPath, "utf8");
  result.ok(
    "插件管理: 一键启用全部插件",
    allOff.ok === true &&
      enableAll.ok === true &&
      bundlesOf(enableAll.state).includes(FIXTURE_BUNDLE) &&
      skippedNames.includes(FIXTURE_DEP) &&
      (readJson(manifestPath).value?.dsh?.profile?.bundles ?? []).includes(FIXTURE_BUNDLE) &&
      /- id: fake-row\n  name: fake-bundle\n/u.test(patchAfterAll),
    errorText(enableAll) ?? JSON.stringify(skippedNames),
  );
  result.ok(
    "插件管理: 一键启用同时解除补丁层禁用",
    /- id: fake-usage\n  disabled: false\n  config:\n    enabled: false\n$/u.test(patchAfterAll) &&
      (enableAll.result?.bundles?.patchReenabled ?? []).includes("fake-usage"),
    patchAfterAll,
  );
  const enableAllAgain = await controller.dispatch("recovery:enable-all-bundles", []);
  result.ok(
    "插件管理: 一键启用重复执行无副作用",
    enableAllAgain.ok === true &&
      (enableAllAgain.result?.bundles?.changed ?? true) === false &&
      fs.readFileSync(patchPath, "utf8") === patchAfterAll,
    errorText(enableAllAgain),
  );

  const uninstalled = await controller.dispatch("recovery:uninstall-bundle", [FIXTURE_BUNDLE]);
  const quarantineId = uninstalled.result?.uninstalled?.quarantineId;
  const quarantineDir = typeof quarantineId === "string"
    ? path.join(fixture.profileDir, paths.RECOVERY_STATE_DIR_NAME, "removed", quarantineId)
    : undefined;
  result.ok(
    "插件管理: 卸载移入隔离区",
    uninstalled.ok === true &&
      quarantineDir !== undefined &&
      isFile(path.join(quarantineDir, "meta.json")) &&
      !fs.existsSync(path.join(fixture.profileDir, "node_modules", FIXTURE_BUNDLE)) &&
      (uninstalled.state.selectedProfileDetail?.removed ?? []).some((entry) => entry.id === quarantineId),
    errorText(uninstalled) ?? quarantineId,
  );

  const restored = await controller.dispatch("recovery:restore-removed", [quarantineId]);
  result.ok(
    "插件管理: 从隔离区还原",
    restored.ok === true &&
      isFile(path.join(fixture.profileDir, "node_modules", FIXTURE_BUNDLE, "package.json")) &&
      (restored.state.selectedProfileDetail?.removed ?? []).length === 0,
    errorText(restored),
  );

  const discardedTarget = await controller.dispatch("recovery:uninstall-bundle", [FIXTURE_DEP]);
  const discardId = discardedTarget.result?.uninstalled?.quarantineId;
  const discarded = await controller.dispatch("recovery:discard-removed", [discardId]);
  result.ok(
    "插件管理: 永久删除隔离项",
    discarded.ok === true &&
      !fs.existsSync(path.join(fixture.profileDir, paths.RECOVERY_STATE_DIR_NAME, "removed", String(discardId))),
    errorText(discarded),
  );

  // 插件管理 groups rows by where they came from, and the group decides what
  // the row's "open" button does. The fixture deliberately contains one of
  // each: a registry-style package, a `link:` dependency pointing at a folder
  // outside the profile, and a built-in component.
  const linkedTarget = path.join(fixture.root, "linked-plugin");
  ensureDir(linkedTarget);
  writeJsonAtomic(path.join(linkedTarget, "package.json"), {
    name: FIXTURE_LINKED,
    version: "1.0.0",
    dsh: { bundle: { patch: "./patch.yml" } },
  });
  fs.writeFileSync(path.join(linkedTarget, "patch.yml"), "- insert: []\n");
  const linkPath = path.join(fixture.profileDir, "node_modules", FIXTURE_LINKED);
  removeEntry(linkPath);
  fs.symlinkSync(linkedTarget, linkPath, "junction");
  const linkedManifest = readJson(manifestPath);
  linkedManifest.value.dependencies = { ...linkedManifest.value.dependencies, [FIXTURE_LINKED]: `link:${linkedTarget}` };
  linkedManifest.value.dsh.profile.bundles = [...linkedManifest.value.dsh.profile.bundles, FIXTURE_LINKED];
  writeJsonAtomic(manifestPath, linkedManifest.value);
  await controller.dispatch("recovery:refresh", []);
  const rows = controller.state.selectedProfileDetail?.plugins ?? [];
  const byName = (name) => rows.find((entry) => entry.name === name);
  const linkedRow = byName(FIXTURE_LINKED);
  const registryRow = byName(FIXTURE_BUNDLE);
  const coreRow = byName(CORE_BUNDLE);
  result.ok(
    "插件管理: 按来源分类（本地/联网/内置）",
    linkedRow?.source === "local" &&
      registryRow?.source === "registry" &&
      coreRow?.source === "builtin",
    JSON.stringify({ linked: linkedRow?.source, registry: registryRow?.source, builtin: coreRow?.source }),
  );
  result.ok(
    "插件管理: 本地插件记录真实目录",
    typeof linkedRow?.sourcePath === "string" &&
      linkedRow.sourcePath.toLowerCase() === path.resolve(linkedTarget).toLowerCase() &&
      linkedRow.linked === true,
    linkedRow?.sourcePath,
  );
  result.ok(
    "插件管理: 联网插件解析出主页",
    typeof registryRow?.homepage === "string" && /^https?:\/\//u.test(registryRow.homepage),
    registryRow?.homepage,
  );

  // The open action must dispatch on the source, not on a caller-supplied path:
  // the renderer only ever passes a package name.
  const openLocal = await controller.dispatch("recovery:open-plugin", [FIXTURE_LINKED]);
  result.ok(
    "插件管理: 本地插件的「打开」定位到文件夹",
    openLocal.ok === true && openLocal.result?.kind === "folder" &&
      String(openLocal.result?.opened).toLowerCase() === path.resolve(linkedTarget).toLowerCase(),
    errorText(openLocal) ?? openLocal.result?.opened,
  );
  // The controller the self tests build has `allowShell: false`, so asserting
  // here proves the resolution still happens while nothing is handed to the OS.
  // (Without it, every `--verify` run opened File Explorer windows and left a
  // trail of `verify-<timestamp>` folders on the desktop.)
  result.ok(
    "插件管理: 自检不会真的弹出资源管理器",
    controller.allowShell === false,
    `allowShell=${controller.allowShell}`,
  );
  const openUnknown = await controller.dispatch("recovery:open-plugin", ["not-a-plugin"]);
  result.ok("插件管理: 未知插件名的「打开」被拒绝", openUnknown.ok === false, errorText(openUnknown));
  // A registry package with neither homepage nor repository must fail loudly
  // instead of opening something arbitrary.
  const noHomePath = path.join(fixture.profileDir, "node_modules", FIXTURE_NOHOME);
  ensureDir(noHomePath);
  writeJsonAtomic(path.join(noHomePath, "package.json"), { name: FIXTURE_NOHOME, version: "1.0.0", dsh: { bundle: { patch: "./patch.yml" } } });
  writeJsonAtomic(path.join(noHomePath, "patch.yml"), "- insert: []\n");
  const noHomeManifest = readJson(manifestPath);
  noHomeManifest.value.dependencies = { ...noHomeManifest.value.dependencies, [FIXTURE_NOHOME]: "1.0.0" };
  noHomeManifest.value.dsh.profile.bundles = [...noHomeManifest.value.dsh.profile.bundles, FIXTURE_NOHOME];
  writeJsonAtomic(manifestPath, noHomeManifest.value);
  await controller.dispatch("recovery:refresh", []);
  const noHomeRow = (controller.state.selectedProfileDetail?.plugins ?? []).find((entry) => entry.name === FIXTURE_NOHOME);
  result.ok(
    "插件管理: 没有主页的插件标记为无法打开",
    noHomeRow !== undefined && noHomeRow.source === "registry" && noHomeRow.homepage === undefined,
    JSON.stringify({ source: noHomeRow?.source, homepage: noHomeRow?.homepage }),
  );
  const openNoHome = await controller.dispatch("recovery:open-plugin", [FIXTURE_NOHOME]);
  result.ok(
    "插件管理: 没有主页的插件给出明确错误",
    openNoHome.ok === false && /主页/u.test(errorText(openNoHome) ?? ""),
    errorText(openNoHome),
  );
  removeEntry(noHomePath);
  const noHomeReset = readJson(manifestPath);
  delete noHomeReset.value.dependencies[FIXTURE_NOHOME];
  noHomeReset.value.dsh.profile.bundles = noHomeReset.value.dsh.profile.bundles.filter((name) => name !== FIXTURE_NOHOME);
  writeJsonAtomic(manifestPath, noHomeReset.value);
  // Leave the fixture as the later checks expect it.
  removeEntry(linkPath);
  const resetManifest = readJson(manifestPath);
  delete resetManifest.value.dependencies[FIXTURE_LINKED];
  resetManifest.value.dsh.profile.bundles = resetManifest.value.dsh.profile.bundles.filter((name) => name !== FIXTURE_LINKED);
  writeJsonAtomic(manifestPath, resetManifest.value);
  await controller.dispatch("recovery:refresh", []);
}

async function verifyPluginUpdater(controller, fixture, result) {
  const manifestPath = path.join(fixture.profileDir, "package.json");
  const depsOf = () => readJson(manifestPath).value?.dependencies ?? {};
  const bundlesOf = () => readJson(manifestPath).value?.dsh?.profile?.bundles ?? [];

  // The panel's data must be complete on a healthy profile: it is an update
  // surface first, a repair surface second.
  const { pluginUpdater } = controller.state;
  result.ok(
    "插件更新: 状态可读",
    pluginUpdater?.available === true && Array.isArray(pluginUpdater.rows) && pluginUpdater.rows.some((row) => row.name === FIXTURE_BUNDLE),
    pluginUpdater?.reason,
  );
  result.ok(
    "插件更新: 面板数据带上 pnpm 解析结果",
    pluginUpdater?.pnpm === undefined || typeof pluginUpdater.pnpm.source === "string",
    JSON.stringify(pluginUpdater?.pnpm),
  );

  // --- repair: a stale lock, a dead run record, a dropped bundle row --------
  const lockPath = path.join(fixture.profileDir, "package.json.lock");
  const runPath = path.join(fixture.profileDir, ".plugin-manager", "run.json");
  fs.writeFileSync(lockPath, "999999\n");
  ensureDir(path.dirname(runPath));
  fs.writeFileSync(runPath, JSON.stringify({ pid: 999998, grouped: false }));

  // The #935 shape: a bundle on disk whose row the host dropped on its way to
  // refusing an update. The layer is emptied on purpose — that is the "disabled"
  // state, and repair must leave it alone — then an unbacked row is added, which
  // would stop the next boot from composing and IS repair's business.
  const dropped = readJson(manifestPath);
  dropped.value.dsh.profile.bundles = ["ghost-from-a-failed-install"];
  writeJsonAtomic(manifestPath, dropped.value);

  const preview = await controller.dispatch("recovery:plugin-repair", [true]);
  result.ok(
    "插件更新: 预览修复不写入",
    preview.ok === true &&
      fs.existsSync(lockPath) &&
      (readJson(manifestPath).value?.dsh?.profile?.bundles ?? []).includes("ghost-from-a-failed-install"),
    errorText(preview),
  );

  const repaired = await controller.dispatch("recovery:plugin-repair", [false]);
  const repairedBundles = bundlesOf();
  result.ok(
    "插件更新: 修复清除僵死锁与运行记录",
    repaired.ok === true && !fs.existsSync(lockPath) && !fs.existsSync(runPath),
    errorText(repaired),
  );
  result.ok(
    // This used to assert the opposite ("补回被丢掉的插件层条目"). Leaving a
    // package out of `dsh.profile.bundles` is how a plugin is disabled while
    // staying installed, so 修复插件状态 must not re-enable it — repairing
    // breakage is not the same as overruling a choice.
    "插件更新: 修复不擅自重新启用已禁用的插件",
    !repairedBundles.includes(FIXTURE_BUNDLE),
    JSON.stringify(repairedBundles),
  );
  result.ok(
    "插件更新: 修复删掉指向不存在包的条目",
    !repairedBundles.includes("ghost-from-a-failed-install"),
    JSON.stringify(repairedBundles),
  );
  result.ok(
    "插件更新: 修复不碰安装自带的核心组件",
    (() => {
      const planted = readJson(manifestPath);
      planted.value.dsh.profile.bundles = [CORE_BUNDLE, FIXTURE_BUNDLE];
      writeJsonAtomic(manifestPath, planted.value);
      const outcome = require("./plugin-updater").repair(fixture.profileDir, { installDir: fixture.installDir });
      return outcome.ok === true && bundlesOf().includes(CORE_BUNDLE);
    })(),
    JSON.stringify(bundlesOf()),
  );

  // --- check ---------------------------------------------------------------
  const healthy = await controller.dispatch("recovery:plugin-check", [FIXTURE_BUNDLE]);
  result.ok("插件更新: 校验一致的插件", healthy.ok === true, errorText(healthy) ?? healthy.result?.message);
  const missing = await controller.dispatch("recovery:plugin-check", ["not-installed"]);
  result.ok("插件更新: 校验缺失的插件会失败", missing.ok === false, missing.result?.message);

  // --- update/install/remove are refused while the app runs ----------------
  // The fixture's stub executable is not launched here, so the update path is
  // exercised for its refusal shape only: a name that is not installed must be
  // rejected before pnpm is touched.
  const unavailable = await controller.dispatch("recovery:plugin-update", ["definitely-not-installed"]);
  result.ok(
    "插件更新: 升级未安装的包被拒绝",
    unavailable.ok === false && /没有安装/u.test(errorText(unavailable) ?? ""),
    errorText(unavailable),
  );
  result.ok(
    "插件更新: 拒绝后 profile 未被改动",
    depsOf()[FIXTURE_BUNDLE] === "1.0.0" && !Object.hasOwn(depsOf(), "definitely-not-installed"),
    JSON.stringify(depsOf()),
  );

  const emptySpec = await controller.dispatch("recovery:plugin-install", ["", false]);
  result.ok("插件更新: 空的安装名被拒绝", emptySpec.ok === false, errorText(emptySpec));

  // --- the market itself: install it when absent, update it when present ----
  // The fixture has no market, which is exactly the "installed the app but not
  // the market" shape the panel must offer 「安装插件市场」 for.
  const marketBefore = controller.state.pluginUpdater?.market;
  result.ok(
    "插件更新: 没有市场时报告为未安装",
    marketBefore !== undefined && marketBefore.installed === false && marketBefore.name === "dshmarket",
    JSON.stringify(marketBefore),
  );
  const marketPreview = await controller.dispatch("recovery:plugin-install-market", [true]);
  result.ok(
    "插件更新: 安装市场的预览可用且不写入",
    marketPreview.ok === true && !Object.hasOwn(depsOf(), "dshmarket") && !bundlesOf().includes("dshmarket"),
    errorText(marketPreview) ?? marketPreview.result?.message,
  );

  // A package.json entry whose node_modules copy is gone is the broken-profile
  // shape: it must still count as "not installed", so the panel offers an
  // install (which repairs it) rather than an update that fails.
  const declaredOnly = readJson(manifestPath);
  declaredOnly.value.dependencies.dshmarket = "^1.0.0";
  writeJsonAtomic(manifestPath, declaredOnly.value);
  await controller.dispatch("recovery:refresh", []);
  result.ok(
    "插件更新: 只声明未落盘的市场算作未安装",
    controller.state.pluginUpdater?.market?.installed === false,
    JSON.stringify(controller.state.pluginUpdater?.market),
  );

  // With a real copy on disk the same channel must refuse instead of
  // reinstalling over it, and the panel switches to 「升级到最新」.
  ensureDir(path.join(fixture.profileDir, "node_modules", "dshmarket"));
  writeJsonAtomic(path.join(fixture.profileDir, "node_modules", "dshmarket", "package.json"), {
    name: "dshmarket",
    version: "1.0.0",
    dsh: { bundle: { patch: "./cordis.patch.yml" } },
  });
  fs.writeFileSync(path.join(fixture.profileDir, "node_modules", "dshmarket", "cordis.patch.yml"), "- insert: []\n");
  await controller.dispatch("recovery:refresh", []);
  result.ok(
    "插件更新: 已安装的市场报告为已安装",
    controller.state.pluginUpdater?.market?.installed === true &&
      controller.state.pluginUpdater?.market?.version === "1.0.0",
    JSON.stringify(controller.state.pluginUpdater?.market),
  );
  const marketAgain = await controller.dispatch("recovery:plugin-install-market", [false]);
  result.ok(
    "插件更新: 已安装时拒绝重复安装市场",
    marketAgain.ok === false && /已经安装/u.test(errorText(marketAgain) ?? ""),
    errorText(marketAgain),
  );
  removeEntry(path.join(fixture.profileDir, "node_modules", "dshmarket"));
  const marketReset = readJson(manifestPath);
  delete marketReset.value.dependencies.dshmarket;
  writeJsonAtomic(manifestPath, marketReset.value);
  await controller.dispatch("recovery:refresh", []);
}

/**
 * 插件更新: a stalled pnpm must time out instead of freezing the console.
 *
 * This is the regression guard for "更新插件把软件卡死了". Two facts are
 * asserted, and the second is the one that actually mattered: while the package
 * manager is stuck, the process must keep turning its event loop — the previous
 * `spawnSync` implementation blocked the whole Electron main process.
 */
async function verifyUpdaterStall(controller, fixture, result) {
  const updater = require("./plugin-updater");
  const work = path.join(fixture.root, "stall");
  ensureDir(work);
  writeJsonAtomic(path.join(work, "package.json"), { name: "stall-probe", private: true });

  // A child that never exits, standing in for a pnpm stuck on a registry retry.
  const hanging = {
    command: process.execPath,
    prefix: ["-e", "setTimeout(() => {}, 600000)", "--"],
    env: {},
    node: process.execPath,
    source: "verify",
  };

  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
  }, 50);
  const started = Date.now();
  let error;
  try {
    await updater.__runPnpm(work, hanging, ["--version"], { timeoutMs: 1200 });
  } catch (caught) {
    error = caught;
  } finally {
    clearInterval(timer);
  }
  const elapsed = Date.now() - started;

  result.ok(
    "插件更新: 卡住的 pnpm 会被超时中止",
    error !== undefined && /没有结束/u.test(String(error.message)),
    error === undefined ? "调用意外成功返回" : String(error.message).split("\n")[0],
  );
  result.ok(
    "插件更新: 卡住期间主线程没有被冻结",
    ticks >= 8,
    `事件循环只跑了 ${ticks} 次（${elapsed}ms 内），说明主进程被阻塞`,
  );
  result.ok(
    "插件更新: 中止在超时预算内发生",
    elapsed < 20000,
    `实际用时 ${elapsed}ms`,
  );

  // The panel must also warn before a run that stands a chance of stalling.
  const risks = updater.updateRisks(fixture.profileDir);
  result.ok(
    "插件更新: 面板数据带上更新风险提示",
    Array.isArray(controller.state.pluginUpdater?.risks),
    JSON.stringify(risks),
  );

  // A second mutation while one is in flight must be refused, not interleaved.
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const first = controller.perform("首个操作", async () => {
    await blocked;
    return { message: "first" };
  });
  await Promise.resolve();
  // Dispatch throws for a refused mutation only when called directly; go through
  // the same channel the window uses and assert on the refused result instead.
  let second;
  try {
    second = await controller.perform("第二个操作", async () => ({ message: "second" }));
  } catch (caught) {
    second = { ok: false, error: caught instanceof Error ? caught.message : String(caught) };
  }
  release();
  await first;
  result.ok(
    "插件更新: 并发操作被拒绝而不是同时写同一个 Profile",
    second.ok === false && /还在进行中/u.test(String(second.error ?? "")),
    second.error,
  );
  // The refusal must not leave the controller permanently busy.
  const afterRefusal = await controller.perform("后续操作", async () => ({ message: "after" }));
  result.ok("插件更新: 拒绝后仍可继续操作", afterRefusal.ok === true, afterRefusal.error);

  removeEntry(work);
}

/**
 * 插件更新: origin grouping and repository-URL installs.
 *
 * Two behaviours that are easy to regress and expensive to get wrong:
 *
 *   1. A `link:` plugin must be reported as local, and `update()` must refuse it.
 *      "Upgrading" a linked working copy silently replaces the link with a
 *      registry download, detaching the folder the user edits.
 *   2. A GitHub URL must resolve to the npm package it publishes, and never be
 *      handed to pnpm as a repository spec (which would clone and build).
 */
async function verifyUpdaterOriginAndGithub(controller, fixture, result) {
  const updater = require("./plugin-updater");
  const manifestPath = path.join(fixture.profileDir, "package.json");
  const linkedName = "verify-linked-plugin";
  const linkedTarget = path.join(fixture.root, "linked-working-copy");

  // A real junction, which is what `link:` produces on Windows.
  ensureDir(linkedTarget);
  writeJsonAtomic(path.join(linkedTarget, "package.json"), {
    name: linkedName,
    version: "9.9.9",
    dsh: { bundle: { patch: "./cordis.patch.yml" } },
  });
  fs.writeFileSync(path.join(linkedTarget, "cordis.patch.yml"), "- insert: []\n");
  const linkPath = path.join(fixture.profileDir, "node_modules", linkedName);
  removeEntry(linkPath);
  fs.symlinkSync(linkedTarget, linkPath, "junction");

  const withLink = readJson(manifestPath);
  withLink.value.dependencies[linkedName] = `link:${linkedTarget.replace(/\\\\/gu, "/")}`;
  writeJsonAtomic(manifestPath, withLink.value);
  await controller.dispatch("recovery:refresh", []);

  const rows = controller.state.pluginUpdater?.rows ?? [];
  const linkedRow = rows.find((row) => row.name === linkedName);
  const registryRow = rows.find((row) => row.name === FIXTURE_BUNDLE);
  result.ok(
    "插件更新: link: 插件被识别为本地插件",
    linkedRow?.origin === "local" && registryRow?.origin === "registry",
    JSON.stringify({ linked: linkedRow?.origin, registry: registryRow?.origin }),
  );

  // The backend, not just the panel, must refuse the upgrade.
  let refused;
  try {
    await updater.update(fixture.profileDir, linkedName, { installDir: fixture.installDir });
    refused = undefined;
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error);
  }
  result.ok(
    "插件更新: 本地插件拒绝升级（不会把 link 换成 registry 副本）",
    typeof refused === "string" && /本地插件/u.test(refused),
    refused,
  );
  result.ok(
    "插件更新: 拒绝升级后 link 仍在",
    fs.existsSync(linkPath) && readJson(manifestPath).value.dependencies[linkedName].startsWith("link:"),
    readJson(manifestPath).value.dependencies[linkedName],
  );

  // Clean up so later checks see the original fixture.
  removeEntry(linkPath);
  const withoutLink = readJson(manifestPath);
  delete withoutLink.value.dependencies[linkedName];
  writeJsonAtomic(manifestPath, withoutLink.value);
  await controller.dispatch("recovery:refresh", []);

  // --- repository references ----------------------------------------------
  // Parsing only: the resolution step needs the network, and a self test must
  // not depend on GitHub being reachable.
  const parses = [
    ["https://github.com/dsh-market/dsh-market", { owner: "dsh-market", repo: "dsh-market" }],
    ["github.com/a/b", { owner: "a", repo: "b" }],
    ["git@github.com:a/b.git", { owner: "a", repo: "b" }],
    ["a/b#packages/x", { owner: "a", repo: "b", subpath: "packages/x" }],
  ];
  const parseProblems = [];
  for (const [input, expected] of parses) {
    const got = updater.parseGithubRef(input) ?? {};
    for (const [key, value] of Object.entries(expected)) {
      if (got[key] !== value) parseProblems.push(`${input} → ${key}=${got[key]}，期望 ${value}`);
    }
  }
  result.ok("插件更新: 能解析各种 GitHub 地址写法", parseProblems.length === 0, parseProblems.join("；"));

  // A plain spec and a scoped package must NOT be mistaken for a repository.
  const notRepos = ["dsh-ops", "@scope/name@1.2.3", "dsh-ops/extra"];
  const misread = notRepos.filter((input) => updater.looksLikeGithub(input) === true);
  result.ok("插件更新: 普通包名不会被误当成 GitHub 地址", misread.length === 0, misread.join("；"));

  // An unresolvable repository must fail with an explanation, not a clone.
  const unresolved = await updater.resolveGithubPackage("https://github.com/definitely-not-real-owner-xyz/nope", {
    timeoutMs: 8000,
  });
  result.ok(
    "插件更新: 读不到仓库 package.json 时给出说明",
    unresolved?.error !== undefined && Array.isArray(unresolved.details),
    JSON.stringify(unresolved).slice(0, 200),
  );

  // The install entry point must reject an empty box before touching pnpm.
  let emptyRefused;
  try {
    await updater.installFromInput(fixture.profileDir, "   ", { installDir: fixture.installDir });
  } catch (error) {
    emptyRefused = error instanceof Error ? error.message : String(error);
  }
  result.ok("插件更新: 空的安装输入被拒绝", /请先填入/u.test(String(emptyRefused)), emptyRefused);
}

/**
 * 残留 cookie: the detection, the live-cookie guard, and the backup.
 *
 * Everything runs against a synthetic `%APPDATA%` so the real cookie jar (and
 * the user's login state) is never a test subject. The jar is a real SQLite
 * database built through `node:sqlite`, so the read path — not a stub — is what
 * gets exercised.
 */
async function verifyCookies(controller, fixture, result) {
  const cookies = require("./cookies");
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch (error) {
    result.ok("残留 cookie: 当前运行时支持 node:sqlite", false, error?.message ?? String(error));
    return;
  }

  const appData = path.join(fixture.work, "appdata");
  const network = path.join(appData, "@deepseek-ai", "dsh-desktop", "Network");
  ensureDir(network);
  const jarPath = path.join(network, "Cookies");
  const journalPath = path.join(network, "Cookies-journal");

  // Chromium's epoch: 1601-01-01, microseconds. Future/past on purpose so the
  // expired/valid split is exercised rather than assumed.
  const chromiumMicros = (epochMillis) => String(Math.round((epochMillis / 1000 + 11_644_736_000) * 1_000_000));
  const now = Date.now();

  const db = new DatabaseSync(jarPath);
  db.exec(
    "CREATE TABLE cookies (host_key TEXT NOT NULL, name TEXT NOT NULL, value TEXT, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, encrypted_value BLOB)",
  );
  // Four placeholders for four varying columns; the rest are constants. The
  // statement must name every column it fills or SQLite counts them wrong.
  const insert = db.prepare(
    "INSERT INTO cookies (host_key, name, value, path, expires_utc, is_secure, is_httponly, encrypted_value) VALUES (?, ?, ?, ?, ?, 0, 1, x'00')",
  );
  const put = (host, name, value, pathValue, expires) => insert.run(host, name, value, pathValue, expires);
  // Two stale auth cookies (different ports => different names, same scope) and
  // one live one, plus an unrelated site cookie that must never be touched.
  put("127.0.0.1", "dsh-auth-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "", "/", Number(chromiumMicros(now + 20 * 24 * 3600_000)));
  put("127.0.0.1", "dsh-auth-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", "", "/", Number(chromiumMicros(now - 3600_000)));
  put("127.0.0.1", "dsh-auth-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC", "", "/", Number(chromiumMicros(now + 30 * 24 * 3600_000)));
  put("example.invalid", "session", "keep-me", "/", Number(chromiumMicros(now + 3600_000)));
  db.close();
  fs.writeFileSync(journalPath, "");

  // --- detection and classification ---------------------------------------
  const info = cookies.inspect({ appData, now });
  result.ok(
    "残留 cookie: 能找到 cookie 库并读出条目",
    info.available === true && info.readable === true && info.summary.total === 4,
    info.reason ?? `total=${info.summary?.total}`,
  );
  result.ok(
    "残留 cookie: 只把 dsh-auth-* 当作本缺陷的条目",
    info.summary.auth === 3 && info.summary.other === 1,
    `auth=${info.summary.auth} other=${info.summary.other}`,
  );
  result.ok(
    "残留 cookie: 区分已过期与未过期",
    info.summary.expired === 1,
    `expired=${info.summary.expired}`,
  );

  // A running app must spare its own cookie: deleting it would log the user out
  // mid-session. `liveNames` is how that is expressed.
  const liveName = "dsh-auth-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
  const guarded = cookies.classify(info.jars[0].rows, { now, liveNames: [liveName] });
  result.ok(
    "残留 cookie: 运行中实例自己的 cookie 不会被当成待删条目",
    guarded.auth.find((row) => row.name === liveName)?.live === true &&
      guarded.auth.filter((row) => row.live !== true).length === 2,
    JSON.stringify(guarded.auth.map((row) => ({ name: row.name.slice(0, 16), live: row.live }))),
  );

  // --- preview writes nothing ---------------------------------------------
  const preview = cookies.clear({ appData, dryRun: true });
  result.ok(
    "残留 cookie: 预览只报告、不删除",
    preview.ok === true && preview.cleared.length === 2 && isFile(jarPath) && isFile(journalPath),
    `cleared=${preview.cleared.length} jarExists=${isFile(jarPath)}`,
  );

  // --- clearing backs up first --------------------------------------------
  const backupDir = path.join(fixture.work, "cookie-backups");
  const cleared = cookies.clear({ appData, backupDir });
  result.ok(
    "残留 cookie: 删除 Cookies 与 Cookies-journal",
    cleared.ok === true && !isFile(jarPath) && !isFile(journalPath) && cleared.cleared.length === 2,
    errorText(cleared) ?? `cleared=${cleared.cleared.length}`,
  );
  result.ok(
    "残留 cookie: 删除前留下了备份",
    cleared.backup !== undefined && isFile(cleared.backup.file ?? ""),
    cleared.backup?.file,
  );
  // The backup has to be a usable database, not just a byte count.
  if (cleared.backup !== undefined && isFile(cleared.backup.file)) {
    const restoredInfo = cookies.inspect({ appData: path.join(fixture.work, "restore-check"), now });
    result.ok(
      "残留 cookie: 备份可以被读回（不是空文件）",
      fs.statSync(cleared.backup.file).size > 0 && restoredInfo.available === false,
      `${fs.statSync(cleared.backup.file).size} 字节`,
    );
  }

  // --- restore puts it back ------------------------------------------------
  if (cleared.backup !== undefined) {
    const restored = cookies.restore({ backupFile: cleared.backup.file, appData });
    const afterRestore = cookies.inspect({ appData, now });
    result.ok(
      "残留 cookie: 可以从备份恢复",
      restored.ok === true && afterRestore.readable === true && afterRestore.summary.total === 4,
      errorText(restored) ?? `total=${afterRestore.summary?.total}`,
    );
  }

  // --- refusals ------------------------------------------------------------
  const missing = cookies.restore({ backupFile: path.join(fixture.work, "nope.db"), appData });
  result.ok("残留 cookie: 恢复不存在的备份会被拒绝", missing.ok === false, missing.error);

  const emptyDir = path.join(fixture.work, "no-appdata");
  const nothing = cookies.clear({ appData: emptyDir, backupDir });
  result.ok(
    "残留 cookie: 没有 cookie 库时清理是安全的空操作",
    nothing.ok === true && nothing.cleared.length === 0,
    errorText(nothing),
  );

  // A locked jar must be reported, not half-deleted. Simulating the lock is not
  // portable, so what is asserted here is the contract: a jar that cannot be
  // copied yields `ok: false` with a readable reason instead of throwing.
  const unwritable = path.join(fixture.work, "locked-appdata");
  const lockedNetwork = path.join(unwritable, "@deepseek-ai", "dsh-desktop", "Network");
  ensureDir(lockedNetwork);
  fs.writeFileSync(path.join(lockedNetwork, "Cookies"), "not a database at all");
  const broken = cookies.inspect({ appData: unwritable, now });
  result.ok(
    "残留 cookie: 损坏的 cookie 库被报告而不是抛异常",
    broken.available === true && broken.readable === false && typeof broken.jars[0].reason === "string",
    broken.jars?.[0]?.reason,
  );

  // --- the controller wiring ----------------------------------------------
  // Two things must hold no matter the machine: the card's data is present in
  // the console state, and clearing is refused while the app runs.
  await controller.dispatch("recovery:refresh", []);
  result.ok(
    "残留 cookie: 控制台状态里有这一节",
    controller.state.cookies !== undefined && typeof controller.state.cookies.summary === "object",
    controller.state.cookies?.reason,
  );
  result.ok(
    "残留 cookie: 状态里带上备份目录",
    typeof controller.state.cookies?.backupDir === "string" && controller.state.cookies.backupDir.includes("cookie-backups"),
    controller.state.cookies?.backupDir,
  );

  // The idle guard is the whole safety story for the delete: with the app up the
  // file is locked, and the console must say so instead of trying.
  const wasRunning = controller.state.running?.isRunning === true;
  if (!wasRunning) {
    // Pretend it is running, without touching the real process table.
    const saved = controller.state.running;
    controller.state.running = { ...saved, isRunning: true, pids: [999999] };
    const refused = await controller.dispatch("recovery:cookies-clear", [{ dryRun: false }]);
    controller.state.running = saved;
    result.ok(
      "残留 cookie: 应用运行中拒绝清理",
      refused.ok === false && /正在运行|先停止/u.test(String(refused.error ?? refused.result?.error ?? "")),
      refused.error ?? refused.result?.error,
    );
    result.ok(
      "残留 cookie: 拒绝后真实 cookie 库没有被改动",
      isFile(path.join(network, "Cookies")),
      jarPath,
    );
  }
}

/**
 * 插件更新检测 + 一键升级 + 恢复器自身更新.
 *
 * Everything here works against a throwaway git repo and a fake registry, so the
 * suite stays offline and never pulls the real project out from under itself.
 */
async function verifyPluginVersionsAndSelfUpdate(controller, fixture, result) {
  const registry = require("./registry");
  const selfUpdate = require("./self-update");
  const { spawnSync } = require("node:child_process");

  // --- semver comparison ---------------------------------------------------
  // String comparison gets 1.10 vs 1.9 wrong, and that is the one mistake that
  // would make the panel claim an upgrade exists (or hide one) forever.
  result.ok(
    "插件更新检测: 版本比较按数字而不是字符串",
    registry.compareVersions("1.10.0", "1.9.0") === 1 && registry.compareVersions("1.9.0", "1.10.0") === -1,
    JSON.stringify({ a: registry.compareVersions("1.10.0", "1.9.0"), b: registry.compareVersions("1.9.0", "1.10.0") }),
  );
  result.ok(
    "插件更新检测: 预发布版低于同号正式版",
    registry.compareVersions("1.2.0-rc.1", "1.2.0") === -1 && registry.compareVersions("1.2.0", "1.2.0-rc.1") === 1,
    JSON.stringify({ rc: registry.compareVersions("1.2.0-rc.1", "1.2.0") }),
  );
  result.ok(
    "插件更新检测: 相同版本相等",
    registry.compareVersions("1.73.17", "1.73.17") === 0 && registry.compareVersions("v1.73.17", "1.73.17") === 0,
  );

  // --- scoped package names ------------------------------------------------
  // `@scope/name` in a URL must be `@scope%2Fname`; an unencoded slash returns a
  // 404 that reads like "this package does not exist".
  result.ok(
    "插件更新检测: scope 包名做了 URL 编码",
    registry.encodePackageName("@scope/name") === "@scope%2Fname" && registry.encodePackageName("plain") === "plain",
    registry.encodePackageName("@scope/name"),
  );

  // --- a failed lookup must not read as "up to date" -----------------------
  const impossible = await registry.checkVersions([{ name: "dsh-recovery-verify-no-such-package-xyz", version: "1.0.0" }]);
  const failedRow = impossible.rows?.[0] ?? {};
  result.ok(
    "插件更新检测: 查不到的包单独报告，不算作最新",
    impossible.checked === 1 &&
      failedRow.ok === false &&
      failedRow.outdated !== true &&
      impossible.outdated.length === 0 &&
      impossible.failed.length === 1,
    JSON.stringify({ ok: failedRow.ok, outdated: failedRow.outdated, failed: impossible.failed.length }),
  );

  // --- a cached scan must not survive a version change ---------------------
  //
  // The regression: after 「一键升级」 the panel kept advertising the upgrade it
  // had just applied, and 「一键升级（N）」 kept counting plugins that were
  // already current. The scan result is cached (it needs the network), so every
  // path that re-reads the profile has to drop it.
  controller.lastPluginVersions = {
    registry: "https://registry.example.invalid",
    checked: 1,
    rows: [{ name: "placeholder", installed: "1.0.0", latest: "1.1.0", ok: true, outdated: true }],
    outdated: [{ name: "placeholder", installed: "1.0.0", latest: "1.1.0" }],
    failed: [],
    hasUpdates: true,
    checkedAt: new Date().toISOString(),
  };
  result.ok(
    "插件更新检测: refresh 前缓存里有待升级项",
    (controller.pluginVersionsSummary().outdated ?? []).length === 1,
    String((controller.pluginVersionsSummary().outdated ?? []).length),
  );
  await controller.refresh({ sizes: false });
  result.ok(
    "插件更新检测: refresh 让缓存失效（升级后不再显示可升级）",
    controller.pluginVersionsSummary().checkedAt === undefined &&
      (controller.pluginVersionsSummary().outdated ?? []).length === 0,
    JSON.stringify({ checkedAt: controller.pluginVersionsSummary().checkedAt, outdated: controller.pluginVersionsSummary().outdated.length }),
  );

  // --- registry from .npmrc ------------------------------------------------
  const npmrcDir = path.join(fixture.work, "npmrc-profile");
  ensureDir(npmrcDir);
  fs.writeFileSync(path.join(npmrcDir, ".npmrc"), "# comment\nregistry=https://mirror.example.invalid/npm/\n");
  result.ok(
    "插件更新检测: 尊重 Profile 的 .npmrc registry",
    registry.registryFor(npmrcDir) === "https://mirror.example.invalid/npm",
    registry.registryFor(npmrcDir),
  );
  result.ok(
    "插件更新检测: 没有 .npmrc 时回落到官方 registry",
    registry.registryFor(path.join(fixture.work, "no-npmrc-here")) === registry.DEFAULT_REGISTRY,
    registry.registryFor(path.join(fixture.work, "no-npmrc-here")),
  );

  // --- 一键升级: one failure must not stop the batch -----------------------
  // The batch runs against a fake profile whose `pnpm` is a stub, so this asserts
  // the ORCHESTRATION (per-package outcomes, local skipped, nothing thrown) rather
  // than pnpm itself.
  const updater = require("./plugin-updater");
  const batchDir = path.join(fixture.work, "batch-profile");
  ensureDir(batchDir);
  fs.writeFileSync(
    path.join(batchDir, "package.json"),
    JSON.stringify(
      {
        name: "batch-profile",
        dependencies: { "registry-a": "1.0.0", "registry-b": "1.0.0", "local-c": `link:${batchDir}` },
        dsh: { profile: { bundles: ["registry-a", "registry-b", "local-c"] } },
      },
      undefined,
      2,
    ),
  );
  for (const name of ["registry-a", "registry-b", "local-c"]) {
    const dir = path.join(batchDir, "node_modules", name);
    ensureDir(dir);
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name, version: "1.0.0", main: "index.js", dsh: { bundle: { patch: "./patch.yml" } } }, undefined, 2),
    );
    fs.writeFileSync(path.join(dir, "index.js"), "module.exports = {};\n");
    fs.writeFileSync(path.join(dir, "patch.yml"), "- insert: []\n");
  }
  const batch = await updater.updateMany(batchDir, ["registry-a", "local-c", "not-installed-d"], {
    installDir: fixture.installDir,
  });
  const byName = new Map((batch.results ?? []).map((entry) => [entry.name, entry]));
  result.ok(
    "一键升级: 本地插件被跳过而不是升级",
    byName.get("local-c")?.skipped === true && /本地插件/u.test(String(byName.get("local-c")?.reason ?? "")),
    JSON.stringify(byName.get("local-c")),
  );
  result.ok(
    "一键升级: 未安装的包被跳过",
    byName.get("not-installed-d")?.skipped === true,
    JSON.stringify(byName.get("not-installed-d")),
  );
  result.ok(
    "一键升级: 一个包失败不影响其余包的处理（每个都有独立结果）",
    batch.results.length === 3 && typeof batch.message === "string",
    `results=${batch.results.length} message=${batch.message}`,
  );
  result.ok(
    "一键升级: 汇总里带上成功/失败/跳过计数",
    Number.isFinite(batch.updated) && Number.isFinite(batch.failed) && Number.isFinite(batch.skipped),
    JSON.stringify({ updated: batch.updated, failed: batch.failed, skipped: batch.skipped }),
  );

  // --- 自身更新: a dirty tree must be refused ------------------------------
  const repoDir = path.join(fixture.work, "self-update-repo");
  // A bare `spawnSync` with no timeout can leave a git child holding the fixture
  // directory, which then fails the cleanup at the end of the run with EPERM.
  const git = (...args) =>
    spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf8", windowsHide: true, timeout: 60_000 });
  ensureDir(path.join(repoDir, "app"));
  fs.writeFileSync(path.join(repoDir, "app", "package.json"), JSON.stringify({ name: "dsh-recovery", version: "1.0.0" }, undefined, 2));
  fs.writeFileSync(path.join(repoDir, "README.md"), "# fixture\n");
  git("init", "-q");
  git("config", "user.email", "verify@example.invalid");
  git("config", "user.name", "verify");
  git("add", "-A");
  git("commit", "-q", "-m", "initial");

  const inspectResult = selfUpdate.inspect({ root: repoDir });
  result.ok(
    "自身更新: 认出这是一份 git 工作副本",
    inspectResult.available === true && inspectResult.version === "1.0.0",
    JSON.stringify({ available: inspectResult.available, version: inspectResult.version }),
  );
  // The README the panel needs to explain a non-updatable copy.
  const bareDir = path.join(fixture.work, "not-a-repo");
  ensureDir(bareDir);
  const bareInspect = selfUpdate.inspect({ root: bareDir });
  result.ok(
    "自身更新: 没有 .git 的副本明确报告不能自动更新",
    bareInspect.available === false && typeof bareInspect.reason === "string" && bareInspect.reason.length > 0,
    bareInspect.reason,
  );

  // A dirty working tree is the case that must refuse BEFORE touching anything:
  // `merge --ff-only` on top of local edits is how a user loses work.
  fs.writeFileSync(path.join(repoDir, "README.md"), "# fixture (locally modified)\n");
  const dirtyStatus = git("status", "--porcelain");
  result.ok(
    "自身更新: 能检测到工作区有未提交改动",
    dirtyStatus.status === 0 && dirtyStatus.stdout.trim() !== "",
    dirtyStatus.stdout.trim(),
  );
  const dirtyCheck = await selfUpdate.check({ root: repoDir });
  // No origin is configured in the fixture, so `check` reports that explicitly
  // instead of pretending the copy is current.
  result.ok(
    "自身更新: 没有远端时明确报告而不是假装已是最新",
    dirtyCheck.ok === false && typeof dirtyCheck.error === "string",
    dirtyCheck.error,
  );

}

async function verifyCheckpoints(controller, fixture, result) {
  const manifestPath = path.join(fixture.profileDir, "package.json");
  const patchPath = path.join(fixture.profileDir, "cordis.patch.yml");

  const created = await controller.dispatch("recovery:create-checkpoint", ["verify"]);
  const id = created.result?.checkpoint?.id;
  const listed = (created.state?.checkpoints ?? []).find((entry) => entry.id === id);
  result.ok(
    "回滚: 创建检查点",
    created.ok === true && typeof id === "string" && listed !== undefined && listed.metaValid === true && listed.files.length >= 2,
    errorText(created) ?? JSON.stringify(listed?.files),
  );

  const manifestBefore = snapshotFile(manifestPath);
  const patchBefore = snapshotFile(patchPath);
  fs.writeFileSync(patchPath, "- id: broken-by-verify\n  disabled: true\n");
  const mutated = readJson(manifestPath);
  if (mutated.ok) {
    mutated.value.dsh = { profile: { bundles: [] } };
    writeJsonAtomic(manifestPath, mutated.value);
  }
  result.ok(
    "回滚: 检查点确实早于损坏状态",
    !snapshotFile(patchPath).bytes.equals(patchBefore.bytes) && !snapshotFile(manifestPath).bytes.equals(manifestBefore.bytes),
  );

  const restored = await controller.dispatch("recovery:restore-checkpoint", [id]);
  result.ok("回滚: 恢复检查点", restored.ok === true, errorText(restored));
  result.ok("回滚: 补丁文件被还原", unchanged(patchPath, patchBefore));
  result.ok("回滚: 插件清单被还原", unchanged(manifestPath, manifestBefore));
  const preRestoreId = restored.result?.restore?.preRestoreId;
  result.ok(
    "回滚: 恢复前自动保存现场",
    typeof preRestoreId === "string" && (restored.state?.checkpoints ?? []).some((entry) => entry.id === preRestoreId && entry.trigger === "pre-restore"),
    preRestoreId,
  );

  const deleted = await controller.dispatch("recovery:delete-checkpoint", [id]);
  result.ok(
    "回滚: 删除检查点",
    deleted.ok === true && (deleted.state?.checkpoints ?? []).every((entry) => entry.id !== id),
    errorText(deleted),
  );

  // The pre-restore snapshot plus the auto checkpoints above leave several
  // slots behind, so the sweep has something real to clear.
  const beforeSweep = deleted.state?.checkpoints ?? [];
  const checkpointRoot = controller.state.checkpointRoot;
  const sweep = await controller.dispatch("recovery:delete-all-checkpoints", []);
  const leftOver = Array.isArray(sweep.result?.deleted?.failed) ? sweep.result.deleted.failed.length : -1;
  result.ok(
    "回滚: 一键删除全部检查点",
    sweep.ok === true &&
      beforeSweep.length >= 2 &&
      leftOver === 0 &&
      (sweep.state?.checkpoints ?? []).length === 0 &&
      checkpoints.listCheckpoints(controller.state.home.path).length === 0,
    errorText(sweep) ?? `${beforeSweep.length} → ${(sweep.state?.checkpoints ?? []).length}`,
  );

  const emptySweep = await controller.dispatch("recovery:delete-all-checkpoints", []);
  result.ok(
    "回滚: 一键删除空列表不报错",
    emptySweep.ok === true && emptySweep.result?.deleted?.removed?.length === 0,
    errorText(emptySweep) ?? JSON.stringify(emptySweep.result?.message),
  );
  result.ok(
    "回滚: 删除后检查点目录仍可用",
    fs.existsSync(checkpointRoot) && checkpoints.listCheckpoints(controller.state.home.path).length === 0,
    checkpointRoot,
  );
}

async function verifyTargets(controller, fixture, result) {
  // Manually pointing the console at an install that auto-detection missed.
  // Nothing here persists: the real config file must stay byte-identical.
  const configBefore = { ...controller.config };
  const adopt = async (dir) => {
    const outcome = controller.adoptTarget(dir, { persist: false });
    if (outcome.ok === true) await controller.refresh({ sizes: false });
    return outcome;
  };

  try {
    const byDir = await adopt(fixture.installDir);
    result.ok(
      "目标: 手动指定安装目录",
      byDir.ok === true &&
        controller.state.selected?.dir === fixture.installDir &&
        String(controller.state.selected?.exe).endsWith("verify-stub.exe"),
      byDir.ok === true ? controller.state.selected.exe : byDir.error,
    );
    result.ok(
      "目标: 手动指定的安装被标记为手动",
      byDir.ok === true && controller.state.targets.some((target) => target.manual === true && target.dir === fixture.installDir),
      byDir.ok === true ? JSON.stringify(controller.state.targets.map((target) => `${target.id}:${target.manual === true}`)) : byDir.error,
    );

    const byResources = await adopt(path.join(fixture.installDir, "resources"));
    result.ok(
      "目标: 从 resources 子目录反推安装目录",
      byResources.ok === true && controller.state.selected?.dir === fixture.installDir,
      byResources.ok === true ? byResources.result.target.dir : byResources.error,
    );

    const byExe = await adopt(path.join(fixture.installDir, "verify-stub.exe"));
    result.ok(
      "目标: 从主程序路径反推安装目录",
      byExe.ok === true && controller.state.selected?.dir === fixture.installDir,
      byExe.ok === true ? byExe.result.target.dir : byExe.error,
    );

    // The IPC surface has to reject junk without writing anything.
    const rejected = await controller.dispatch("recovery:adopt-target", [fixture.work]);
    result.ok(
      "目标: 拒绝无效目录",
      rejected.ok === false && /不是有效的安装位置/u.test(errorText(rejected) ?? ""),
      errorText(rejected),
    );

    const empty = await controller.dispatch("recovery:adopt-target", ["   "]);
    result.ok("目标: 拒绝空路径", empty.ok === false && /没有选择安装位置/u.test(errorText(empty) ?? ""), errorText(empty));

    const adoptedId = byDir.ok === true ? byDir.result.target.id : "install";
    const forgotten = await controller.forgetTarget(adoptedId, { persist: false });
    result.ok(
      "目标: 移除手动指定的安装",
      forgotten.ok === true && !(controller.config.targets ?? []).some((entry) => entry.id === adoptedId),
      errorText(forgotten) ?? forgotten.result?.message,
    );
    const forgetMissing = await controller.forgetTarget(adoptedId, { persist: false });
    result.ok(
      "目标: 移除不存在的安装会报错",
      forgetMissing.ok === false && /没有手动指定的应用/u.test(errorText(forgetMissing) ?? ""),
      errorText(forgetMissing),
    );
  } finally {
    controller.config = configBefore;
    await controller.refresh({ sizes: false });
  }
}

async function verifyLaunch(controller, fixture, result, archive) {
  const target = controller.state.selected;
  const marker = path.join(fixture.work, "env.txt");

  // Safe mode = "run the app against a throwaway home". Prove both halves: the
  // temporary home really is handed to the child process, and the child really
  // starts.
  //
  // The stub is cmd.exe, so the child reports what it can: `set DSH_` dumps the
  // environment it was started with into a file. The redirection target stays
  // relative on purpose - cmd.exe cannot be handed an absolute path into a
  // directory whose name contains a space through Node's spawn argument
  // quoting, and the fixture lives under a "DeepSeek Harness" directory.
  const safeHome = launcher.prepareSafeModeHome();
  result.ok("启动: 安全模式临时目录位于 .safemode", safeHome.startsWith(launcher.safeModeRoot()), safeHome);
  const spawned = launcher.launch(target, {
    args: ["/c", "set DSH_>env.txt"],
    env: { DSH_HOME: safeHome },
    cwd: fixture.work,
  });
  const wrote = await waitFor(() => isFile(marker), 5000);
  const markerValue = wrote ? fs.readFileSync(marker, "utf8").trim() : "";
  result.ok("启动: 进程真的被拉起", Number.isFinite(spawned.pid) && wrote, `pid=${spawned.pid} ${markerValue.replace(/\s+/gu, " ")}`);
  result.ok("启动: 安全模式数据目录传给子进程", markerValue.includes(`DSH_HOME=${safeHome}`), markerValue.replace(/\s+/gu, " "));

  const launchChannel = await controller.dispatch("recovery:launch", [{ mode: "safe" }]);
  result.ok(
    "启动: 安全模式通道返回临时目录",
    launchChannel.ok === true && typeof launchChannel.result?.launch?.safeHome === "string",
    errorText(launchChannel),
  );

  // Stop: the console must find this instance by exact executable path and
  // force-kill it when it does not close itself.
  const sleeper = launcher.launch(target, { args: ["/c", "ping -n 30 127.0.0.1 >nul"], cwd: fixture.work });
  await sleep(800);
  const stopped = await launcher.stop(target, { timeoutMs: 1500 });
  result.ok(
    "停止: 按可执行文件精确匹配并结束进程",
    stopped.wasRunning === true && stopped.stopped.includes(sleeper.pid) && stopped.alive.length === 0,
    JSON.stringify(stopped),
  );

  const stopChannel = await controller.dispatch("recovery:stop", []);
  result.ok(
    "停止: 未运行时安全返回",
    stopChannel.ok === true && stopChannel.result?.message === "应用当前未运行",
    errorText(stopChannel) ?? stopChannel.result?.message,
  );

  // The console itself must not have touched the real installation. This is the
  // hard constraint of the whole project: the official app.asar must be
  // byte-identical after every action this run exercised.
  if (archive.problem !== undefined) {
    result.fail("安装目录: 未找到官方 app.asar 用于不变性检查", `${archive.problem}；targets=${controller.state.targets.map((entry) => `${entry.kind}@${entry.dir}`).join(", ")}`);
  } else {
    const after = withoutAsar(() => ({ size: fs.statSync(archive.file).size, sha256: hashFileSync(archive.file) }));
    result.ok(
      "安装目录: 官方 app.asar 字节未被本次验证改动",
      after.size === archive.size && after.sha256 === archive.sha256,
      `${archive.file} size=${after.size} sha256=${after.sha256.slice(0, 16)}…`,
    );
  }
}

async function runVerify({ version, targets }) {
  const result = report();
  const startedAt = Date.now();
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-").slice(0, 19);
  const root = path.join(paths.PROJECT_ROOT, ".runtime", `verify-${stamp}`);
  const configFile = paths.configPath();
  const configBefore = snapshotFile(configFile);
  const archive = await realArchive(targets, stamp);
  const fixture = buildFixture(root);
  let safeHome;
  let diagnosticsFile;

  const { RecoveryController } = require("./ipc");
  try {
    // `allowShell: false` keeps every 打开 assertion from actually launching
    // File Explorer. The actions still resolve and return their target, which is
    // what these checks assert; only the OS hand-off is skipped.
    const controller = new RecoveryController({ version, allowShell: false });
    // Point the controller at the fixture in memory only: nothing is persisted,
    // so the real config file keeps whatever the user selected.
    controller.config = {
      ...controller.config,
      dshHome: fixture.home,
      profileName: FIXTURE_PROFILE,
      targetId: "verify-fixture",
      maxCheckpoints: 20,
      targets: [{ id: "verify-fixture", label: "Verify Fixture", dir: fixture.installDir }],
    };
    await controller.refresh({ sizes: true });

    const state = controller.state;
    result.ok("目标: 解析到 fixture 安装目录", state.selected?.id === "verify-fixture", state.selected?.exe);
    result.ok("运行状态: fixture 未被判定为运行中", state.running.isRunning === false);
    result.ok("数据目录: 使用 fixture home", state.home.path === fixture.home, state.home.path);
    result.ok(
      "Profile: 清单与补丁均可解析",
      state.selectedProfileDetail?.manifestError === undefined &&
        state.selectedProfileDetail?.patchError === undefined &&
        state.selectedProfileDetail?.bundles.includes(FIXTURE_BUNDLE) === true,
      state.selectedProfileDetail?.manifestError ?? state.selectedProfileDetail?.patchError,
    );

    await verifyPluginManagement(controller, fixture, result);
    await verifyPluginUpdater(controller, fixture, result);
    await verifyUpdaterStall(controller, fixture, result);
    await verifyUpdaterOriginAndGithub(controller, fixture, result);
    await verifyBackup(controller, fixture, result);
    await verifyCookies(controller, fixture, result);
    await verifyPluginVersionsAndSelfUpdate(controller, fixture, result);
    await verifyAwesome(controller, fixture, result);
    await verifyRestartButton(fixture, result);
    await verifyCheckpoints(controller, fixture, result);
    await verifyTargets(controller, fixture, result);
    await verifyLaunch(controller, fixture, result, archive);

    const exported = await controller.dispatch("recovery:export-diagnostics", []);
    diagnosticsFile = exported.result?.diagnostics?.file;
    result.ok(
      "诊断: 生成诊断包",
      exported.ok === true &&
        isFile(exported.result?.diagnostics?.file ?? "") &&
        Number.isFinite(exported.result?.diagnostics?.entryCount),
      errorText(exported) ?? exported.result?.diagnostics?.name,
    );

    result.ok("不变性: 控制台配置未被改写", unchanged(configFile, configBefore), configFile);
    safeHome = controller.state.safeModeHomes[0]?.dir;
  } catch (error) {
    result.fail("verify: 未捕获异常", error instanceof Error ? `${error.message}` : String(error));
  } finally {
    // Windows releases a directory handle a moment after the process exits, so a
    // single `rm` right after a `git` child finished can fail with EPERM even
    // though nothing is still using it. The wait has to be generous: `spawnSync`
    // returns when the child *exits*, not when Windows finished tearing down its
    // handles, and this fixture has had dozens of git children. Retry before
    // reporting, and treat a leftover fixture as noise rather than a failure —
    // the assertions already ran.
    let cleanupError;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        removeEntry(root);
        cleanupError = undefined;
        break;
      } catch (error) {
        cleanupError = error;
        await new Promise((resolve) => setTimeout(resolve, 150 + 100 * attempt));
      }
    }
    if (cleanupError !== undefined) {
      // Not `result.fail`: a directory left behind is not a failed assertion, and
      // failing here reported "147 项检查失败" for a cleanup race that says
      // nothing about the code under test. It goes to stderr for the same reason
      // the console prints diagnostics there — visible, but not a verdict.
      process.stderr.write(
        `verify: fixture 目录没能完全删除（${cleanupError.message}），可手动删除 ${root}\n`,
      );
    }
    for (const entry of launcher.listSafeModeHomes()) {
      // Only remove the throwaway homes this run created.
      if (entry.id >= stamp.replace(/[:.]/gu, "-")) {
        try {
          removeEntry(entry.dir);
        } catch {}
      }
    }
    // The diagnostics package describes the fixture, so it is a throwaway too.
    if (diagnosticsFile !== undefined) {
      try {
        removeEntry(diagnosticsFile);
      } catch {}
    }
  }

  return {
    root: { cleaned: !isDirectory(root), safeHome },
    checks: result.checks,
    passed: result.passed,
    failed: result.failed,
  };
}

/**
 * Builds a miniature `.asar` archive with the same pickle layout the real one
 * uses, so the restart-button patcher can be exercised without touching the
 * 208 MB official archive.
 *
 * Layout, verified against the installed `resources\app.asar`:
 *   u32 @0  4                 pickle version
 *   u32 @4  headerBufSize     json length + padding + 8
 *   u32 @8  headerBufSize - 4 the same value, minus its own length field
 *   u32 @12 jsonLength        exact JSON byte count
 *   @16     JSON              then padding up to `jsonLength + pad`
 *   @8+headerBufSize          file data, addressed by `offset`
 */
function buildTinyAsar(entries) {
  const json = { files: {} };
  let cursor = 0;
  const bodies = [];
  for (const [entryPath, text] of Object.entries(entries)) {
    const buf = Buffer.from(text, "utf8");
    const parts = entryPath.split("/");
    let node = json;
    for (const part of parts.slice(0, -1)) {
      node.files[part] ??= { files: {} };
      node = node.files[part];
    }
    node.files[parts.at(-1)] = {
      size: buf.length,
      offset: String(cursor),
      integrity: { algorithm: "SHA256", hash: createHash("sha256").update(buf).digest("hex"), blockSize: 4194304, blocks: [] },
    };
    bodies.push(buf);
    cursor += buf.length;
  }
  const jsonBuf = Buffer.from(JSON.stringify(json), "utf8");
  const pad = (4 - (jsonBuf.length % 4)) % 4;
  const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0);
  // `readHeader` computes `dataOffset = 8 + headerBufSize`, and the JSON starts
  // at 16, so headerBufSize must cover the 8 header bytes it already spans:
  // json + pad + 8. Writing `+ 4` here shifted every offset by four bytes and
  // the archive read back as corrupt JSON.
  head.writeUInt32LE(jsonBuf.length + pad + 8, 4);
  head.writeUInt32LE(jsonBuf.length + pad + 4, 8);
  head.writeUInt32LE(jsonBuf.length, 12);
  return Buffer.concat([head, jsonBuf, Buffer.alloc(pad), ...bodies]);
}

/**
 * The restart-button patch installs by rewriting two archive entries with bytes
 * of exactly their original length, and a DeepSeek Harness update replaces the
 * whole `app.asar` — which silently reverts it. That second half is what this
 * covers: the payload must be rebuilt for the installed build, and a backup left
 * over from the previous build must never be presented as restorable.
 */
async function verifyRestartButton(fixture, result) {
  const patchPath = path.join(__dirname, "..", "..", "restart-button", "lib", "patch.cjs");
  if (!isFile(patchPath)) {
    result.fail("重启按钮: 补丁工具存在", patchPath);
    return;
  }
  const patch = require(patchPath);
  const dir = path.join(fixture.root, "restart-button");
  const archive = path.join(dir, "app.asar");
  const backupDir = path.join(dir, "backup");
  const stateFile = path.join(dir, "state.json");
  const payloadDir = path.join(dir, "payload");
  ensureDir(payloadDir);

  // Derived by substitution, so the two payloads are equal length by
  // construction rather than by two hand-counted strings that drift apart.
  const ORIGINAL = "// original build\nconst menu = [0];\n";
  const PATCHED = ORIGINAL.replace("[0]", "[1]");
  if (Buffer.byteLength(ORIGINAL) !== Buffer.byteLength(PATCHED)) {
    result.fail("重启按钮: fixture 载荷等长", `${Buffer.byteLength(ORIGINAL)} vs ${Buffer.byteLength(PATCHED)}`);
    return;
  }
  // Same length as the originals, so the patcher accepts them; the content is
  // irrelevant to the layout logic under test.
  fs.writeFileSync(path.join(payloadDir, "main.js"), PATCHED);
  fs.writeFileSync(path.join(payloadDir, "preload-app.cjs"), PATCHED);
  // Electron's patched `fs` treats any `*.asar` path as a virtual directory and
  // throws "Invalid package" on a raw read or write, so every direct access to
  // the archive file below goes through these wrappers.
  const WRITE_RAW = (file, buf) => withoutAsar(() => fs.writeFileSync(file, buf));
  const READ_RAW = (file) => withoutAsar(() => fs.readFileSync(file));
  const SIZE_RAW = (file) => withoutAsar(() => fs.statSync(file).size);
  const tinyArchive = () => buildTinyAsar({ "lib/main.js": ORIGINAL, "lib/preload-app.cjs": ORIGINAL });
  WRITE_RAW(archive, tinyArchive());
  const options = { archive, backupDir, stateFile, payloadDir, log: () => {} };

  const initial = patch.status(options);
  result.ok(
    "重启按钮: 原始内容判定为未安装",
    initial.installed === 0 && initial.entries.every((entry) => entry.verdict === "unknown" || entry.verdict === "original"),
    JSON.stringify(initial.entries.map((entry) => entry.verdict)),
  );

  const applied = patch.apply(options);
  result.ok("重启按钮: 安装补丁", applied.ok === true && applied.changed === 2, applied.error ?? JSON.stringify(applied.entries));

  const sizeBeforeApply = SIZE_RAW(archive);
  const installed = patch.status(options);
  result.ok("重启按钮: 安装后判定为已安装", installed.conclusion === "installed", installed.conclusion);
  result.ok(
    "重启按钮: 安装后头部 integrity 一致",
    installed.entries.every((entry) => entry.integrity.ok === true),
    JSON.stringify(installed.entries.map((entry) => entry.integrity.detail)),
  );
  result.ok(
    "重启按钮: 安装不改变归档长度",
    SIZE_RAW(archive) === sizeBeforeApply,
    `${sizeBeforeApply} → ${SIZE_RAW(archive)}`,
  );

  const reverted = patch.revert(options);
  result.ok("重启按钮: 还原补丁", reverted.ok === true && reverted.touched === 2, reverted.error);
  const backToOriginal = patch.status(options);
  result.ok(
    "重启按钮: 还原后内容等于安装前",
    backToOriginal.installed === 0 &&
      READ_RAW(archive).equals(tinyArchive()),
    backToOriginal.conclusion,
  );

  // The regression this exists for: an application update replaces the archive
  // wholesale, so the entries are official content again and the backup on disk
  // still belongs to the previous build. Simulated faithfully — the archive is
  // rewritten with *new* official content (same length, as the patcher requires),
  // not left holding the patch.
  const UPDATED = ORIGINAL.replace("original build", "updated build!");
  WRITE_RAW(archive, buildTinyAsar({ "lib/main.js": UPDATED, "lib/preload-app.cjs": UPDATED }));
  const staleBackup = Buffer.from("// a much older build, different length\n");
  fs.writeFileSync(path.join(backupDir, "lib__main.js.orig"), staleBackup);
  fs.writeFileSync(path.join(backupDir, "lib__preload-app.cjs.orig"), staleBackup);
  const stale = patch.status(options);
  result.ok(
    "重启按钮: 旧备份不被当作可还原",
    stale.entries.every((entry) => entry.hasStaleBackup === true && entry.hasBackup === false),
    JSON.stringify(stale.entries.map((entry) => ({ hasBackup: entry.hasBackup, hasStaleBackup: entry.hasStaleBackup }))),
  );
  result.ok(
    "重启按钮: 更新后判定为「更新过，未安装」",
    stale.conclusion === "absent" && stale.entries.every((entry) => entry.verdict === "stale"),
    JSON.stringify(stale.entries.map((entry) => entry.verdict)),
  );

  const reApplied = patch.apply(options);
  result.ok("重启按钮: 应用更新后仍能重新安装", reApplied.ok === true, reApplied.error);
  result.ok(
    "重启按钮: 旧备份被归档而不是删除",
    fs.readdirSync(backupDir).some((name) => name.startsWith("stale-")),
    fs.readdirSync(backupDir).join(", "),
  );
  result.ok(
    "重启按钮: 归档后备份长度与当前一致",
    fs.readFileSync(path.join(backupDir, "lib__main.js.orig")).length === Buffer.byteLength(UPDATED),
    String(fs.readFileSync(path.join(backupDir, "lib__main.js.orig")).length),
  );

  const finalRevert = patch.revert(options);
  result.ok("重启按钮: 归档后可正常还原", finalRevert.ok === true && finalRevert.touched === 2, finalRevert.error);
  const restored = patch.status(options);
  result.ok(
    "重启按钮: 还原到应用更新后的内容",
    restored.installed === 0 &&
      READ_RAW(archive).equals(buildTinyAsar({ "lib/main.js": UPDATED, "lib/preload-app.cjs": UPDATED })),
    restored.conclusion,
  );

  result.ok(
    "重启按钮: 状态文件随还原删除",
    !fs.existsSync(stateFile),
    stateFile,
  );

  // --- same-size, different-build backup ---------------------------------
  //
  // 0.2.2-rc.2 → rc.3 changed one version string and nothing else, so both
  // builds' entries are exactly the same byte count. A size-only test called the
  // rc.2 backup valid and a revert would have written rc.2 over rc.3.
  const SAME_SIZE_OLD = ORIGINAL.replace("original build", "previous build");
  const sameSizeDir = path.join(dir, "same-size");
  const sameSizeArchive = path.join(sameSizeDir, "app.asar");
  ensureDir(sameSizeDir);
  const sameSizeOptions = { archive: sameSizeArchive, backupDir: path.join(sameSizeDir, "backup"), stateFile: path.join(sameSizeDir, "state.json"), payloadDir, log: () => {} };
  withoutAsar(() => {
    fs.writeFileSync(sameSizeArchive, buildTinyAsar({ "lib/main.js": SAME_SIZE_OLD, "lib/preload-app.cjs": SAME_SIZE_OLD }));
  });
  result.ok(
    "重启按钮: fixture 的两个构建等长",
    Buffer.byteLength(SAME_SIZE_OLD) === Buffer.byteLength(ORIGINAL),
    `${Buffer.byteLength(SAME_SIZE_OLD)} vs ${Buffer.byteLength(ORIGINAL)}`,
  );
  patch.apply(sameSizeOptions);
  // Forge the trap: same length, previous build's bytes, and a manifest that
  // does not know which build it came from (which is how older tools wrote it).
  sameSizeOptions.log = () => {};
  const sameSizeBackupDir = sameSizeOptions.backupDir;
  fs.writeFileSync(path.join(sameSizeBackupDir, "lib__main.js.orig"), withoutAsar(() => fs.readFileSync(sameSizeArchive)));
  const forgedManifest = JSON.parse(fs.readFileSync(path.join(sameSizeBackupDir, "manifest.json"), "utf8"));
  forgedManifest.entries["lib/main.js"] = { backupFile: "backup/lib__main.js.orig", size: Buffer.byteLength(SAME_SIZE_OLD), sha256: "0".repeat(64), backedUpAt: new Date().toISOString() };
  fs.writeFileSync(path.join(sameSizeBackupDir, "manifest.json"), JSON.stringify(forgedManifest, null, 2));
  const sameSizeStatus = patch.status(sameSizeOptions);
  result.ok(
    "重启按钮: 等长但不同构建的备份不算可还原",
    sameSizeStatus.entries[0].hasStaleBackup === true && sameSizeStatus.entries[0].hasBackup === false,
    JSON.stringify(sameSizeStatus.entries.map((entry) => ({ hasBackup: entry.hasBackup, hasStaleBackup: entry.hasStaleBackup }))),
  );

  // --- a backup must never be filled with the payload ---------------------
  //
  // `snap` is what the archive holds now; when the entry is already patched,
  // copying it into the backup produces a "restore" that rewrites the payload
  // over itself while status reports 已还原.
  const idempotentDir = path.join(dir, "idempotent");
  const idempotentArchive = path.join(idempotentDir, "app.asar");
  ensureDir(idempotentDir);
  const idempotentOptions = { archive: idempotentArchive, backupDir: path.join(idempotentDir, "backup"), stateFile: path.join(idempotentDir, "state.json"), payloadDir, log: () => {} };
  withoutAsar(() => {
    fs.writeFileSync(idempotentArchive, tinyArchive());
  });
  patch.apply(idempotentOptions);
  const backupOfOriginal = withoutAsar(() => fs.readFileSync(path.join(idempotentOptions.backupDir, "lib__main.js.orig")));
  patch.apply(idempotentOptions);
  const backupAfterSecond = withoutAsar(() => fs.readFileSync(path.join(idempotentOptions.backupDir, "lib__main.js.orig")));
  result.ok(
    "重启按钮: 重复安装不会把载荷写进备份",
    backupAfterSecond.equals(backupOfOriginal) && !backupAfterSecond.equals(Buffer.from(PATCHED, "utf8")),
    `${backupAfterSecond.length} 字节,等于载荷=${backupAfterSecond.equals(Buffer.from(PATCHED, "utf8"))}`,
  );

  // With no usable backup and an already-patched entry, apply must say so
  // rather than inventing one.
  fs.rmSync(path.join(idempotentOptions.backupDir, "lib__main.js.orig"), { force: true });
  const unavailable = patch.apply(idempotentOptions);
  const unavailableReport = unavailable.entries.find((entry) => entry.entryPath === "lib/main.js");
  result.ok(
    "重启按钮: 已打补丁且无备份时不伪造备份",
    unavailableReport !== undefined && unavailableReport.backup === "unavailable",
    JSON.stringify(unavailableReport?.backup),
  );
}

module.exports = { runVerify };
