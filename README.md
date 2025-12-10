# FeatureScope Explorer

FeatureScope Explorer is a VS Code extension that surfaces only the files and folders relevant to the feature you are working on. It adds a dedicated **Feature Scope** tree inside the Explorer that can be filtered, saved as named configs, and quickly refreshed when working inside large monorepos.

## Features
- Custom Explorer tree powered by the VS Code `TreeDataProvider` API (view id: `featureScope`).
- Path-based filtering with case-insensitive substring search or exact folder-name matching.
- Quick command (Ctrl+Shift+F / Cmd+Shift+F) to add the active file’s hierarchy to the tree.
- Named, savable configs stored in workspace state (new, load, save, delete) with auto-save of the active config.
- Context menu actions to reveal folders in the built-in Explorer or open files directly.
- Drag-and-drop URIs into the view to track additional paths.

## Commands
- **Feature Scope: Refresh** (`featureScope.refresh`)
- **Feature Scope: Set Filter** (`featureScope.setFilter`)
- **Feature Scope: Clear Filter** (`featureScope.clearFilter`)
- **Feature Scope: Toggle Exact Folder Match** (`featureScope.toggleExactMatch`)
- **Feature Scope: Add Current File** (`featureScope.addCurrentFile`, Ctrl+Shift+F / Cmd+Shift+F)
- **Feature Scope: New Config** (`featureScope.newConfig`)
- **Feature Scope: Load Config** (`featureScope.loadConfig`)
- **Feature Scope: Save Current Config** (`featureScope.saveCurrent`)
- **Feature Scope: Delete Config** (`featureScope.deleteConfig`)
- **Reveal in Explorer** (`featureScope.reveal`)
- **Open File** (`featureScope.open`)

## Using the tree
1. Open a workspace. The Feature Scope view appears in the Explorer sidebar.
2. Run **Feature Scope: Set Filter** and enter a term (e.g., `feature`, `care_assistant`). All folders/files whose path contains the term appear, and matched folders expand to show their full subtree. Use **Toggle Exact Folder Match** to switch to folder-name-only matching.
3. Press **Ctrl+Shift+F** (Cmd+Shift+F on macOS) to add the current file’s ancestry into the view.
4. Save the current filter/paths with **Save Current Config**, load them later with **Load Config**, or manage sets via **New Config** / **Delete Config**. The active config name is shown in the view title.
5. Use the toolbar buttons (refresh, clear filter, load config, new config) for quick access. Right-click nodes to reveal them in the main Explorer or open files directly.

## Development
- Run `npm install` then `npm run watch` or `npm run compile` to build the extension.
- Press `F5` in VS Code to launch the extension development host.

The extension skips `.git` folders, supports multi-root workspaces, and debounces heavy refresh work by scoping results to the paths you choose.
