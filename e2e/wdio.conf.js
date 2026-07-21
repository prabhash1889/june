// WebdriverIO + tauri-driver config for June's E2E smoke harness (improvement-8
// 1.1). tauri-driver bridges the W3C WebDriver protocol to the native WebView2
// webview on Windows; WebdriverIO drives it. This is the ONLY layer that can see
// the orphaned-webview / kill-tree class of bug (see memory: mouse-input-killing
// webviews, sync-command deadlocks) - every unit test is blind to it.
//
// Prereqs (see README.md): `cargo install tauri-driver`, a WebView2 runtime, and
// msedgedriver matching the installed WebView2. Runs on Windows only.

const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");

const APP = path.resolve(__dirname, "..", "src-tauri", "target", "debug", "june.exe");
const TAURI_DRIVER = path.resolve(os.homedir(), ".cargo", "bin", "tauri-driver.exe");

let tauriDriver;

exports.config = {
  runner: "local",
  specs: ["./specs/**/*.e2e.js"],
  maxInstances: 1,
  capabilities: [
    {
      // tauri-driver reads this to launch the app under WebDriver control.
      "tauri:options": { application: APP },
    },
  ],
  hostname: "127.0.0.1",
  port: 4444,
  logLevel: "info",
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { ui: "bdd", timeout: 120_000 },

  // Build the debug app once before the suite. A release build would strip the
  // devtools the driver attaches to, so the smoke run uses the debug binary.
  onPrepare: () => {
    const res = spawnSync("cargo", ["build", "--manifest-path", path.resolve(__dirname, "..", "src-tauri", "Cargo.toml")], {
      stdio: "inherit",
    });
    if (res.status !== 0) throw new Error("cargo build (debug) failed - cannot run E2E");
  },

  // tauri-driver must be up before WebdriverIO opens the session, and killed after.
  beforeSession: () => {
    tauriDriver = spawn(TAURI_DRIVER, [], { stdio: [null, process.stdout, process.stderr] });
  },
  afterSession: () => {
    tauriDriver?.kill();
  },
};
