// End-to-end test inside a real VS Code window. Run with: node test/e2e/runTest.js
// Optional: VSCODE_EXE points at the Code executable to use (otherwise a VS Code build is downloaded).
const os = require('os');
const path = require('path');
const fs = require('fs');
const { runTests } = require('@vscode/test-electron');

async function main() {
  delete process.env.ELECTRON_RUN_AS_NODE;
  const repo = path.resolve(__dirname, '..', '..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dbx-e2e-'));
  // The launcher splits arguments at spaces on Windows, so work through junctions without spaces.
  const link = (target, name) => {
    if (!/\s/.test(target)) return target;
    const l = path.join(tmp, name);
    fs.symlinkSync(target, l, 'junction');
    return l;
  };
  const workspace = path.join(tmp, 'workspace');
  fs.mkdirSync(workspace);
  const settingsDir = path.join(tmp, 'user-data', 'User');
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify({ 'workbench.startupEditor': 'none', 'chat.disableAIFeatures': true, 'update.mode': 'none' }));
  try {
    await runTests({
      vscodeExecutablePath: process.env.VSCODE_EXE || undefined,
      extensionDevelopmentPath: link(repo, 'ext-src'),
      extensionTestsPath: path.join(link(path.join(repo, 'test', 'e2e'), 'suite-src'), 'suite.js'),
      extensionTestsEnv: { DBX_E2E_WORKSPACE: workspace, DBX_E2E_REPO: repo },
      launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust', `--user-data-dir=${path.join(tmp, 'user-data')}`, `--extensions-dir=${path.join(tmp, 'ext')}`],
    });
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    } catch {
      // VS Code may still hold its log files for a moment.
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
