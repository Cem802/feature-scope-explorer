import * as vscode from 'vscode';
import { FeatureScopeProvider, FileNode } from './FeatureScopeProvider';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new FeatureScopeProvider(context);
  const treeView = vscode.window.createTreeView('featureScope', {
    treeDataProvider: provider,
    showCollapseAll: true,
    dragAndDropController: provider,
  });
  provider.setTreeView(treeView);

  registerCommands(context, provider, treeView);

  provider.refresh();
}

export function deactivate(): void {
  // Nothing to clean up.
}

function registerCommands(
  context: vscode.ExtensionContext,
  provider: FeatureScopeProvider,
  treeView: vscode.TreeView<FileNode>
): void {
  context.subscriptions.push(treeView);

  context.subscriptions.push(
    vscode.commands.registerCommand('featureScope.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('featureScope.setFilter', async () => {
      const current = provider.getCurrentFilter();
      const value = await vscode.window.showInputBox({
        prompt: 'Filter term (path substring)',
        value: current,
      });
      if (value !== undefined) {
        provider.setFilter(value);
      }
    }),
    vscode.commands.registerCommand('featureScope.clearFilter', () => provider.clearFilter()),
    vscode.commands.registerCommand('featureScope.toggleExactMatch', () => provider.toggleExactMatch()),
    vscode.commands.registerCommand('featureScope.addCurrentFile', () => {
      const uri = vscode.window.activeTextEditor?.document.uri;
      provider.addCurrentFile(uri);
    }),
    vscode.commands.registerCommand('featureScope.newConfig', () => provider.newConfig()),
    vscode.commands.registerCommand('featureScope.loadConfig', () => provider.loadConfig()),
    vscode.commands.registerCommand('featureScope.saveCurrent', () => provider.saveCurrentConfig()),
    vscode.commands.registerCommand('featureScope.deleteConfig', () => provider.deleteConfig()),
    vscode.commands.registerCommand('featureScope.reveal', (node?: FileNode) => revealInExplorer(node)),
    vscode.commands.registerCommand('featureScope.open', (node?: FileNode) => openFile(node))
  );
}

async function revealInExplorer(node?: FileNode): Promise<void> {
  if (!node) {
    return;
  }
  await vscode.commands.executeCommand('revealInExplorer', node.uri);
}

async function openFile(node?: FileNode): Promise<void> {
  if (!node || node.isDirectory) {
    return;
  }
  await vscode.commands.executeCommand('vscode.open', node.uri);
}
