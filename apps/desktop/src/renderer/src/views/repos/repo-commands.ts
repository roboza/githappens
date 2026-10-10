import { FolderOpen, ListFilter, Search, Terminal } from 'lucide-react';

import { registerCommands } from '../../commands/registry';
import type { CommandDef } from '../../commands/types';
import { useTabsStore } from '../../stores/tabs';
import { openSparseDialog } from '../sparse/SparseCheckout';
import { installCliCommand } from './cli-install';
import { browseAndOpen, openRepoWithRecovery } from './open-flow';

/** Show (or create) the Repository Management tab. */
function showRepoManagement(): void {
  const tabs = useTabsStore.getState();
  const existing = tabs.tabs.find((t) => t.kind === 'newTab' || t.kind === 'repoManagement');
  if (existing) tabs.activate(existing.id);
  else tabs.newTab();
}

/**
 * Spec 03 commands: RM search focus, CLI install, sparse checkout, and `repo.open` with the
 * "Initialize here?" / safe.directory recovery flows (shadows the plain registration).
 */
export function installRepoCommands(): () => void {
  const commands: CommandDef[] = [
    {
      id: 'repo.open',
      title: 'Open Repo',
      category: 'Repo',
      icon: FolderOpen,
      arg: { kind: 'repo', placeholder: 'Recent repository, or Enter to browse…' },
      keybinding: { win: 'Ctrl+Shift+O', mac: 'Cmd+Shift+O' },
      run: (_ctx, arg) => void (arg ? openRepoWithRecovery(arg) : browseAndOpen()),
    },
    {
      id: 'repoMgmt.focusSearch',
      title: 'Repo Management: Search Repositories',
      category: 'Repo',
      icon: Search,
      keybinding: { win: 'Ctrl+Alt+F', mac: 'Cmd+Option+F' },
      run: () => {
        showRepoManagement();
        setTimeout(() => window.dispatchEvent(new Event('kl:repo-mgmt-search')), 50);
      },
    },
    {
      id: 'app.installCli',
      title: 'Install "githappens" Command in PATH',
      category: 'Core',
      icon: Terminal,
      keywords: ['cli', 'shell command', 'terminal', 'path', 'launcher'],
      run: () => void installCliCommand(),
    },
    {
      id: 'repo.sparseCheckout',
      title: 'Sparse Checkout…',
      category: 'Repo',
      icon: ListFilter,
      keywords: ['sparse', 'cone', 'monorepo', 'partial'],
      when: (c) => !!c.activeRepo,
      whenReason: (c) => (c.activeRepo ? undefined : 'Open a repository first'),
      run: (c) => {
        if (c.activeRepo) openSparseDialog(c.activeRepo);
      },
    },
  ];
  return registerCommands(commands);
}
