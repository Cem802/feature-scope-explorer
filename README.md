# FeatureScope Explorer

FeatureScope Explorer is a VS Code extension that surfaces only the files and folders relevant to the feature you are working on. It adds a dedicated **Feature Scope** tree inside the Explorer that can be filtered, saved as named configs, and quickly refreshed when working inside large monorepos.

## Features
- Custom Explorer tree powered by the VS Code `TreeDataProvider` API (view id: `featureScope`).
- Multiple filters at once (comma/space separated) with substring or exact folder-name matching; view description shows match mode and filters.
- Quick command (Ctrl+Shift+F / Cmd+Shift+F) to add the active file’s hierarchy to the tree; right-click any folder in the normal Explorer to “Add Folder to Feature Scope.”
- Named, savable configs stored in workspace state (new, load, save, delete) with auto-save of the active config.
- Honors `files.exclude` and `search.exclude`, skips dotfiles unless explicitly added, and ignores `.git`.
- Auto-refresh on file system changes when filters or added paths are set; drag-and-drop URIs into the view to track additional paths.

## Commands
- **Feature Scope: Refresh** (`featureScope.refresh`) — command palette only
- **Feature Scope: Set Filter** (`featureScope.setFilter`)
- **Feature Scope: Clear Filter** (`featureScope.clearFilter`)
- **Feature Scope: Clear Filter and Added Items** (`featureScope.clearAll`)
- **Feature Scope: Toggle Exact Folder Match** (`featureScope.toggleExactMatch`)
- **Feature Scope: Add Current File** (`featureScope.addCurrentFile`, Ctrl+Shift+F / Cmd+Shift+F)
- **Feature Scope: Add Folder** (`featureScope.addFolder`) — via Explorer context menu
- **Feature Scope: New Config** (`featureScope.newConfig`)
- **Feature Scope: Load Config** (`featureScope.loadConfig`)
- **Feature Scope: Save Current Config** (`featureScope.saveCurrent`)
- **Feature Scope: Delete Config** (`featureScope.deleteConfig`)
- **Reveal in Explorer** (`featureScope.reveal`)

## Using the tree
1. Open a workspace. The Feature Scope view appears in the Explorer sidebar.
2. Run **Feature Scope: Set Filter** and enter one or more terms (comma/space separated). Matched folders expand to show their full subtree. Use **Toggle Exact Folder Match** to switch to folder-name-only matching.
3. Press **Ctrl+Shift+F** (Cmd+Shift+F on macOS) to add the current file’s ancestry into the view. Right-click any folder in the standard Explorer and choose **Add Folder** to pin it.
4. Save the current filter/paths with **Save Current Config**, load them later with **Load Config**, or manage sets via **New Config** / **Delete Config**. The active config name is shown in the view title; the description shows match mode and filters.
5. Toolbar icons: clear filter, clear all, set filter, toggle exact, new config (blank slate), save, load, delete. Right-click nodes to reveal them in the main Explorer; click files to open.