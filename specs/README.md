# GitHappens specs

This folder holds the implementation specs for **GitHappens**, a cross-platform desktop Git GUI (Electron, React, git CLI). Each spec describes one feature area: reference behavior, user stories, UI, data model and IPC, git commands, an ordered implementation plan, edge cases and acceptance criteria. Authors wrote the specs in parallel, and a consistency pass then added a "Cross-spec dependencies" section to most of them.

## How to read

1. **Start with [`00-overview.md`](00-overview.md).** It records the binding decisions: tech stack, process architecture, repo layout, the **git version policy** (bundled ≥ 2.38, system ≥ 2.36) and the **reserved ref namespace** `refs/githappens/*`.
2. **Then read the roadmap in [`15-packaging-testing-roadmap.md`](15-packaging-testing-roadmap.md) §8.** It sets the build order (Phases 0–6) and says which specs each phase needs.
3. **Read [`02-git-engine.md`](02-git-engine.md) before any feature spec.** Its IPC contract (§5.3, `git:*` channels), core types (§5.1) and `GitOperation`/`OperationMeta` model (§5.5) are authoritative. Feature specs that define domain channels (`branch:*`, `wip:*`, `diff:*`, `conflict:*`, `graph:*` …) include a "Mapping to the spec 02 contract" note explaining how they sit on top.
4. Each spec's final section, **"Cross-spec dependencies"**, lists what it needs from or provides to the other specs.

## Spec index

| # | Spec | Summary | Lines |
|---|---|---|---|
| 00 | [00-overview.md](00-overview.md) | Goal, binding technology decisions, process architecture, code layout, git version policy, reserved ref namespace, spec template, glossary | 118 |
| 01 | [01-app-shell-and-layout.md](01-app-shell-and-layout.md) | Window, repo tabs, toolbar, left/right panels, status bar, command palette, default shortcuts, menus, toasts | 406 |
| 02 | [02-git-engine.md](02-git-engine.md) | GitService, git executable selection and env, typed IPC contract, parsers, askpass bridge, OperationQueue, RepoWatcher, error taxonomy, huge-repo performance | 754 |
| 03 | [03-repository-management.md](03-repository-management.md) | Open/clone/init (shallow, sparse, templates), recents/favorites, Repository Management view, CLI and single-instance | 281 |
| 04 | [04-commit-graph.md](04-commit-graph.md) | Graph data model, lane layout worker, canvas rendering, virtualization, ref pills, selection, context menus, drag sources, search/filter display | 873 |
| 05 | [05-branching-and-operations.md](05-branching-and-operations.md) | Branch/tag ops, checkout, drag-and-drop matrix, merge/rebase/interactive rebase, cherry-pick/revert/reset, stash, undo/redo journal, Git Flow commands | 538 |
| 06 | [06-staging-and-committing.md](06-staging-and-committing.md) | WIP node, staging lists, file/hunk/line staging and discard, ignore, commit composer, amend, hooks output, signing, templates | 457 |
| 07 | [07-diff-and-file-views.md](07-diff-and-file-views.md) | Commit detail panel, Monaco diff modes, image/binary/LFS/submodule diffs, file history, blame, in-app editor, external diff tools | 500 |
| 08 | [08-merge-conflict-tool.md](08-merge-conflict-tool.md) | Conflict detection, 3-way merge tool, special conflict types, auto-resolve, external merge tools, merge-tree conflict prediction | 475 |
| 09 | [09-remotes-and-sync.md](09-remotes-and-sync.md) | Remotes, fetch/pull/push, auto-fetch, HTTPS credentials and askpass, SSH, LFS, submodules, worktrees, proxy and CA, hooks | 474 |
| 10 | [10-integrations.md](10-integrations.md) | OAuth/PAT AuthService, provider abstraction (GitHub/GitLab/Bitbucket/Azure), PRs, issues (incl. Jira/Trello), avatars, web links, optional CI section | 793 |
| 11 | [11-workspaces-and-launchpad.md](11-workspaces-and-launchpad.md) | Multi-repo workspaces, bulk ops, Launchpad PR/issue/WIP aggregation and grouping rules | 465 |
| 12 | [12-productivity-and-ai.md](12-productivity-and-ai.md) | Integrated terminal, git autocomplete, AI features (default Anthropic), search query syntax, palette/file finder, Git Flow UI, Open in…, Agent Sessions view | 481 |
| 13 | [13-preferences-profiles-themes.md](13-preferences-profiles-themes.md) | Preferences UI and settings schema, profiles, SSH/signing/network settings, JSONC themes, keybindings, repo-specific settings, SecretStore naming | 460 |
| 14 | [14-cloud-and-team-features.md](14-cloud-and-team-features.md) | Optional backend: account and settings sync, Cloud Patches, Code Suggest, team view, insights; backend-free conflict prevention | 489 |
| 15 | [15-packaging-testing-roadmap.md](15-packaging-testing-roadmap.md) | Monorepo tooling, bundled git, electron-builder targets, auto-update, CI, testing strategy, phased roadmap | 200 |

## Feature folders

Larger features that span several areas get their own folder with a README and numbered files.

| Folder | Feature | Status |
|---|---|---|
| [hive/](hive/README.md) | **Hive**: run and supervise several AI coding agents in parallel, each in its own worktree lane, with live status, review and landing, task intake, coordination and a graph lens. Supersedes the Agent Sessions view (spec 12 §4.12). Includes a competitive landscape and gap analysis ([00-landscape-and-gaps.md](hive/00-landscape-and-gaps.md)). | Draft spec (README + 01–11), open questions in the README |
| [spyglass/](spyglass/) | **Spyglass**: VS Code extension (inline blame, hovers, annotations, history, side-bar views, graph panel) that hands off to the GitHappens app | Paused, partial (01–03) |

## Open decisions and items to verify

These are items marked *(inferred)* or flagged as our own extensions that most need a human decision or verification against provider documentation:

1. **Custom theme JSONC key names (spec 13 §5.3).** The token names (`root`, `toolbar`, `tabsbar`, `app__bg0`, …) are reconstructed from community themes, not verified. Decide whether to keep these names or define our own token set.
2. **Keybinding rebinding (spec 13, spec 01 §4.9)** is our extension. Confirm scope and conflict rules with OS-reserved shortcuts.
3. **LFS file locking (spec 09 §6.8)** is our extension. Confirm it belongs in 1.0 or should move later.
4. **Full-stack undo/redo (spec 05 §4.7, §6.11)** is our extension: undo is not limited to the most recent supported action, and merge, `revert-hunk`, `mark-resolved` and `patch-apply` entries (spec 05 §11) are undoable too.
5. **Agent Sessions view (spec 12 §4.12)** is inferred. Process-based agent detection and status heuristics need validation, and it's optional in Phase 5.
6. **WIP node per linked worktree (spec 04 §11, spec 09 §6.10):** placement, the cap of 20 worktrees and the 30 s refresh are our choices.
7. **Commit-graph maintenance (spec 02 §6.15.1):** we write `commit-graph` automatically in the background (setting `graph.maintainCommitGraph`, default on, more than 10k commits). An earlier draft prompted once at 50k commits. Confirm that silent background writes into users' `.git` are acceptable.
8. **Bitbucket Cloud HTTPS username for Atlassian API tokens (spec 09 §11, spec 10 §6.1)**, and the Bitbucket OAuth scope names. Verify against current Atlassian docs at build time.
9. **GitHub Actions/CI section (spec 10 §4.8):** It is optional and hidden by default. Decide whether to keep it at all.
10. **Pull strategy values (spec 09 `PullStrategy`, spec 13 `git.pullMode`):** `merge-no-ff` is our extra, and the earlier `fetchOnly` default mode was dropped (Fetch All stays a dropdown action).
11. **Interactive rebase including the root commit and `--rebase-merges`** (spec 05) are behind flags.
12. **Image diff swipe/onion/difference modes, the "Changes" column, and merge-tool base pane** (specs 07, 04, 08) are our additions. Confirm priority.
13. **Search query prefixes (spec 12 §11):** `@`, `#`, `file:`, `~`, `=`, `/re/` are our own syntax.
14. **App-generated SSH key default path (spec 09 §6.7 `userData/ssh/<profile>/` vs spec 10 `~/.ssh/githappens_<kind>_ed25519`):** both are allowed today. Choose one default.

## Legal note

This is a **clean-room behavioral specification**. These specs describe observable behavior (which is not copyrightable) in our own words, based on public documentation and release notes. They contain no third-party source code, assets or copied documentation text. The product ships under its own name (GitHappens), logo, icons and artwork, and must not imply affiliation with any other Git client or its vendor. See also spec 15 §12.
