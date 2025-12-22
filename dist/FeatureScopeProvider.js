"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.FeatureScopeProvider = void 0;
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const minimatch_1 = require("minimatch");
const CONFIG_KEY = 'featureScope.configs';
const ACTIVE_KEY = 'featureScope.activeConfig';
const MAX_DEPTH = 40;
class FeatureScopeProvider {
    context;
    dropMimeTypes = ['text/uri-list'];
    dragMimeTypes = [];
    refreshDebounce;
    filters = [];
    exactMatch = false;
    addedPaths = new Set();
    configs = [];
    activeConfigName;
    manualFolders = new Set();
    matchedRoots = new Set();
    explicitFiles = new Set();
    ancestors = new Set();
    excludePatterns = [];
    nodeCache = new Map();
    expandedNodes = new Set();
    hasExpandedNodes;
    viewVisible = false;
    view;
    changeEmitter = new vscode.EventEmitter();
    onDidChangeTreeData = this.changeEmitter.event;
    constructor(context) {
        this.context = context;
        this.loadPersistedConfigs();
        this.loadExcludes();
        this.registerWatchers();
        this.registerConfigurationListeners();
    }
    setTreeView(view) {
        this.view = view;
        this.viewVisible = view.visible;
        const disposables = [
            view.onDidExpandElement((e) => this.markExpanded(e.element)),
            view.onDidCollapseElement((e) => this.markCollapsed(e.element)),
            view.onDidChangeVisibility((event) => {
                this.viewVisible = event.visible;
                if (event.visible) {
                    void this.revealActiveEditor(vscode.window.activeTextEditor);
                }
            }),
        ];
        this.context.subscriptions.push(...disposables);
        this.updateExpansionContext();
        this.updateViewTitle();
    }
    async handleDrop(target, sources) {
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
    handleDrag() {
        // Dragging from the view is not required.
    }
    getCurrentFilter() {
        return this.filters.join(', ');
    }
    isExactMatch() {
        return this.exactMatch;
    }
    async setFilter(filter) {
        this.filters = this.parseFilters(filter);
        await this.refresh();
        this.autoSaveActiveConfig();
        this.updateViewTitle();
    }
    async clearFilter() {
        this.filters = [];
        await this.refresh();
        this.autoSaveActiveConfig();
        this.updateViewTitle();
    }
    async clearAll() {
        this.filters = [];
        this.exactMatch = false;
        this.addedPaths.clear();
        this.manualFolders.clear();
        this.matchedRoots.clear();
        this.explicitFiles.clear();
        this.ancestors.clear();
        await this.refresh();
        this.autoSaveActiveConfig();
        this.updateViewTitle();
    }
    toggleExactMatch() {
        this.exactMatch = !this.exactMatch;
        this.refresh();
        this.autoSaveActiveConfig();
        this.updateViewTitle();
    }
    addCurrentFile(uri) {
        if (!uri) {
            vscode.window.showInformationMessage('Open a file first to add it.');
            return;
        }
        this.addTrackedPath(uri.fsPath);
        this.refresh();
        this.autoSaveActiveConfig();
    }
    async addFolder(target) {
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
    async newConfig() {
        // Start a fresh, unsaved scope so the user can set filters and decide to save later.
        this.filters = [];
        this.exactMatch = false;
        this.addedPaths.clear();
        this.manualFolders.clear();
        this.explicitFiles.clear();
        this.ancestors.clear();
        this.activeConfigName = undefined;
        await this.context.workspaceState.update(ACTIVE_KEY, undefined);
        await this.refresh();
        this.updateViewTitle();
        vscode.window.showInformationMessage('Started a new Feature Scope. Set filters or add items, then Save Config if you want to keep it.');
    }
    async loadConfig() {
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
    async saveCurrentConfig() {
        if (!this.activeConfigName) {
            const name = await vscode.window.showInputBox({ prompt: 'Name for this config' });
            if (!name) {
                return;
            }
            this.activeConfigName = name;
        }
        const config = {
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
    async deleteConfig() {
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
    async refresh() {
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
    async collapseAll() {
        this.expandedNodes.clear();
        this.updateExpansionContext();
        await vscode.commands.executeCommand('workbench.actions.treeView.featureScope.collapseAll');
    }
    async expandAll() {
        if (!this.view) {
            return;
        }
        const roots = await this.getChildren();
        await this.expandNodesRecursive(roots);
    }
    async revealActiveEditor(editor) {
        if (!editor || editor.document.uri.scheme !== 'file' || !this.view || !this.viewVisible) {
            return;
        }
        const node = await this.findNode(editor.document.uri);
        if (!node) {
            return;
        }
        try {
            await this.view.reveal(node, { select: true, focus: false, expand: true });
            this.markExpanded(node);
        }
        catch {
            // Ignore reveal errors that can happen if the tree updates while revealing.
        }
    }
    getTreeItem(element) {
        const label = path.basename(element.uri.fsPath);
        const item = new vscode.TreeItem(label);
        item.resourceUri = element.uri;
        item.tooltip = element.uri.fsPath;
        if (element.isDirectory) {
            item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
            item.contextValue = 'folder';
        }
        else {
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
    async getChildren(element) {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            return [];
        }
        if (!element) {
            const topLevel = [];
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
    getParent(element) {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(element.uri);
        if (!workspaceFolder) {
            return null;
        }
        const normalizedParent = this.normalize(path.dirname(element.uri.fsPath));
        const workspaceRoot = this.normalize(workspaceFolder.uri.fsPath);
        if (normalizedParent === workspaceRoot || normalizedParent === this.normalize(element.uri.fsPath)) {
            return null;
        }
        const allowChildren = this.isWithinManualFolder(normalizedParent) || this.isWithinMatchedRoot(normalizedParent);
        const depth = Math.max(element.depth - 1, -1);
        return this.createNode(vscode.Uri.file(normalizedParent), true, depth, allowChildren);
    }
    markExpanded(element) {
        const key = this.normalize(element.uri.fsPath);
        this.expandedNodes.add(key);
        this.updateExpansionContext();
    }
    markCollapsed(element) {
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
    updateExpansionContext() {
        const next = this.expandedNodes.size > 0;
        if (this.hasExpandedNodes === next) {
            return;
        }
        this.hasExpandedNodes = next;
        void vscode.commands.executeCommand('setContext', 'featureScope.hasExpandedNodes', next);
    }
    createNode(uri, isDirectory, depth, allowChildren = false) {
        const key = this.normalize(uri.fsPath);
        const existing = this.nodeCache.get(key);
        if (existing) {
            existing.isDirectory = isDirectory;
            existing.depth = depth;
            existing.allowChildren = existing.allowChildren || allowChildren;
            return existing;
        }
        const node = { uri, isDirectory, allowChildren, depth };
        this.nodeCache.set(key, node);
        return node;
    }
    async calculateScope() {
        this.manualFolders.clear();
        this.matchedRoots.clear();
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
    getGlobPatterns() {
        if (this.filters.length === 0) {
            return [];
        }
        if (this.exactMatch) {
            return this.filters.flatMap((term) => [`**/${term}/**`, `**/${term}`]);
        }
        return this.filters.flatMap((term) => [`**/*${term}*/**`, `**/*${term}*`]);
    }
    registerMatch(uri) {
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
        const folderTargets = [];
        let fileMatched = false;
        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i];
            const lower = segment.toLowerCase();
            const matched = this.filters.some((filter) => this.exactMatch ? lower === filter.toLowerCase() : lower.includes(filter.toLowerCase()));
            if (!matched) {
                continue;
            }
            const isFile = i === segments.length - 1 && path.extname(segment) !== '';
            if (isFile) {
                fileMatched = true;
            }
            else {
                folderTargets.push(segments.slice(0, i + 1).join(path.sep));
            }
        }
        if (folderTargets.length === 0 && !fileMatched) {
            return;
        }
        for (const folderTarget of folderTargets) {
            this.matchedRoots.add(folderTarget);
            this.collectAncestors(folderTarget);
        }
        if (fileMatched) {
            this.explicitFiles.add(normalized);
            this.collectAncestors(normalized);
        }
    }
    addTrackedPath(fsPath) {
        const normalized = this.normalize(fsPath);
        this.addedPaths.add(normalized);
        this.addPathToSets(normalized);
    }
    addPathToSets(fsPath) {
        const normalized = this.normalize(fsPath);
        this.manualFolders.add(normalized);
        this.collectAncestors(normalized);
        this.explicitFiles.add(normalized);
    }
    collectAncestors(fsPath) {
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
    shouldInclude(fsPath, isDir, parentAllowsAll) {
        if (!this.addedPaths.has(fsPath) && this.isExcludedPath(fsPath)) {
            return false;
        }
        if (parentAllowsAll) {
            return true;
        }
        const inManual = this.isWithinManualFolder(fsPath);
        const inMatchedRoot = this.isWithinMatchedRoot(fsPath);
        if (inManual) {
            return true;
        }
        if (inMatchedRoot) {
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
    isWithinManualFolder(candidate) {
        for (const folder of this.manualFolders) {
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
    isWithinMatchedRoot(candidate) {
        for (const root of this.matchedRoots) {
            if (candidate === root) {
                return true;
            }
            const relative = path.relative(root, candidate);
            if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
                return true;
            }
        }
        return false;
    }
    normalize(fsPath) {
        return path.normalize(fsPath);
    }
    loadExcludes() {
        const filesExclude = vscode.workspace.getConfiguration('files').get('exclude') ?? {};
        const searchExclude = vscode.workspace.getConfiguration('search').get('exclude') ?? {};
        const patterns = new Set();
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
    registerConfigurationListeners() {
        const disposable = vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('files.exclude') || event.affectsConfiguration('search.exclude')) {
                this.loadExcludes();
                void this.refresh();
            }
        });
        this.context.subscriptions.push(disposable);
    }
    isHiddenName(name) {
        return name.startsWith('.');
    }
    isHiddenPath(fsPath) {
        return this.normalize(fsPath)
            .split(path.sep)
            .some((segment) => this.isHiddenName(segment));
    }
    isExcludedPath(fsPath) {
        const rel = this.toWorkspaceRelative(fsPath);
        if (rel === undefined) {
            return false;
        }
        return this.excludePatterns.some((pattern) => (0, minimatch_1.minimatch)(rel, pattern, { dot: true }));
    }
    toWorkspaceRelative(fsPath) {
        const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fsPath));
        if (!folder) {
            return undefined;
        }
        const rel = path.relative(folder.uri.fsPath, fsPath);
        return rel.split(path.sep).join('/');
    }
    parseFilters(input) {
        if (!input) {
            return [];
        }
        const parts = Array.isArray(input) ? input : input.split(/[,\s]+/);
        return parts.map((p) => p.trim()).filter(Boolean);
    }
    async findNode(uri) {
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
        let lastNode;
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
    async expandNodesRecursive(nodes) {
        for (const node of nodes) {
            if (!node.isDirectory) {
                continue;
            }
            try {
                await this.view?.reveal(node, { expand: true, focus: false, select: false });
                this.markExpanded(node);
            }
            catch {
                // Ignore reveal errors that can happen if the tree updates while revealing.
            }
            const children = await this.getChildren(node);
            await this.expandNodesRecursive(children);
        }
    }
    async getDirectoryChildren(uri, parentDepth, parentAllowsAll) {
        try {
            const entries = await vscode.workspace.fs.readDirectory(uri);
            const children = [];
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
                const allowAllDescendants = parentAllowsAll || this.isWithinManualFolder(childPath) || this.isWithinMatchedRoot(childPath);
                children.push(this.createNode(childUri, isDir, parentDepth + 1, allowAllDescendants));
            }
            return this.sortNodes(children);
        }
        catch (error) {
            vscode.window.showErrorMessage(`Unable to read ${uri.fsPath}`);
            return [];
        }
    }
    sortNodes(nodes) {
        return nodes.sort((a, b) => {
            if (a.isDirectory === b.isDirectory) {
                return a.uri.fsPath.localeCompare(b.uri.fsPath);
            }
            return a.isDirectory ? -1 : 1;
        });
    }
    registerWatchers() {
        const watcher = vscode.workspace.createFileSystemWatcher('**/*');
        this.context.subscriptions.push(watcher, watcher.onDidCreate(() => this.scheduleRefreshOnFsChange()), watcher.onDidDelete(() => this.scheduleRefreshOnFsChange()), watcher.onDidChange(() => this.scheduleRefreshOnFsChange()), vscode.workspace.onDidRenameFiles(() => this.scheduleRefreshOnFsChange()));
    }
    scheduleRefreshOnFsChange() {
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
    shouldAutoRefreshOnFsChange() {
        return this.filters.length > 0 || this.addedPaths.size > 0;
    }
    loadPersistedConfigs() {
        const configs = this.context.workspaceState.get(CONFIG_KEY, []);
        this.configs = configs ?? [];
        this.activeConfigName = this.context.workspaceState.get(ACTIVE_KEY);
        const activeConfig = this.configs.find((c) => c.name === this.activeConfigName);
        if (activeConfig) {
            void this.applyConfig(activeConfig);
        }
    }
    async persistConfigs() {
        await this.context.workspaceState.update(CONFIG_KEY, this.configs);
        await this.context.workspaceState.update(ACTIVE_KEY, this.activeConfigName);
    }
    async applyConfig(config) {
        this.filters = this.parseFilters(config.filters ?? config.filter);
        this.exactMatch = config.exactMatch;
        this.addedPaths = new Set(config.paths.map((p) => this.normalize(p)));
        this.activeConfigName = config.name;
        await this.context.workspaceState.update(ACTIVE_KEY, this.activeConfigName);
        this.updateViewTitle();
        await this.refresh();
    }
    updateViewTitle() {
        if (!this.view) {
            return;
        }
        this.view.title = this.activeConfigName ? `Feature Scope (${this.activeConfigName})` : 'Feature Scope';
        const filterLabel = this.filters.length > 0 ? this.filters.join(', ') : 'No filters';
        const matchLabel = this.exactMatch ? 'Exact' : 'Contains';
        this.view.description = `${matchLabel} • ${filterLabel}`;
    }
    async autoSaveActiveConfig() {
        if (!this.activeConfigName) {
            return;
        }
        const updated = {
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
exports.FeatureScopeProvider = FeatureScopeProvider;
//# sourceMappingURL=FeatureScopeProvider.js.map