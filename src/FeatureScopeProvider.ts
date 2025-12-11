import * as path from 'path';
import * as vscode from 'vscode';
import { minimatch } from 'minimatch';

export interface FeatureConfig {
  name: string;
  filters: string[];
  paths: string[];
  exactMatch: boolean;
  filter?: string;
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

  private refreshDebounce?: NodeJS.Timeout;
  private filters: string[] = [];
  private exactMatch = false;
  private addedPaths: Set<string> = new Set();
  private configs: FeatureConfig[] = [];
  private activeConfigName: string | undefined;

  private targetFolders: Set<string> = new Set();
  private explicitFiles: Set<string> = new Set();
  private ancestors: Set<string> = new Set();
  private excludePatterns: string[] = [];
  private nodeCache: Map<string, FileNode> = new Map();
  private expandedNodes: Set<string> = new Set();
  private hasExpandedNodes: boolean | undefined;

  private view?: vscode.TreeView<FileNode>;
  private readonly changeEmitter = new vscode.EventEmitter<FileNode | undefined | null | void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.loadPersistedConfigs();
    this.loadExcludes();
    this.registerWatchers();
    this.registerConfigurationListeners();
  }

  setTreeView(view: vscode.TreeView<FileNode>): void {
    this.view = view;
    const disposables = [
      view.onDidExpandElement((e) => this.markExpanded(e.element)),
      view.onDidCollapseElement((e) => this.markCollapsed(e.element)),
    ];
    this.context.subscriptions.push(...disposables);
    this.updateExpansionContext();
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
    return this.filters.join(', ');
  }

  isExactMatch(): boolean {
    return this.exactMatch;
  }

  async setFilter(filter: string): Promise<void> {
    this.filters = this.parseFilters(filter);
    await this.refresh();
    this.autoSaveActiveConfig();
    this.updateViewTitle();
  }

  async clearFilter(): Promise<void> {
    this.filters = [];
    await this.refresh();
    this.autoSaveActiveConfig();
    this.updateViewTitle();
  }

  async clearAll(): Promise<void> {
    this.filters = [];
    this.exactMatch = false;
    this.addedPaths.clear();
    this.targetFolders.clear();
    this.explicitFiles.clear();
    this.ancestors.clear();
    await this.refresh();
    this.autoSaveActiveConfig();
    this.updateViewTitle();
  }

  toggleExactMatch(): void {
    this.exactMatch = !this.exactMatch;
    this.refresh();
    this.autoSaveActiveConfig();
    this.updateViewTitle();
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

  async addFolder(target?: FileNode | vscode.Uri): Promise<void> {
    if (target) {
      const fsPath = target instanceof vscode.Uri ? target.fsPath : target.uri.fsPath;
      this.addTrackedPath(fsPath);
      await this.refresh();
      this.autoSaveActiveConfig();
      return;
    }
    const result = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: true,
      openLabel: 'Add Folder to Feature Scope',
    });
    if (!result || result.length === 0) {
      return;
    }
    for (const uri of result) {
      this.addTrackedPath(uri.fsPath);
    }
    await this.refresh();
    this.autoSaveActiveConfig();
  }

  async newConfig(): Promise<void> {
    // Start a fresh, unsaved scope so the user can set filters and decide to save later.
    this.filters = [];
    this.exactMatch = false;
    this.addedPaths.clear();
    this.targetFolders.clear();
    this.explicitFiles.clear();
    this.ancestors.clear();
    this.activeConfigName = undefined;
    await this.context.workspaceState.update(ACTIVE_KEY, undefined);
    await this.refresh();
    this.updateViewTitle();
    vscode.window.showInformationMessage('Started a new Feature Scope. Set filters or add items, then Save Config if you want to keep it.');
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
    await this.applyConfig(config);
    await this.context.workspaceState.update(ACTIVE_KEY, this.activeConfigName);
    vscode.window.showInformationMessage(`Loaded Feature Scope config "${config.name}".`);
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
      filters: this.filters,
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
    this.nodeCache.clear();
    this.expandedNodes.clear();
    this.updateExpansionContext();
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
      vscode.window.showInformationMessage('Open folder first to use Feature Scope Explorer.');
      this.changeEmitter.fire();
      return;
    }
    await this.calculateScope();
    this.changeEmitter.fire();
  }

  async collapseAll(): Promise<void> {
    this.expandedNodes.clear();
    this.updateExpansionContext();
    await vscode.commands.executeCommand('workbench.actions.treeView.featureScope.collapseAll');
  }

  async expandAll(): Promise<void> {
    if (!this.view) {
      return;
    }
    const roots = await this.getChildren();
    await this.expandNodesRecursive(roots);
  }

  async revealActiveEditor(editor: vscode.TextEditor | undefined): Promise<void> {
    if (!editor || editor.document.uri.scheme !== 'file' || !this.view) {
      return;
    }
    const node = await this.findNode(editor.document.uri);
    if (!node) {
      return;
    }
    try {
      await this.view.reveal(node, { select: true, focus: false, expand: true });
      this.markExpanded(node);
    } catch {
      // Ignore reveal errors that can happen if the tree updates while revealing.
    }
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
      const topLevel: FileNode[] = [];
      for (const folder of folders) {
        const children = await this.getDirectoryChildren(folder.uri, -1, false);
        topLevel.push(...children);
      }
      return topLevel;
    }
    if (!element.isDirectory) {
      return [];
    }
    if (element.depth >= MAX_DEPTH) {
      return [];
    }

    return this.getDirectoryChildren(element.uri, element.depth, element.allowChildren);
  }

  getParent(element: FileNode): FileNode | null {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(element.uri);
    if (!workspaceFolder) {
      return null;
    }
    const normalizedParent = this.normalize(path.dirname(element.uri.fsPath));
    const workspaceRoot = this.normalize(workspaceFolder.uri.fsPath);
    if (normalizedParent === workspaceRoot || normalizedParent === this.normalize(element.uri.fsPath)) {
      return null;
    }
    const allowChildren = this.isWithinTarget(normalizedParent);
    const depth = Math.max(element.depth - 1, -1);
    return this.createNode(vscode.Uri.file(normalizedParent), true, depth, allowChildren);
  }

  private markExpanded(element: FileNode): void {
    const key = this.normalize(element.uri.fsPath);
    this.expandedNodes.add(key);
    this.updateExpansionContext();
  }

  private markCollapsed(element: FileNode): void {
    const key = this.normalize(element.uri.fsPath);
    this.expandedNodes.delete(key);
    for (const candidate of Array.from(this.expandedNodes)) {
      const relative = path.relative(key, candidate);
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        this.expandedNodes.delete(candidate);
      }
    }
    this.updateExpansionContext();
  }

  private updateExpansionContext(): void {
    const next = this.expandedNodes.size > 0;
    if (this.hasExpandedNodes === next) {
      return;
    }
    this.hasExpandedNodes = next;
    void vscode.commands.executeCommand('setContext', 'featureScope.hasExpandedNodes', next);
  }

  private createNode(uri: vscode.Uri, isDirectory: boolean, depth: number, allowChildren = false): FileNode {
    const key = this.normalize(uri.fsPath);
    const existing = this.nodeCache.get(key);
    if (existing) {
      existing.isDirectory = isDirectory;
      existing.depth = depth;
      existing.allowChildren = existing.allowChildren || allowChildren;
      return existing;
    }
    const node: FileNode = { uri, isDirectory, allowChildren, depth };
    this.nodeCache.set(key, node);
    return node;
  }

  private async calculateScope(): Promise<void> {
    this.targetFolders.clear();
    this.explicitFiles.clear();
    this.ancestors.clear();

    this.addedPaths.forEach((p) => this.addPathToSets(p));

    if (this.filters.length > 0) {
      const patterns = this.getGlobPatterns();
      if (patterns.length === 0) {
        return;
      }
      const results = await Promise.all(patterns.map((pattern) => vscode.workspace.findFiles(pattern)));
      for (const group of results) {
        for (const uri of group) {
          this.registerMatch(uri);
        }
      }
    }
  }

  private getGlobPatterns(): string[] {
    if (this.filters.length === 0) {
      return [];
    }
    if (this.exactMatch) {
      return this.filters.flatMap((term) => [`**/${term}/**`, `**/${term}`]);
    }
    return this.filters.flatMap((term) => [`**/*${term}*/**`, `**/*${term}*`]);
  }

  private registerMatch(uri: vscode.Uri): void {
    const normalized = this.normalize(uri.fsPath);
    if (this.isExcludedPath(normalized) && !this.addedPaths.has(normalized)) {
      return;
    }
    if (this.isHiddenPath(normalized)) {
      return;
    }
    if (normalized.includes(`${path.sep}.git${path.sep}`)) {
      return;
    }
    const segments = normalized.split(path.sep);
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const lower = segment.toLowerCase();
      const matched = this.filters.some((filter) =>
        this.exactMatch ? lower === filter.toLowerCase() : lower.includes(filter.toLowerCase())
      );
      if (!matched) {
        continue;
      }
      const matchedPath = segments.slice(0, i + 1).join(path.sep);
      const folderTarget = i === segments.length - 1 && path.extname(segment) ? path.dirname(matchedPath) : matchedPath;
      this.targetFolders.add(folderTarget);
      this.collectAncestors(folderTarget);
      break;
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
    if (!this.addedPaths.has(fsPath) && this.isExcludedPath(fsPath)) {
      return false;
    }
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

  private loadExcludes(): void {
    const filesExclude = vscode.workspace.getConfiguration('files').get<Record<string, boolean>>('exclude') ?? {};
    const searchExclude = vscode.workspace.getConfiguration('search').get<Record<string, boolean>>('exclude') ?? {};
    const patterns = new Set<string>();
    for (const [pattern, enabled] of Object.entries(filesExclude)) {
      if (enabled) {
        patterns.add(pattern);
      }
    }
    for (const [pattern, enabled] of Object.entries(searchExclude)) {
      if (enabled) {
        patterns.add(pattern);
      }
    }
    this.excludePatterns = Array.from(patterns);
  }

  private registerConfigurationListeners(): void {
    const disposable = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('files.exclude') || event.affectsConfiguration('search.exclude')) {
        this.loadExcludes();
        void this.refresh();
      }
    });
    this.context.subscriptions.push(disposable);
  }

  private isHiddenName(name: string): boolean {
    return name.startsWith('.');
  }

  private isHiddenPath(fsPath: string): boolean {
    return this.normalize(fsPath)
      .split(path.sep)
      .some((segment) => this.isHiddenName(segment));
  }

  private isExcludedPath(fsPath: string): boolean {
    const rel = this.toWorkspaceRelative(fsPath);
    if (rel === undefined) {
      return false;
    }
    return this.excludePatterns.some((pattern) => minimatch(rel, pattern, { dot: true }));
  }

  private toWorkspaceRelative(fsPath: string): string | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fsPath));
    if (!folder) {
      return undefined;
    }
    const rel = path.relative(folder.uri.fsPath, fsPath);
    return rel.split(path.sep).join('/');
  }

  private parseFilters(input: string | string[] | undefined): string[] {
    if (!input) {
      return [];
    }
    const parts = Array.isArray(input) ? input : input.split(/[,\s]+/);
    return parts.map((p) => p.trim()).filter(Boolean);
  }

  private async findNode(uri: vscode.Uri): Promise<FileNode | undefined> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (!workspaceFolder) {
      return undefined;
    }
    const normalizedTarget = this.normalize(uri.fsPath);
    const workspaceRoot = this.normalize(workspaceFolder.uri.fsPath);
    const relativePath = path.relative(workspaceRoot, normalizedTarget);
    const segments = relativePath.split(path.sep).filter(Boolean);
    let currentUri = workspaceFolder.uri;
    let parentDepth = -1;
    let parentAllowsAll = false;
    let lastNode: FileNode | undefined;
    for (const segment of segments) {
      const children = await this.getDirectoryChildren(currentUri, parentDepth, parentAllowsAll);
      const next = children.find((child) => path.basename(child.uri.fsPath) === segment);
      if (!next) {
        return undefined;
      }
      lastNode = next;
      currentUri = next.uri;
      parentDepth = next.depth;
      parentAllowsAll = next.allowChildren;
    }
    return lastNode;
  }

  private async expandNodesRecursive(nodes: FileNode[]): Promise<void> {
    for (const node of nodes) {
      if (!node.isDirectory) {
        continue;
      }
      try {
        await this.view?.reveal(node, { expand: true, focus: false, select: false });
        this.markExpanded(node);
      } catch {
        // Ignore reveal errors that can happen if the tree updates while revealing.
      }
      const children = await this.getChildren(node);
      await this.expandNodesRecursive(children);
    }
  }

  private async getDirectoryChildren(uri: vscode.Uri, parentDepth: number, parentAllowsAll: boolean): Promise<FileNode[]> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(uri);
      const children: FileNode[] = [];
      for (const [name, fileType] of entries) {
        const childUri = vscode.Uri.joinPath(uri, name);
        const childPath = this.normalize(childUri.fsPath);
        const isDir = fileType === vscode.FileType.Directory;
        const hidden = this.isHiddenName(name);
        if ((hidden || this.isExcludedPath(childPath)) && !this.addedPaths.has(childPath)) {
          continue;
        }
        const includeByScope = this.shouldInclude(childPath, isDir, parentAllowsAll);
        if (!includeByScope) {
          continue;
        }
        const allowAllDescendants = parentAllowsAll || this.isWithinTarget(childPath);
        children.push(this.createNode(childUri, isDir, parentDepth + 1, allowAllDescendants));
      }
      return this.sortNodes(children);
    } catch (error) {
      vscode.window.showErrorMessage(`Unable to read ${uri.fsPath}`);
      return [];
    }
  }

  private sortNodes(nodes: FileNode[]): FileNode[] {
    return nodes.sort((a, b) => {
      if (a.isDirectory === b.isDirectory) {
        return a.uri.fsPath.localeCompare(b.uri.fsPath);
      }
      return a.isDirectory ? -1 : 1;
    });
  }

  private registerWatchers(): void {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    this.context.subscriptions.push(
      watcher,
      watcher.onDidCreate(() => this.scheduleRefreshOnFsChange()),
      watcher.onDidDelete(() => this.scheduleRefreshOnFsChange()),
      watcher.onDidChange(() => this.scheduleRefreshOnFsChange()),
      vscode.workspace.onDidRenameFiles(() => this.scheduleRefreshOnFsChange())
    );
  }

  private scheduleRefreshOnFsChange(): void {
    if (!this.shouldAutoRefreshOnFsChange()) {
      return;
    }
    if (this.refreshDebounce) {
      clearTimeout(this.refreshDebounce);
    }
    this.refreshDebounce = setTimeout(() => {
      void this.refresh();
    }, 400);
  }

  private shouldAutoRefreshOnFsChange(): boolean {
    return this.filters.length > 0 || this.addedPaths.size > 0;
  }

  private loadPersistedConfigs(): void {
    const configs = this.context.workspaceState.get<FeatureConfig[]>(CONFIG_KEY, []);
    this.configs = configs ?? [];
    this.activeConfigName = this.context.workspaceState.get<string | undefined>(ACTIVE_KEY);
    const activeConfig = this.configs.find((c) => c.name === this.activeConfigName);
    if (activeConfig) {
      void this.applyConfig(activeConfig);
    }
  }

  private async persistConfigs(): Promise<void> {
    await this.context.workspaceState.update(CONFIG_KEY, this.configs);
    await this.context.workspaceState.update(ACTIVE_KEY, this.activeConfigName);
  }

  private async applyConfig(config: FeatureConfig): Promise<void> {
    this.filters = this.parseFilters(config.filters ?? config.filter);
    this.exactMatch = config.exactMatch;
    this.addedPaths = new Set(config.paths.map((p) => this.normalize(p)));
    this.activeConfigName = config.name;
    await this.context.workspaceState.update(ACTIVE_KEY, this.activeConfigName);
    this.updateViewTitle();
    await this.refresh();
  }

  private updateViewTitle(): void {
    if (!this.view) {
      return;
    }
    this.view.title = this.activeConfigName ? `Feature Scope (${this.activeConfigName})` : 'Feature Scope';
    const filterLabel = this.filters.length > 0 ? this.filters.join(', ') : 'No filters';
    const matchLabel = this.exactMatch ? 'Exact' : 'Contains';
    this.view.description = `${matchLabel} • ${filterLabel}`;
  }

  private async autoSaveActiveConfig(): Promise<void> {
    if (!this.activeConfigName) {
      return;
    }
    const updated: FeatureConfig = {
      name: this.activeConfigName,
      filters: this.filters,
      paths: Array.from(this.addedPaths),
      exactMatch: this.exactMatch,
    };
    this.configs = [...this.configs.filter((c) => c.name !== updated.name), updated];
    await this.persistConfigs();
    this.updateViewTitle();
  }
}
