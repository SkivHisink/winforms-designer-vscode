import * as assert from 'node:assert';
import * as vscode from 'vscode';

const extensionId = 'skivhisink.winforms-designer-vscode';

export async function run(): Promise<void> {
  assert.strictEqual(process.platform, 'win32', 'the WinForms designer Extension Host suite must run on Windows');

  const extension = vscode.extensions.all.find((candidate) => candidate.id.toLowerCase() === extensionId);
  assert.ok(extension, `extension ${extensionId} was not loaded by the Extension Host`);
  // Version-agnostic: assert a real semver rather than a hardcoded literal (which failed the whole release on every
  // version bump — 1.0.0 → 1.0.1). The diagnostics cross-check below ties the reported version to THIS manifest value,
  // which is a stronger check than a fixed string ever was.
  const version = extension.packageJSON.version as string;
  assert.match(version, /^\d+\.\d+\.\d+$/, `manifest version is not semver: ${version}`);
  assert.strictEqual(extension.packageJSON.preview, false);
  assert.strictEqual(extension.packageJSON.capabilities?.untrustedWorkspaces?.supported, false);
  assert.strictEqual(extension.packageJSON.capabilities?.virtualWorkspaces?.supported, false);

  await extension.activate();
  assert.strictEqual(extension.isActive, true, 'extension did not activate');

  const commands = new Set(await vscode.commands.getCommands(true));
  for (const command of [
    'winformsDesigner.open',
    'winformsDesigner.viewCode',
    'winformsDesigner.showProperties',
    'winformsDesigner.exportDiagnostics',
    'winformsDesigner.selectControlAssembly',
    'winformsDesigner.editImageListImages',
    'winformsDesigner.releaseAssembly',
    'winformsDesigner.stopEngines',
    'winformsDesigner.restartEngines',
  ]) {
    assert.ok(commands.has(command), `command ${command} was not registered`);
  }

  // This drives a real extension command through the real Extension Host and starts the bundled/development
  // .NET engine. It catches activation/API-floor regressions as well as broken engine path/apphost logic.
  await vscode.commands.executeCommand('winformsDesigner.exportDiagnostics');
  const diagnostics = vscode.window.activeTextEditor?.document;
  assert.ok(diagnostics, 'Export Designer Diagnostics did not open a document');
  assert.strictEqual(diagnostics.languageId, 'markdown');
  const text = diagnostics.getText();
  assert.match(text, /# WinForms Designer .* Diagnostics/);
  assert.match(text, /- Platform: win32 /);
  assert.match(text, /- Engine: winforms-engine ok \/ \.NET 10\./,
    `the .NET 10 engine did not start successfully:\n${text}`);
  assert.ok(text.includes(`- Extension: ${version}`), `diagnostics should report the manifest version ${version}:\n${text}`);
  assert.match(text, /- Extension Host memory: \d+ MiB RSS/);
  assert.match(text, /- Engine ping: \d+(?:\.\d+)? ms/);
  assert.match(text, /- Engine PID: \d+/);
  assert.match(text, /- Engine capabilities: .*edit=/);
  assert.match(text, /## Engine lifecycle/);
  assert.match(text, /- modern: running \(pid \d+\); starts=1; lastStartup=\d+ ms; recentCrashes=0; lastExit=n\/a/);
  assert.match(text, /- net48: stopped; starts=0; lastStartup=n\/a; recentCrashes=0; lastExit=n\/a/);

  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
}
