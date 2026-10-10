import type { RemoteRepo } from '@githappens/providers/types';
import { GitFork, Lock, Star } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { formatDate } from '../../lib/format';
import { openIntegrationsPreferences } from '../../integrations/api';
import { providerLabel } from '../../integrations/helpers';
import { useIntegrations, useOwners, useRemoteRepos } from '../../integrations/queries';
import { isoSecs, ProviderErrorLine } from '../../integrations/ui';
import { useSettingsStore } from '../../stores/settings';
import s from './CloneFromProvider.module.css';

const HOSTING = new Set(['github', 'gitlab', 'bitbucket', 'bitbucket-dc', 'azure-devops']);

/**
 * Clone dialog provider browser (spec 10 §4.2): account switcher, owner filter, debounced search,
 * HTTPS/SSH toggle. Picking a repo calls `onPick(cloneUrl, repoName)`.
 */
export function CloneFromProvider({ onPick }: { onPick(url: string, name: string): void }) {
  const integrations = useIntegrations();
  const accounts = useMemo(
    () => (integrations.data ?? []).filter((a) => HOSTING.has(a.kind)),
    [integrations.data],
  );
  const [accountKey, setAccountKey] = useState<string | null>(null);
  const account = accounts.find((a) => a.key === accountKey) ?? accounts[0];
  const [owner, setOwner] = useState('');
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  // Default follows Preferences → SSH "Prefer SSH URLs when cloning from providers".
  const [protocol, setProtocol] = useState<'https' | 'ssh'>(() =>
    useSettingsStore.getState().values?.['ssh.preferSshForProviders'] ? 'ssh' : 'https',
  );
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQuery(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);

  const owners = useOwners(account?.key);
  const repos = useRemoteRepos(account?.key, owner, query);
  const items = useMemo(() => repos.data?.pages.flatMap((p) => p.items) ?? [], [repos.data]);

  const pick = (r: RemoteRepo, p = protocol): void => {
    setPicked(r.fullName);
    onPick(p === 'ssh' ? r.sshUrl : r.httpsUrl, r.ref.name);
  };

  if (integrations.isPending) return <div className={s.empty}>Loading accounts…</div>;
  if (!account) {
    return (
      <div className={s.browser}>
        <div className={`${s.list} ${s.empty}`}>
          <span>Connect GitHub, GitLab, Bitbucket or Azure DevOps to browse your repositories.</span>
          <button type="button" className="primary" onClick={openIntegrationsPreferences}>
            Connect an account
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={s.browser}>
      <div className={s.controls}>
        {accounts.length > 1 && (
          <select
            aria-label="Account"
            value={account.key}
            onChange={(e) => {
              setAccountKey(e.target.value);
              setOwner('');
            }}
          >
            {accounts.map((a) => (
              <option key={a.key} value={a.key}>
                {a.login} · {providerLabel(a.kind)}
                {a.host !== 'github.com' && a.host !== 'gitlab.com' ? ` (${a.host})` : ''}
              </option>
            ))}
          </select>
        )}
        <select aria-label="Owner" value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="">All owners</option>
          {(owners.data ?? []).map((o) => (
            <option key={o.login} value={o.login}>
              {o.login}
              {o.kind !== 'user' ? ` (${o.kind})` : ''}
            </option>
          ))}
        </select>
        <input
          type="text"
          className={s.search}
          placeholder="Search repositories"
          aria-label="Search repositories"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className={s.segmented} role="group" aria-label="Clone protocol">
          {(['https', 'ssh'] as const).map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={protocol === p}
              onClick={() => {
                setProtocol(p);
                const cur = items.find((r) => r.fullName === picked);
                if (cur) pick(cur, p);
              }}
            >
              {p.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
      <div className={s.list} role="listbox" aria-label="Repositories">
        {repos.error ? (
          <ProviderErrorLine error={repos.error} onRetry={() => void repos.refetch()} />
        ) : repos.isPending ? (
          <div className={s.empty}>Loading repositories…</div>
        ) : items.length === 0 ? (
          <div className={s.empty}>
            {query ? `No repositories match “${query}”.` : 'No repositories found.'}
          </div>
        ) : (
          <>
            {items.map((r) => (
              <button
                key={r.ref.id ?? r.fullName}
                type="button"
                role="option"
                aria-selected={picked === r.fullName}
                className={s.item}
                title={r.webUrl}
                onClick={() => pick(r)}
              >
                <span className={s.name}>
                  {r.isPrivate && <Lock size={12} aria-label="Private" />}
                  {r.isFork && <GitFork size={12} aria-hidden />}
                  <span>{r.fullName}</span>
                </span>
                <span />
                <span className={s.side}>
                  {r.isFork && <span className={s.badge}>fork</span>}
                  {r.stars ? (
                    <span>
                      <Star size={11} aria-hidden /> {r.stars}
                    </span>
                  ) : null}
                  <span>{formatDate(isoSecs(r.updatedAt))}</span>
                </span>
                {r.description && <span className={s.desc}>{r.description}</span>}
              </button>
            ))}
            {repos.hasNextPage && (
              <div className={s.more}>
                <button
                  type="button"
                  disabled={repos.isFetchingNextPage}
                  onClick={() => void repos.fetchNextPage()}
                >
                  {repos.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
