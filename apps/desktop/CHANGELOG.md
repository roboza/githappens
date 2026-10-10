# Changelog

All notable changes to GitHappens are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). Each `## [x.y.z]` section is shown in-app as
"What's new" after updating to that version.

## [Unreleased]

## [0.1.0] - 2026-10-09

First beta: everything from Phases 0–3 of the roadmap.

### Foundations

- Cross-platform Electron app (Windows, macOS, Linux) built with React and TypeScript.
- Bundled portable Git; falls back to system Git (2.36+) or a custom path.
- Typed, allowlisted IPC between the UI and the Git engine; Git errors are mapped to clear messages.
- Settings and an encrypted secret store backed by the OS keychain.

### Viewing history

- Open repositories in tabs, with recent and favorite repos.
- Commit graph with lanes, ref labels, search/filter and **Jump to HEAD**, virtualized for very large repos.
- Commit details, file lists and a Monaco diff viewer (unified or split, per hunk).
- Automatic refresh when the repository changes on disk.

### Everyday Git

- WIP node and staging panel: stage, unstage and discard by file, hunk or line; ignore files.
- Commit composer with amend and hook output.
- Branches and tags: create, check out, rename, delete.
- Fetch, pull and push with credential prompts, SSH agent support, upstream setup and ahead/behind counts.
- Stash save, apply, pop and drop.
- Clone and init.
- Undo / redo for core actions.
- Command palette and keyboard shortcuts.

### Power operations

- Drag and drop branches to merge, rebase, fast-forward or push.
- Cherry-pick, revert and reset (soft / mixed / hard).
- Built-in 3-way merge tool, external merge tools, and local conflict prediction with `git merge-tree`.
- Interactive rebase editor.
- File history, blame and an in-app editor.
- Submodules, worktrees and Git LFS.
- Integrated terminal.
- Full Preferences UI with profiles, themes and custom keybindings.

### Packaging

- Installers for Windows (NSIS, x64 and arm64) and macOS (DMG / zip, notarized), and AppImage, deb, rpm and tar.gz for Linux.
- Automatic updates with **Stable** and **Preview** channels (Preferences › General › Updates). deb, rpm and tar.gz installs show a download link instead.
- This "What's new" view, shown once after each update.
