import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { PrefsEventContract, PrefsIpcContract } from '../../shared/ipc/prefs-contract';
import { signingGitConfig, type GitConfigEntry } from '../../shared/settings/git-config';
import { settingsJsonSchema } from '../../shared/settings/registry';
import {
  defaultAllowedSignersFile,
  expandHome,
  gitSupportsSshSigning,
  resolveSshPublicKey,
  writeAllowedSigners,
} from '../gpg/allowed-signers';
import { GpgService } from '../gpg/gpg';
import { execGit, type RepoGitRun } from '../repo-settings/repo-git-config';
import type { SecretStore } from '../secrets/secret-store';
import { applySettingsBundle, buildSettingsBundle, parseSettingsBundle } from '../settings/settings-bundle';
import type { SettingsStore } from '../settings/settings-store';
import { ThemeService } from '../settings/theme-service';
import type { HandlerContext } from './registry';
import { createRepoSettingsHandlers } from './repo-settings-handlers';

/**
 * Preferences IPC handlers (spec 13 §5.4): profiles, themes, keybindings, settings file helpers.
 * Merged into the main `IpcHandlers` map by `main/index.ts`.
 */
export interface PrefsHandlerDeps {
  settings: SettingsStore;
  /** `app.getPath('userData')`; themes live in `<userData>/themes`. */
  userDataDir: string;
  secrets: Pick<SecretStore, 'deleteByPrefix'>;
  broadcast<E extends keyof PrefsEventContract>(event: E, payload: PrefsEventContract[E]): void;
  /** `git config --global user.name/user.email` (profile identity sync). */
  setGlobalIdentity(name: string, email: string): void | Promise<void>;
  /** Write (or unset when `value === null`) git config keys; `repoPath` is set for `local`. */
  writeGitConfig(
    entries: GitConfigEntry[],
    scope: 'global' | 'local',
    repoPath?: string,
  ): void | Promise<void>;
  /** Open a file or folder with the OS default application (Electron `shell.openPath`). */
  openPath(p: string): void | Promise<unknown>;
  /** Native open dialog. */
  pickPath(opts: {
    kind: 'file' | 'directory';
    title?: string;
    defaultPath?: string;
  }): Promise<string | null>;
  /** Injectable for tests; defaults to a watched ThemeService on `<userData>/themes`. */
  themes?: ThemeService;
  /**
   * utf8 git runner for `gitconfig:*` / `repoSettings:*` and the SSH-signing version gate
   * (`createGitConfigWriter(...).runGit`). Defaults to the system `git` on PATH.
   */
  runGit?: RepoGitRun;
  /** Native save dialog for `prefs:export`; without it the bundle goes to `~/Downloads` (or userData). */
  pickSavePath?(opts: { title?: string; defaultName: string }): Promise<string | null>;
  /** Home directory (`~/.ssh/allowed_signers`); injectable for tests. */
  homeDir?: string;
  /** Injectable for tests; defaults to a GpgService using `signing.gpgProgram`. */
  gpg?: GpgService;
  /** Watch settings.json / app.json for external edits (default: on unless `themes` is injected). */
  watchSettings?: boolean;
  log?: (message: string) => void;
}

export type PrefsHandlers = {
  [K in keyof PrefsIpcContract]: (
    req: PrefsIpcContract[K]['req'],
    ctx: HandlerContext,
  ) => PrefsIpcContract[K]['res'] | Promise<PrefsIpcContract[K]['res']>;
};

export function createPrefsHandlers(d: PrefsHandlerDeps): PrefsHandlers {
  const { settings } = d;

  settings.setHooks({
    onProfileDeleted: (id) => void d.secrets.deleteByPrefix(`${id}/`),
    setGlobalIdentity: (name, email) => d.setGlobalIdentity(name, email),
  });
  settings.on('profilesChanged', (state) => d.broadcast('profiles:changed', state));
  settings.on('profileSwitched', (meta) => {
    d.broadcast('profiles:switched', meta);
    d.broadcast('keybindings:changed', settings.readKeybindings());
  });

  const themes =
    d.themes ??
    new ThemeService({
      dir: path.join(d.userDataDir, 'themes'),
      onChanged: (ids) => d.broadcast('themes:changed', { ids }),
      log: d.log,
    });
  if (!d.themes) {
    themes.ensureTemplates();
    themes.watch();
  }
  if (d.watchSettings ?? !d.themes) settings.watch();

  const runGit = d.runGit ?? execGit;
  const homeDir = d.homeDir ?? os.homedir();
  const gpg = d.gpg ?? new GpgService(() => settings.get('signing.gpgProgram') || undefined);

  const documentSchema = (): Record<string, unknown> => ({
    type: 'object',
    properties: {
      version: { type: 'integer', description: 'Settings file format version.' },
      values: settingsJsonSchema(),
    },
    required: ['values'],
  });

  const exportTarget = async (): Promise<string | null> => {
    const stamp = new Date().toISOString().slice(0, 10);
    const defaultName = `githappens-settings-${stamp}.json`;
    if (d.pickSavePath) return d.pickSavePath({ title: 'Export settings', defaultName });
    const downloads = path.join(homeDir, 'Downloads');
    const dir = fs.existsSync(downloads) ? downloads : path.join(d.userDataDir, 'exports');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, defaultName);
  };

  const ensureFile = (file: string, content: string): string => {
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    return file;
  };

  return {
    ...createRepoSettingsHandlers({
      profileDir: () => settings.profileDir(),
      run: runGit,
      broadcast: (e, p) => d.broadcast(e, p),
    }),

    // ---- profiles ----
    'profiles:list': () => settings.profilesState(),
    'profiles:create': (req) => settings.createProfile(req),
    'profiles:update': ({ id, patch }) => settings.updateProfile(id, patch),
    'profiles:delete': ({ id }) => settings.deleteProfile(id),
    'profiles:switch': ({ id }) => settings.switchProfile(id),
    'profiles:setDefault': ({ id }) => settings.setDefaultProfile(id),

    // ---- themes ----
    'themes:list': () => themes.list(),
    'themes:get': ({ id }) => themes.get(id),
    'themes:openFolder': async () => {
      fs.mkdirSync(themes.dir, { recursive: true });
      await d.openPath(themes.dir);
    },
    'themes:createFromCurrent': async ({ baseId, name }) => {
      const r = themes.createFromCurrent(baseId, name);
      await d.openPath(r.file);
      return r;
    },
    'themes:reload': () => {
      themes.invalidate();
      return themes.list();
    },

    // ---- keybindings ----
    'keybindings:get': () => settings.readKeybindings(),
    'keybindings:set': ({ overrides }) => {
      const saved = settings.writeKeybindings(overrides);
      d.broadcast('keybindings:changed', saved);
      return saved;
    },
    'keybindings:openJson': async () => {
      await d.openPath(ensureFile(path.join(settings.profileDir(), 'keybindings.json'), '[]\n'));
    },

    // ---- settings file / pickers ----
    'settings:openJson': async () => {
      await d.openPath(
        ensureFile(
          path.join(settings.profileDir(), 'settings.json'),
          `${JSON.stringify({ version: 1, values: {} }, null, 2)}\n`,
        ),
      );
    },
    'prefs:pickPath': (req) => d.pickPath(req),

    // ---- commit signing ----
    'signing:apply': async ({ repoPath }) => {
      const scope = settings.get('signing.writeScope');
      if (scope === 'local' && !repoPath) {
        throw new Error('Open a repository to write signing settings to its .git/config.');
      }
      const entries = signingGitConfig({
        'signing.format': settings.get('signing.format'),
        'signing.gpgProgram': settings.get('signing.gpgProgram'),
        'signing.signingKey': settings.get('signing.signingKey'),
        'signing.allowedSignersFile': settings.get('signing.allowedSignersFile'),
        'signing.signCommits': settings.get('signing.signCommits'),
        'signing.signTags': settings.get('signing.signTags'),
      });
      if (
        (settings.get('signing.signCommits') || settings.get('signing.signTags')) &&
        !settings.get('signing.signingKey').trim()
      ) {
        throw new Error('Choose a signing key before enabling signing by default.');
      }
      if (settings.get('signing.format') === 'ssh') {
        const v = await runGit({ cwd: homeDir, args: ['version'] }).catch(() => null);
        if (v && !gitSupportsSshSigning(v.stdout)) {
          throw new Error(`SSH signing needs Git 2.34 or newer (found ${v.stdout.trim()}).`);
        }
      }
      await d.writeGitConfig(entries, scope, scope === 'local' ? repoPath : undefined);
      return entries;
    },
    'signing:allowedSigners': (req) => {
      const email = (req.email ?? settings.activeProfile.authorEmail).trim();
      if (!email) throw new Error('Set an author email in your profile first.');
      const key = resolveSshPublicKey(req.key ?? settings.get('signing.signingKey'), homeDir);
      const configured = settings.get('signing.allowedSignersFile').trim();
      const file = req.file?.trim()
        ? expandHome(req.file.trim(), homeDir)
        : configured
          ? expandHome(configured, homeDir)
          : defaultAllowedSignersFile(homeDir);
      if (!path.isAbsolute(file)) throw new Error('The allowed signers file must be an absolute path.');
      const r = writeAllowedSigners({ file, email, key });
      if (!configured) settings.set('signing.allowedSignersFile', file);
      return r;
    },

    // ---- GPG ----
    'gpg:detect': () => gpg.detect(true),
    'gpg:listKeys': ({ program }) => gpg.listKeys(program),
    'gpg:generateKey': (req) => gpg.generateKey(req),
    'gpg:exportPublic': ({ keyId }) => gpg.exportPublic(keyId),

    // ---- settings.json editor / export / import ----
    'settings:readJson': () => ({
      path: settings.settingsFilePath(),
      text: settings.readProfileJson(),
      schema: documentSchema(),
      readOnly: !!settings.readOnlyReason,
      readOnlyReason: settings.readOnlyReason ?? undefined,
    }),
    'settings:writeJson': ({ text }) => {
      if (typeof text !== 'string' || text.length > 2 * 1024 * 1024) {
        return { ok: false, problems: [{ message: 'The document is too large.' }] };
      }
      const problems = settings.applyProfileJson(text);
      return { ok: problems.length === 0, problems };
    },
    'settings:status': () => ({
      readOnly: !!settings.readOnlyReason,
      readOnlyReason: settings.readOnlyReason ?? undefined,
      file: settings.settingsFilePath(),
      version: settings.fileVersion,
    }),
    'prefs:export': async () => {
      const file = await exportTarget();
      if (!file) return null;
      const { bundle, omitted } = buildSettingsBundle(settings, themes.dir);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`);
      return {
        file,
        settings: Object.keys(bundle.settings).length,
        keybindings: bundle.keybindings.length,
        themes: bundle.themes.length,
        omitted,
      };
    },
    'prefs:import': async ({ file: given }) => {
      const file =
        given ?? (await d.pickPath({ kind: 'file', title: 'Import settings', defaultPath: homeDir }));
      if (!file) return null;
      const st = fs.statSync(file);
      if (!st.isFile() || st.size > 5 * 1024 * 1024)
        throw new Error('Choose a settings export (.json) file.');
      const bundle = parseSettingsBundle(fs.readFileSync(file, 'utf8'));
      fs.mkdirSync(themes.dir, { recursive: true });
      const r = applySettingsBundle(settings, themes.dir, bundle, file);
      if (r.themes.length) {
        themes.invalidate();
        d.broadcast('themes:changed', { ids: r.themes.map((f) => `user:${f.replace(/\.jsonc$/i, '')}`) });
      }
      if (r.keybindings) d.broadcast('keybindings:changed', settings.readKeybindings());
      return r;
    },
  };
}
