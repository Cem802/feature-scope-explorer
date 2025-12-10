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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const FeatureScopeProvider_1 = require("./FeatureScopeProvider");
function activate(context) {
    const provider = new FeatureScopeProvider_1.FeatureScopeProvider(context);
    const treeView = vscode.window.createTreeView('featureScope', {
        treeDataProvider: provider,
        showCollapseAll: true,
        dragAndDropController: provider,
    });
    provider.setTreeView(treeView);
    registerCommands(context, provider, treeView);
    provider.refresh();
}
function deactivate() {
    // Nothing to clean up.
}
function registerCommands(context, provider, treeView) {
    context.subscriptions.push(treeView);
    context.subscriptions.push(vscode.commands.registerCommand('featureScope.refresh', () => provider.refresh()), vscode.commands.registerCommand('featureScope.setFilter', async () => {
        const current = provider.getCurrentFilter();
        const value = await vscode.window.showInputBox({
            prompt: 'Filters (comma or space separated)',
            value: current,
        });
        if (value !== undefined) {
            provider.setFilter(value);
        }
    }), vscode.commands.registerCommand('featureScope.clearFilter', () => provider.clearFilter()), vscode.commands.registerCommand('featureScope.toggleExactMatch', () => provider.toggleExactMatch()), vscode.commands.registerCommand('featureScope.clearAll', () => provider.clearAll()), vscode.commands.registerCommand('featureScope.addCurrentFile', () => {
        const uri = vscode.window.activeTextEditor?.document.uri;
        provider.addCurrentFile(uri);
    }), vscode.commands.registerCommand('featureScope.addFolder', (nodeOrUri) => {
        if (nodeOrUri instanceof vscode.Uri) {
            provider.addFolder(nodeOrUri);
        }
        else {
            provider.addFolder(nodeOrUri);
        }
    }), vscode.commands.registerCommand('featureScope.newConfig', () => provider.newConfig()), vscode.commands.registerCommand('featureScope.loadConfig', () => provider.loadConfig()), vscode.commands.registerCommand('featureScope.saveCurrent', () => provider.saveCurrentConfig()), vscode.commands.registerCommand('featureScope.deleteConfig', () => provider.deleteConfig()), vscode.commands.registerCommand('featureScope.reveal', (node) => revealInExplorer(node)));
}
async function revealInExplorer(node) {
    if (!node) {
        return;
    }
    await vscode.commands.executeCommand('revealInExplorer', node.uri);
}
//# sourceMappingURL=extension.js.map