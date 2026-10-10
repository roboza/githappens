import { DownloadCloud, FileJson, FolderOpen, GitBranchPlus, Layers, PlugZap, Terminal } from 'lucide-react';
import type { ReactNode } from 'react';

import { BrandMark } from '../../components/BrandLogo';
import { importWorkspaceJson } from '../../workspaces/actions';
import { installCliCommand } from '../repos/cli-install';
import styles from './Welcome.module.css';

export interface WelcomeViewProps {
  onOpen(): void;
  onClone(): void;
  onInit(): void;
  onWorkspace(): void;
}

function Card(props: { icon: ReactNode; title: string; body: string; onClick(): void; primary?: boolean }) {
  return (
    <button
      type="button"
      className={`${styles.card} ${props.primary ? styles.primary : ''}`}
      onClick={props.onClick}
    >
      <span className={styles.cardIcon} aria-hidden>
        {props.icon}
      </span>
      <span className={styles.cardTitle}>{props.title}</span>
      <span className={styles.cardBody}>{props.body}</span>
    </button>
  );
}

const openIntegrations = (): void => {
  window.dispatchEvent(new CustomEvent('kl:open-preferences', { detail: 'Integrations' }));
};

/**
 * First-run screen (spec 03 §4.1 `<WelcomeView>`, §7 step 7): shown in Repository Management while there
 * are no recent repositories. Open / Clone / Init, connect an integration, import a workspace, and the
 * command-line tool.
 */
export function WelcomeView({ onOpen, onClone, onInit, onWorkspace }: WelcomeViewProps) {
  return (
    <div className={styles.welcome}>
      <BrandMark size={56} className={styles.logo} />
      <h1 className={styles.hero}>Welcome to GitHappens</h1>
      <p className={styles.lead}>
        Get a repository in to start. You can also drop a folder anywhere on this window.
      </p>
      <div className={styles.cards}>
        <Card
          primary
          icon={<FolderOpen size={22} />}
          title="Open a repository"
          body="Pick a folder that already contains a Git repository."
          onClick={onOpen}
        />
        <Card
          icon={<DownloadCloud size={22} />}
          title="Clone"
          body="Clone by URL or browse your GitHub, GitLab, Bitbucket and Azure repositories."
          onClick={onClone}
        />
        <Card
          icon={<GitBranchPlus size={22} />}
          title="Init"
          body="Start a new repository with README, .gitignore and LICENSE — locally or on a provider."
          onClick={onInit}
        />
      </div>
      <h2 className={styles.sub}>More ways to start</h2>
      <div className={styles.links}>
        <button type="button" onClick={openIntegrations}>
          <PlugZap size={15} /> Connect an integration
        </button>
        <button type="button" onClick={onWorkspace}>
          <Layers size={15} /> Create a workspace
        </button>
        <button type="button" onClick={() => void importWorkspaceJson()}>
          <FileJson size={15} /> Import a workspace…
        </button>
        <button type="button" onClick={() => void installCliCommand()}>
          <Terminal size={15} /> Install the <code>githappens</code> command
        </button>
      </div>
    </div>
  );
}
