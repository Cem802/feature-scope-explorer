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
    targetFolders = new Set();
    explicitFiles = new Set();
    ancestors = new Set();
    view;
    changeEmitter = new vscode.EventEmitter();
    onDidChangeTreeData = this.changeEmitter.event;
    constructor(context) {
        this.context = context;
        this.loadPersistedConfigs();
        this.registerWatchers();
    }
    setTreeView(view) {
        this.view = view;
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
        this.targetFolders.clear();
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
        this.targetFolders.clear();
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
        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            vscode.window.showInformationMessage('Open folder first to use Feature Scope Explorer.');
            this.changeEmitter.fire();
            return;
        }
        await this.calculateScope();
        this.changeEmitter.fire();
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
    createNode(uri, isDirectory, depth, allowChildren = false) {
        return { uri, isDirectory, allowChildren, depth };
    }
    async calculateScope() {
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
            const matched = this.filters.some((filter) => this.exactMatch ? lower === filter.toLowerCase() : lower.includes(filter.toLowerCase()));
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
    addTrackedPath(fsPath) {
        const normalized = this.normalize(fsPath);
        this.addedPaths.add(normalized);
        this.addPathToSets(normalized);
    }
    addPathToSets(fsPath) {
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
    isWithinTarget(candidate) {
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
    normalize(fsPath) {
        return path.normalize(fsPath);
    }
    isHiddenName(name) {
        return name.startsWith('.');
    }
    isHiddenPath(fsPath) {
        return this.normalize(fsPath)
            .split(path.sep)
            .some((segment) => this.isHiddenName(segment));
    }
    parseFilters(input) {
        if (!input) {
            return [];
        }
        const parts = Array.isArray(input) ? input : input.split(/[,\s]+/);
        return parts.map((p) => p.trim()).filter(Boolean);
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
                if (hidden && !this.addedPaths.has(childPath)) {
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