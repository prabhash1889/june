// June E2E smoke path (improvement-8 1.1). The single highest-leverage quality
// item on the backlog: it is the only test that exercises the real Tauri shell,
// both windows, and the resident's process tree - the layers every unit test is
// structurally blind to (orphaned webviews, sync-command deadlocks, the kill-tree
// regression B-1.10).
//
// Run headless-ish on a Windows runner with WebView2. See ../README.md for how the
// stubbed brain is wired (JUNE_APPROVE=allow + a local/echo provider) so a turn
// round-trips without a real API key.

const { execSync } = require("node:child_process");

describe("June smoke", () => {
  it("brings up the always-on widget with a live push-to-talk orb", async () => {
    const orb = await $('[aria-label="Push to talk"]');
    await orb.waitForExist({ timeout: 30_000 });
    await expect(orb).toBeExisting();
  });

  it("round-trips one stubbed turn through the app window", async () => {
    // Open the full window from the widget, type a command, and assert a reply
    // bubble lands - the cascaded pipeline end to end with a stubbed brain.
    const openApp = await $('[aria-label="Open the full June window"]');
    await openApp.click();

    // WebView2 opens the app as a second webview; switch WebdriverIO's context to it.
    await browser.waitUntil(async () => (await browser.getWindowHandles()).length >= 2, {
      timeout: 30_000,
      timeoutMsg: "the full app window never opened",
    });
    const handles = await browser.getWindowHandles();
    await browser.switchToWindow(handles[handles.length - 1]);

    const composer = await $('[aria-label="Type a command for June"]');
    await composer.waitForExist({ timeout: 30_000 });
    await composer.setValue("say hello");
    await browser.keys("Enter");

    // The reply streams into a .turn.june bubble via the shared agent://* events.
    const reply = await $(".turn.june");
    await reply.waitForExist({ timeout: 60_000 });
    await expect(reply).toBeExisting();
  });

  it("leaves no orphaned agent process after quit (kill-tree, 1.10)", async () => {
    await browser.deleteSession();
    // The resident serve.ts runs under a node/tsx child; a clean quit must reap the
    // whole tree. A lingering "serve.ts" node process is the exact leak B-1.10 fixed.
    const survivors = execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like \'*serve.ts*\' } | Measure-Object | %{ $_.Count }"',
    )
      .toString()
      .trim();
    if (survivors !== "0") throw new Error(`orphaned serve.ts process(es) survived quit: ${survivors}`);
  });
});
