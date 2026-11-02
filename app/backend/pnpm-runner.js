"use strict";
// Runs one pnpm command in a separate process, so a hanging pnpm can never
// freeze the console's window.
//
// Why this exists: `plugin-updater.js` used `spawnSync`, which blocks the
// Electron *main* process. The main process also serves the renderer's IPC and
// paints the window, so one pnpm that stalls (registry retries, a supply-chain
// policy check, a package's lifecycle script) froze the whole console — the
// reported "更新插件把软件卡死了". Spawning pnpm from here instead keeps the
// main process responsive: the window keeps painting, the footer keeps working,
// and the user can still quit.
//
// Protocol: this file is started with `--job=<json>` and prints exactly one
// JSON object on the last line of stdout. Progress lines are prefixed with
// `::progress::` so the caller can stream them if it ever wants to.

const { spawn } = require("node:child_process");

function parseJob(argv) {
  const entry = argv.find((argument) => argument.startsWith("--job="));
  if (entry === undefined) throw new Error("缺少 --job 参数");
  return JSON.parse(Buffer.from(entry.slice("--job=".length), "base64").toString("utf8"));
}

function run(job) {
  return new Promise((resolve) => {
    const child = spawn(job.command, [...job.prefix, ...job.args], {
      cwd: job.cwd,
      windowsHide: true,
      env: { ...process.env, ...job.env, CI: "true" },
      // `shell: true` only for the PATH `pnpm.cmd` shim on Windows; the bundled
      // runtime is launched through its own node.exe and needs no shell.
      shell: job.shell === true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const limit = 64 * 1024 * 1024;
    child.stdout.on("data", (chunk) => {
      if (stdout.length < limit) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < limit) stderr += chunk.toString("utf8");
    });

    const timer = setTimeout(() => {
      // The whole point of this process: a stall must end, not hang forever.
      try {
        child.kill("SIGKILL");
      } catch {}
      finish({ ok: false, reason: "timeout", stdout, stderr, timeoutMs: job.timeoutMs });
    }, job.timeoutMs);

    child.on("error", (error) => {
      finish({ ok: false, reason: "spawn", message: error.message, stdout, stderr });
    });
    child.on("close", (code, signal) => {
      finish({ ok: true, status: code, signal, stdout, stderr });
    });
  });
}

const job = parseJob(process.argv);
run(job).then((result) => {
  process.stdout.write(`${JSON.stringify({ marker: "dsh-pnpm-runner", ...result })}\n`);
  // A killed grandchild can keep the event loop alive on Windows; exiting
  // explicitly is what guarantees the timeout actually frees the caller.
  process.exit(0);
});
