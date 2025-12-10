import * as path from 'path';
import * as vscode from 'vscode';

export interface FeatureConfig {
  name: string;
  filter: string;
  paths: string[];
  exactMatch: boolean;
}

export interface FileNode {
  uri: vscode.Uri;
  isDirectory: boolean;
  allowChildren: boolean;
  depth: number;
}

const CONFIG_KEY = 'featureScope.configs';
const ACTIVE_KEY = 'featureScope.activeConfig';
const MAX_DEPTH = 40;

export class FeatureScopeProvider implements vscode.TreeDataProvider<FileNode>, vscode.TreeDragAndDropController<FileNode> {
  public readonly dropMimeTypes = ['text/uri-list'];
  public readonly dragMimeTypes: string[] = [];

  private filterTerm = '';
  private exactMatch = false;
  private addedPaths: Set<string> = new Set();
  private configs: FeatureConfig[] = [];
  private activeConfigName: string | undefined;

  private targetFolders: Set<string> = new Set();
  private explicitFiles: Set<string> = new Set();
  private ancestors: Set<string> = new Set();

  private view?: vscode.TreeView<FileNode>;
  private readonly changeEmitter = new vscode.EventEmitter<FileNode | undefined | null | void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.loadPersistedConfigs();
  }

  setTreeView(view: vscode.TreeView<FileNode>): void {
    this.view = view;
    this.updateViewTitle();
  }

  async handleDrop(target: FileNode | undefined, sources: vscode.DataTransfer): Promise<void> {
    const transferItem = sources.get('text/uri-list');
    if (!transferItem) {
      return;
    }
    const value = await transferItem.asString();
    const uris = value
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((item) => vscode.Uri.parse(item));
    for (const uri of uris) {
      this.addTrackedPath(uri.fsPath);
    }
    this.refresh();
  }

  handleDrag(): void {
    // Dragging from the view is not required.
  }

  getCurrentFilter(): string {
    return this.filterTerm;
  }

  isExactMatch(): boolean {
    return this.exactMatch;
  }

  async setFilter(filter: string): Promise<void> {
    this.filterTerm = filter.trim();
    await this.refresh();
    this.autoSaveActiveConfig();
  }

  async clearFilter(): Promise<void> {
    this.filterTerm = '';
    await this.refresh();
    this.autoSaveActiveConfig();
  }

  toggleExactMatch(): void {
    this.exactMatch = !this.exactMatch;
    this.refresh();
    this.autoSaveActiveConfig();
  }

  addCurrentFile(uri: vscode.Uri | undefined): void {
    if (!uri) {
      vscode.window.showInformationMessage('Open a file first to add it.');
      return;
    }
    this.addTrackedPath(uri.fsPath);
    this.refresh();
    this.autoSaveActiveConfig();
  }

  async newConfig(): Promise<void> {
    const name = await vscode.window.showInputBox({ prompt: 'Config name' });
    if (!name) {
      return;
    }
    const filter = (await vscode.window.showInputBox({ prompt: 'Filter term for this config' })) ?? '';
    const newConfig: FeatureConfig = {
      name,
      filter,
      paths: Array.from(this.addedPaths),
      exactMatch: this.exactMatch,
    };
    this.configs = [...this.configs.filter((c) => c.name !== name), newConfig];
    this.activeConfigName = name;
    this.filterTerm = filter;
    await this.persistConfigs();
    await this.refresh();
    this.updateViewTitle();
  }

  async loadConfig(): Promise<void> {
    if (this.configs.length === 0) {
      vscode.window.showInformationMessage('No Feature Scope configs saved yet.');
      return;
    }
    const picked = await vscode.window.showQuickPick(this.configs.map((c) => c.name), {
      placeHolder: 'Select a config',
    });
    if (!picked) {
      return;
    }
    const config = this.configs.find((c) => c.name === picked);
    if (!config) {
      return;
    }
    this.applyConfig(config);
  }

  async saveCurrentConfig(): Promise<void> {
    if (!this.activeConfigName) {
      const name = await vscode.window.showInputBox({ prompt: 'Name for this config' });
      if (!name) {
        return;
      }
      this.activeConfigName = name;
    }
    const config: FeatureConfig = {
      name: this.activeConfigName,
      filter: this.filterTerm,
      paths: Array.from(this.addedPaths),
      exactMatch: this.exactMatch,
    };
    this.configs = [...this.configs.filter((c) => c.name !== config.name), config];
    await this.persistConfigs();
    this.updateViewTitle();
    vscode.window.showInformationMessage(`Saved Feature Scope config "${config.name}".`);
  }

  async deleteConfig(): Promise<void> {
    if (this.configs.length === 0) {
      vscode.window.showInformationMessage('No Feature Scope configs saved yet.');
      return;
    }
    const picked = await vscode.window.showQuickPick(this.configs.map((c) => c.name), {
      placeHolder: 'Select a config to delete',
    });
    if (!picked) {
      return;
    }
    this.configs = this.configs.filter((c) => c.name !== picked);
    if (this.activeConfigName === picked) {
      this.activeConfigName = undefined;
    }
    await this.persistConfigs();
    this.updateViewTitle();
    vscode.window.showInformationMessage(`Deleted config "${picked}".`);
  }

  async refresh(): Promise<void> {
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
      vscode.window.showInformationMessage('Open folder first to use Feature Scope Explorer.');
      this.changeEmitter.fire();
      return;
    }
    await this.calculateScope();
    this.changeEmitter.fire();
  }

  getTreeItem(element: FileNode): vscode.TreeItem {
    const label = path.basename(element.uri.fsPath);
    const item = new vscode.TreeItem(label);
    item.resourceUri = element.uri;
    item.tooltip = element.uri.fsPath;
    if (element.isDirectory) {
      item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
      item.contextValue = 'folder';
    } else {
      item.collapsibleState = vscode.TreeItemCollapsibleState.None;
      item.contextValue = 'file';
      item.command = {
        command: 'vscode.open',
        title: 'Open File',
        arguments: [element.uri],
      };
    }
    return item;
  }

  async getChildren(element?: FileNode): Promise<FileNode[]> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return [];
    }
    if (!element) {
      return folders.map((folder) =>
        this.createNode(folder.uri, true, 0, this.isWithinTarget(this.normalize(folder.uri.fsPath)))
      );
    }
    if (!element.isDirectory) {
      return [];
    }
    if (element.depth >= MAX_DEPTH) {
      return [];
    }

    try {
      const entries = await vscode.workspace.fs.readDirectory(element.uri);
      const children: FileNode[] = [];
      for (const [name, fileType] of entries) {
        if (name === '.git') {
          continue;
        }
        const childUri = vscode.Uri.joinPath(element.uri, name);
        const childPath = this.normalize(childUri.fsPath);
        const isDir = fileType === vscode.FileType.Directory;
        const includeByScope = this.shouldInclude(childPath, isDir, element.allowChildren);
        if (!includeByScope) {
          continue;
        }
        const allowAllDescendants = element.allowChildren || this.isWithinTarget(childPath);
        children.push(this.createNode(childUri, isDir, element.depth + 1, allowAllDescendants));
      }
      return children.sort((a, b) => {
        if (a.isDirectory === b.isDirectory) {
          return a.uri.fsPath.localeCompare(b.uri.fsPath);
        }
        return a.isDirectory ? -1 : 1;
      });
    } catch (error) {
      vscode.window.showErrorMessage(`Unable to read ${element.uri.fsPath}`);
      return [];
    }
  }

  private createNode(uri: vscode.Uri, isDirectory: boolean, depth: number, allowChildren = false): FileNode {
    return { uri, isDirectory, allowChildren, depth };
  }

  private async calculateScope(): Promise<void> {
    this.targetFolders.clear();
    this.explicitFiles.clear();
    this.ancestors.clear();

    this.addedPaths.forEach((p) => this.addPathToSets(p));

    if (this.filterTerm) {
      const patterns = this.getGlobPatterns();
      const results = await Promise.all(patterns.map((pattern) => vscode.workspace.findFiles(pattern)));
      for (const group of results) {
        for (const uri of group) {
          this.registerMatch(uri);
        }
      }
    }
  }

  private getGlobPatterns(): string[] {
    if (this.exactMatch) {
      return [`**/${this.filterTerm}/**`, `**/${this.filterTerm}`];
    }
    return [`**/*${this.filterTerm}*/**`, `**/*${this.filterTerm}*`];
  }

  private registerMatch(uri: vscode.Uri): void {
    const normalized = this.normalize(uri.fsPath);
    if (normalized.includes(`${path.sep}.git${path.sep}`)) {
      return;
    }
    const segments = normalized.split(path.sep);
    const matchSegment = segments.find((segment) =>
      this.exactMatch ? segment.toLowerCase() === this.filterTerm.toLowerCase() : segment.toLowerCase().includes(this.filterTerm.toLowerCase())
    );
    if (matchSegment) {
      const idx = segments.findIndex((seg) => seg === matchSegment);
      const matchedPath = segments.slice(0, idx + 1).join(path.sep);
      const folderTarget = idx === segments.length - 1 && path.extname(matchSegment)
        ? path.dirname(matchedPath)
        : matchedPath;
      this.targetFolders.add(folderTarget);
      this.collectAncestors(folderTarget);
    }
    this.explicitFiles.add(normalized);
    this.collectAncestors(normalized);
  }

  private addTrackedPath(fsPath: string): void {
    const normalized = this.normalize(fsPath);
    this.addedPaths.add(normalized);
    this.addPathToSets(normalized);
  }

  private addPathToSets(fsPath: string): void {
    const normalized = this.normalize(fsPath);
    this.collectAncestors(normalized);
    this.explicitFiles.add(normalized);
    const parent = path.dirname(normalized);
    if (fsPath && fsPath === parent) {
      return;
    }
    const lastSegment = path.basename(normalized);
    if (lastSegment) {
      this.targetFolders.add(normalized);
    }
  }

  private collectAncestors(fsPath: string): void {
    let current = this.normalize(fsPath);
    while (true) {
      this.ancestors.add(current);
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }

  private shouldInclude(fsPath: string, isDir: boolean, parentAllowsAll: boolean): boolean {
    if (parentAllowsAll) {
      return true;
    }
    const inTargets = this.isWithinTarget(fsPath);
    if (inTargets) {
      return true;
    }
    if (!isDir && this.explicitFiles.has(fsPath)) {
      return true;
    }
    if (this.ancestors.has(fsPath)) {
      return true;
    }
    return false;
  }

  private isWithinTarget(candidate: string): boolean {
    for (const folder of this.targetFolders) {
      if (candidate === folder) {
        return true;
      }
      const relative = path.relative(folder, candidate);
      if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
        return true;
      }
    }
    return false;
  }

  private normalize(fsPath: string): string {
    return path.normalize(fsPath);
  }

  private loadPersistedConfigs(): void {
    const configs = this.context.workspaceState.get<FeatureConfig[]>(CONFIG_KEY, []);
    this.configs = configs ?? [];
    this.activeConfigName = this.context.workspaceState.get<string | undefined>(ACTIVE_KEY);
    const activeConfig = this.configs.find((c) => c.name === this.activeConfigName);
    if (activeConfig) {
      this.applyConfig(activeConfig);
    }
  }

  private async persistConfigs(): Promise<void> {
    await this.context.workspaceState.update(CONFIG_KEY, this.configs);
    await this.context.workspaceState.update(ACTIVE_KEY, this.activeConfigName);
  }

  private applyConfig(config: FeatureConfig): void {
    this.filterTerm = config.filter;
    this.exactMatch = config.exactMatch;
    this.addedPaths = new Set(config.paths.map((p) => this.normalize(p)));
    this.activeConfigName = config.name;
    this.updateViewTitle();
    this.refresh();
  }

  private updateViewTitle(): void {
    if (!this.view) {
      return;
    }
    this.view.title = this.activeConfigName ? `Feature Scope (${this.activeConfigName})` : 'Feature Scope';
  }

  private async autoSaveActiveConfig(): Promise<void> {
    if (!this.activeConfigName) {
      return;
    }
    const updated: FeatureConfig = {
      name: this.activeConfigName,
      filter: this.filterTerm,
      paths: Array.from(this.addedPaths),
      exactMatch: this.exactMatch,
    };
    this.configs = [...this.configs.filter((c) => c.name !== updated.name), updated];
    await this.persistConfigs();
    this.updateViewTitle();
  }
}
