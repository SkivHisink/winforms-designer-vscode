import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

interface UpgradeTestApi {
  openDesignerState(uri: vscode.Uri): { dirty: boolean; designerText: string; renderReady: boolean } | undefined;
  focusOpenDesigner(uri: vscode.Uri): Promise<void>;
  editOpenDesignerProperty(uri: vscode.Uri, id: string, property: string, type: string, isEnum: boolean, value: string): Promise<void>;
}

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(message);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

/** Runs against the INSTALLED product; the extensionDevelopmentPath is an unrelated disposable harness. */
export async function run(): Promise<void> {
  const phase = process.env.WFD_RELEASE21_UPGRADE_PHASE;
  assert.ok(phase === 'old-initialize' || phase === 'upgrade' || phase === 'downgrade');
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(root);
  const reportPath = path.join(root, `.upgrade-${phase}.json`);
  const product = vscode.extensions.getExtension<UpgradeTestApi>('SkivHisink.winforms-designer-vscode');
  assert.ok(product, 'the actual installed extension is absent');
  const expectedVersion = phase === 'upgrade' ? '2.1.0' : '2.0.0';
  assert.strictEqual(product.packageJSON.version, expectedVersion);
  const harness = vscode.extensions.getExtension('local-test.release21-upgrade-harness');
  assert.ok(harness);
  assert.notStrictEqual(product.extensionPath, harness.extensionPath, 'product was loaded as the development harness');
  const api = await product.activate();
  assert.ok(api?.openDesignerState, 'installed product activation failed or E2E seam is absent');
  const checks = ['installed-product-version', 'separate-development-harness', 'real-product-activation'];
  let commandResult: unknown;
  try {
    const commands = new Set(await vscode.commands.getCommands(true));
    assert.strictEqual(commands.has('winformsDesigner.rebuildToolboxCache'), phase === 'upgrade');
    checks.push('version-specific-product-commands');
    if (phase !== 'old-initialize') {
      const source = vscode.Uri.file(path.join(root, 'UpgradeForm.cs'));
      const designerFile = path.join(root, 'UpgradeForm.Designer.cs');
      const original = fs.readFileSync(designerFile, 'utf8');
      if (phase === 'upgrade') {
        commandResult = await vscode.commands.executeCommand('winformsDesigner.rebuildToolboxCache');
        checks.push('real-disposable-cache-clear-command');
      }
      await vscode.commands.executeCommand('vscode.openWith', source, 'winformsDesigner.designer');
      await waitFor(() => api.openDesignerState(source)?.renderReady === true, `${phase}: real designer did not render`);
      checks.push('real-designer-render');
      if (phase === 'upgrade') {
        await api.editOpenDesignerProperty(source, 'button1', 'Text', 'System.String', false, 'UPGRADE_UNSAVED_BACKUP_21');
        await waitFor(() => api.openDesignerState(source)?.designerText.includes('UPGRADE_UNSAVED_BACKUP_21') === true,
          'product edit did not reach CustomDocument');
        assert.strictEqual(api.openDesignerState(source)?.dirty, true);
        assert.strictEqual(fs.readFileSync(designerFile, 'utf8'), original);
        checks.push('dirty-custom-document-created', 'source-file-remains-unchanged');
      } else {
        assert.strictEqual(api.openDesignerState(source)?.dirty, true, 'old product did not restore a dirty CustomDocument');
        assert.ok(api.openDesignerState(source)?.designerText.includes('UPGRADE_UNSAVED_BACKUP_21'),
          'old product did not restore the new product source-byte backup');
        assert.strictEqual(fs.readFileSync(designerFile, 'utf8'), original);
        checks.push('old-product-restored-new-backup', 'restored-source-file-remains-unchanged');
        await api.focusOpenDesigner(source);
        await vscode.commands.executeCommand('undo');
        await waitFor(() => api.openDesignerState(source)?.designerText === original, 'old product undo did not restore disk baseline');
        assert.strictEqual(api.openDesignerState(source)?.dirty, false);
        await vscode.commands.executeCommand('redo');
        await waitFor(() => api.openDesignerState(source)?.designerText.includes('UPGRADE_UNSAVED_BACKUP_21') === true,
          'old product redo did not restore recovered unsaved source');
        assert.strictEqual(api.openDesignerState(source)?.dirty, true);
        checks.push('old-product-recovered-undo-redo');
        // Return to the saved baseline without writing user source, then close normally.
        await vscode.commands.executeCommand('undo');
        await waitFor(() => api.openDesignerState(source)?.dirty === false, 'final undo did not return to clean baseline');
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      }
    }
    fs.writeFileSync(reportPath, `${JSON.stringify({
      phase, passed: true, completedAt: new Date().toISOString(), vscodeVersion: vscode.version,
      extensionVersion: product.packageJSON.version, installedExtensionPath: product.extensionPath,
      developmentHarnessPath: harness.extensionPath, checks, commandResult,
    }, null, 2)}\n`);
    console.log(`RELEASE21-UPGRADE ${phase}: PASS (${checks.length} checks)`);
    if (phase === 'upgrade') {
      // Normal test teardown would kill the host before workbench backup. An intentional workbench quit
      // persists the actual CustomDocument backup; the runner accepts it only with this terminal marker.
      await vscode.commands.executeCommand('workbench.action.quit');
      await new Promise<never>(() => {});
    }
  } catch (error) {
    fs.writeFileSync(reportPath, `${JSON.stringify({
      phase, passed: false, checks, error: error instanceof Error ? error.stack : String(error),
    }, null, 2)}\n`);
    throw error;
  }
}
