import type { RemoteInfo, RepoId } from '@githappens/git/types';
import type { RemoteRepo } from '@githappens/providers/types';
import { useQuery } from '@tanstack/react-query';
import { GitFork } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Avatar } from '../../components/Avatar';
import { errorLine, intInvoke, openIntegrationsPreferences } from '../../integrations/api';
import { useResolvedRemotes } from '../../integrations/queries';
import { quiet, runOp } from '../../lib/ops';
import { useRemotes, useRepoInfo } from '../../repo/queries';
import { Field, FormDialog, formStyles as s } from './FormDialog';
import {
  forkChoices,
  parseShallowFlags,
  validateRemoteName,
  validateRemoteUrl,
  type ForkChoice,
} from './remote-model';

const PROVIDER_LABEL: Record<string, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
  'bitbucket-dc': 'Bitbucket DC',
  azure: 'Azure DevOps',
};

/**
 * Add / Edit Remote (spec 09 §4.3, spec 10 §4.3): URL tab (name, pull URL, optional push URL, shallow
 * fetch options for shallow repos) and a provider tab listing forks of the repo for one-click adding.
 */
export function RemoteDialog({
  repoId,
  edit,
  onClose,
}: {
  repoId: RepoId;
  edit?: RemoteInfo;
  onClose(): void;
}) {
  const remotes = useRemotes(repoId).data ?? [];
  const info = useRepoInfo(repoId).data;
  const resolved = useResolvedRemotes(repoId, !edit).data ?? [];
  // the repo's provider: origin first, else the first remote mapped to a connected account
  const home = resolved.find((r) => r.remote === 'origin' && r.ref) ?? resolved.find((r) => r.ref);
  const providerKind = home?.kind ?? resolved.find((r) => r.kind)?.kind ?? null;

  const [tab, setTab] = useState<'url' | 'forks'>('url');
  const [name, setName] = useState(edit?.name ?? '');
  const [fetchUrl, setFetchUrl] = useState(edit?.fetchUrl ?? '');
  const [pushUrl, setPushUrl] = useState(edit && edit.pushUrl !== edit.fetchUrl ? edit.pushUrl : '');
  const [fetchAfter, setFetchAfter] = useState(true);
  const [depth, setDepth] = useState('');
  const [since, setSince] = useState('');
  const [flags, setFlags] = useState('');
  const [protocol, setProtocol] = useState<'https' | 'ssh'>(() =>
    /^(?:ssh:\/\/|[^/:]+@[^:]+:)/.test(remotes[0]?.fetchUrl ?? '') ? 'ssh' : 'https',
  );
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  const names = remotes.map((r) => r.name);
  const nameError = validateRemoteName(name, names, edit?.name);
  const urlError = validateRemoteUrl(fetchUrl);
  const pushError = validateRemoteUrl(pushUrl, true);
  const flagsParsed = parseShallowFlags(flags);
  const depthError = depth && !/^[1-9]\d{0,6}$/.test(depth.trim()) ? 'Enter a positive number.' : null;

  const submit = async (): Promise<void> => {
    setTouched(true);
    if (nameError || urlError || pushError || depthError || 'error' in flagsParsed) return;
    setBusy(true);
    try {
      if (edit) {
        const pu = pushUrl.trim();
        const editedPush = pu !== (edit.pushUrl !== edit.fetchUrl ? edit.pushUrl : '');
        await runOp(
          repoId,
          {
            type: 'remote.edit',
            name: edit.name,
            ...(name.trim() !== edit.name ? { newName: name.trim() } : {}),
            ...(fetchUrl.trim() !== edit.fetchUrl ? { fetchUrl: fetchUrl.trim() } : {}),
            ...(editedPush ? { pushUrl: pu || null } : {}),
          },
          { successToast: `Updated remote ${name.trim()}` },
        );
      } else {
        const shallow =
          info?.isShallow && (depth || since || flags.trim())
            ? {
                ...(depth ? { depth: Number(depth) } : {}),
                ...(since ? { since } : {}),
                ...('flags' in flagsParsed && flagsParsed.flags.length
                  ? { extraArgs: flagsParsed.flags }
                  : {}),
              }
            : undefined;
        await runOp(
          repoId,
          {
            type: 'remote.add',
            name: name.trim(),
            fetchUrl: fetchUrl.trim(),
            ...(pushUrl.trim() ? { pushUrl: pushUrl.trim() } : {}),
            fetchAfter,
            ...(shallow ? { shallow } : {}),
          },
          { successToast: `Added remote ${name.trim()}` },
        );
      }
      onClose();
    } catch {
      setBusy(false); // runOp already showed the error toast
    }
  };

  const pick = (f: ForkChoice): void => {
    setName(f.suggestedName);
    setFetchUrl(f.url);
    setPushUrl('');
    setTab('url');
  };

  return (
    <FormDialog
      title={edit ? `Edit remote ${edit.name}` : 'Add remote'}
      okLabel={edit ? 'Save' : 'Add Remote'}
      onCancel={onClose}
      onSubmit={() => void submit()}
      busy={busy}
      wide
      footer={
        !edit && (
          <label className={s.check}>
            <input type="checkbox" checked={fetchAfter} onChange={(e) => setFetchAfter(e.target.checked)} />
            Fetch after adding
          </label>
        )
      }
    >
      {!edit && (
        <div className={s.tabs} role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'url'} onClick={() => setTab('url')}>
            URL
          </button>
          <button type="button" role="tab" aria-selected={tab === 'forks'} onClick={() => setTab('forks')}>
            {providerKind ? `${PROVIDER_LABEL[providerKind] ?? providerKind} forks` : 'Forks'}
          </button>
        </div>
      )}
      {tab === 'forks' && !edit ? (
        <ForkList
          repoId={repoId}
          home={home?.ref ? { ref: home.ref } : null}
          providerKnown={!!providerKind}
          remotes={remotes}
          protocol={protocol}
          setProtocol={setProtocol}
          onPick={pick}
        />
      ) : (
        <>
          <Field label="Name" error={touched || name ? nameError : null}>
            <input
              type="text"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              spellCheck={false}
            />
          </Field>
          <Field label="Pull URL" error={touched || fetchUrl ? urlError : null}>
            <input
              type="text"
              value={fetchUrl}
              placeholder="https://github.com/owner/repo.git"
              onChange={(e) => setFetchUrl(e.target.value)}
              spellCheck={false}
            />
          </Field>
          <Field label="Push URL (optional)" hint="Same as the pull URL when empty" error={pushError}>
            <input
              type="text"
              value={pushUrl}
              onChange={(e) => setPushUrl(e.target.value)}
              spellCheck={false}
            />
          </Field>
          {!edit && info?.isShallow && (
            <details className={s.details}>
              <summary>Shallow fetch options (this repository is shallow)</summary>
              <div className={s.row}>
                <Field label="Depth" error={depthError}>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={depth}
                    onChange={(e) => setDepth(e.target.value)}
                  />
                </Field>
                <Field label="Since date">
                  <input type="date" value={since} onChange={(e) => setSince(e.target.value)} />
                </Field>
              </div>
              <Field
                label="Custom fetch flags"
                hint="--no-tags, --single-branch, --filter=<spec>"
                error={'error' in flagsParsed ? flagsParsed.error : null}
              >
                <input
                  type="text"
                  value={flags}
                  onChange={(e) => setFlags(e.target.value)}
                  spellCheck={false}
                />
              </Field>
            </details>
          )}
        </>
      )}
    </FormDialog>
  );
}

function ForkList(props: {
  repoId: RepoId;
  home: { ref: RemoteRepo['ref'] } | null;
  providerKnown: boolean;
  remotes: RemoteInfo[];
  protocol: 'https' | 'ssh';
  setProtocol(p: 'https' | 'ssh'): void;
  onPick(f: ForkChoice): void;
}) {
  const [query, setQuery] = useState('');
  const ref = props.home?.ref;
  const forks = useQuery({
    queryKey: ['remoteForks', props.repoId, ref?.integration, ref?.owner, ref?.name],
    enabled: !!ref,
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      const all: RemoteRepo[] = [];
      let cursor: string | undefined;
      // a few pages at most (100 per page on GitHub)
      for (let i = 0; i < 5; i++) {
        const page = await intInvoke('provider:listForks', { ref: ref!, ...(cursor ? { cursor } : {}) });
        all.push(...page.items);
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      return all;
    },
  });
  const choices = useMemo(
    () => forkChoices(forks.data ?? [], props.remotes, props.protocol),
    [forks.data, props.remotes, props.protocol],
  );
  const q = query.trim().toLowerCase();
  const shown = q ? choices.filter((c) => c.fullName.toLowerCase().includes(q)) : choices;

  if (!ref) {
    return (
      <div className={s.empty}>
        {props.providerKnown
          ? 'Connect the hosting integration of this repository to pick a fork.'
          : 'No remote of this repository is hosted on a supported provider.'}{' '}
        {props.providerKnown && (
          <button type="button" onClick={openIntegrationsPreferences}>
            Connect…
          </button>
        )}
      </div>
    );
  }
  return (
    <>
      <div className={s.row}>
        <Field label={`Forks of ${ref.owner}/${ref.name}`}>
          <input
            type="text"
            placeholder="Search forks"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </Field>
        <div className={s.radios} role="radiogroup" aria-label="Protocol" style={{ flex: 'none' }}>
          {(['https', 'ssh'] as const).map((p) => (
            <label key={p}>
              <input
                type="radio"
                name="fork-protocol"
                checked={props.protocol === p}
                onChange={() => props.setProtocol(p)}
              />
              {p.toUpperCase()}
            </label>
          ))}
        </div>
      </div>
      <div className={s.list} role="listbox" aria-label="Forks">
        {forks.isLoading && <div className={s.empty}>Loading forks…</div>}
        {forks.error && <div className={s.empty}>{errorLine(forks.error)}</div>}
        {!forks.isLoading && !forks.error && !shown.length && (
          <div className={s.empty}>{q ? 'No matching forks.' : 'This repository has no forks.'}</div>
        )}
        {shown.map((f) => (
          <button
            key={f.key}
            type="button"
            role="option"
            aria-selected={false}
            className={s.listItem}
            disabled={!!f.addedAs}
            title={f.addedAs ? `Already added as ${f.addedAs}` : f.url}
            onClick={() => props.onPick(f)}
          >
            <Avatar name={f.owner} email="" size={20} />
            <span className={s.grow}>{f.fullName}</span>
            {f.addedAs ? (
              <span className={s.muted}>Already added as {f.addedAs}</span>
            ) : (
              <GitFork size={13} aria-hidden />
            )}
          </button>
        ))}
      </div>
    </>
  );
}

/** Quick add from a fork without opening the dialog (e.g. PR checkout prompts). */
export function addForkRemote(repoId: RepoId, f: ForkChoice, fetchAfter = true): void {
  quiet(
    runOp(
      repoId,
      { type: 'remote.add', name: f.suggestedName, fetchUrl: f.url, fetchAfter },
      { successToast: `Added remote ${f.suggestedName}` },
    ),
  );
}
