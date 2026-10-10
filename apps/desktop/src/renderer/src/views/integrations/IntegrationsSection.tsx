import type { ConnectedIntegration } from '@githappens/providers/types';
import { useQueryClient } from '@tanstack/react-query';
import { Building2, Copy, ExternalLink, KeyRound, Loader2, LogIn, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { choose } from '../../components/Dialogs';
import { formatDate } from '../../lib/format';
import { useToastStore } from '../../stores/toasts';
import { copyText, errorLine, intInvoke, openExternal } from '../../integrations/api';
import {
  entryMatches,
  formatRetry,
  INTEGRATION_CATALOG,
  normalizeHost,
  providerLabel,
  type IntegrationEntry,
} from '../../integrations/helpers';
import { ik, useIntegrationOrgs, useIntegrations, useOAuthAvailability } from '../../integrations/queries';
import { useOAuthProgressStore, useRateLimitStore } from '../../integrations/stores';
import { ProviderErrorLine, uiStyles, UserAvatar } from '../../integrations/ui';
import { IntegrationSshActions } from '../ssh';
import s from './IntegrationsSection.module.css';

const OAUTH_TIMEOUT_MS = 5 * 60_000;

type Status = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * Preferences → Integrations (spec 10 §4.1): provider nav with status dots; per provider connect via
 * OAuth (browser / device code) or a personal access token; connected accounts with scopes,
 * rate limit and disconnect.
 */
export function IntegrationsSection() {
  const integrations = useIntegrations();
  const [selected, setSelected] = useState(INTEGRATION_CATALOG[0]!.id);
  const [busyEntry, setBusyEntry] = useState<string | null>(null);
  const [failedEntry, setFailedEntry] = useState<string | null>(null);
  const accounts = integrations.data ?? [];
  const entry = INTEGRATION_CATALOG.find((e) => e.id === selected) ?? INTEGRATION_CATALOG[0]!;

  const statusOf = (e: IntegrationEntry): Status =>
    busyEntry === e.id
      ? 'connecting'
      : accounts.some((a) => entryMatches(e, a))
        ? 'connected'
        : failedEntry === e.id
          ? 'error'
          : 'disconnected';

  return (
    <div className={s.layout}>
      <ul className={s.nav} aria-label="Integrations">
        {INTEGRATION_CATALOG.map((e) => {
          const n = accounts.filter((a) => entryMatches(e, a)).length;
          return (
            <li key={e.id}>
              <button
                type="button"
                className={`${s.navItem} ${e.id === entry.id ? s.navItemActive : ''}`}
                aria-current={e.id === entry.id ? 'page' : undefined}
                onClick={() => setSelected(e.id)}
              >
                <span className={s.status} data-status={statusOf(e)} aria-label={statusOf(e)} />
                <span className={s.navLabel}>{e.label}</span>
                {n > 1 && <span className={s.navCount}>{n}</span>}
              </button>
            </li>
          );
        })}
      </ul>
      <div className={s.panel}>
        {integrations.error ? (
          <ProviderErrorLine error={integrations.error} onRetry={() => void integrations.refetch()} />
        ) : (
          <EntryPanel
            key={entry.id}
            entry={entry}
            accounts={accounts.filter((a) => entryMatches(entry, a))}
            onBusy={(b) => setBusyEntry(b ? entry.id : null)}
            onFailed={(f) => setFailedEntry(f ? entry.id : null)}
          />
        )}
      </div>
    </div>
  );
}

function EntryPanel({
  entry,
  accounts,
  onBusy,
  onFailed,
}: {
  entry: IntegrationEntry;
  accounts: ConnectedIntegration[];
  onBusy(b: boolean): void;
  onFailed(f: boolean): void;
}) {
  const [showForm, setShowForm] = useState(false);
  const [reconnectHost, setReconnectHost] = useState<string | null>(null);
  const formOpen = accounts.length === 0 || showForm || reconnectHost !== null;
  return (
    <>
      <h3>{entry.label}</h3>
      {accounts.length === 0 && (
        <p className={s.intro}>
          Connect {entry.label} to browse repositories, work with pull requests
          {entry.kind.startsWith('jira') ? ' and issues' : ''} right from GitHappens.
        </p>
      )}
      {accounts.map((a) => (
        <AccountCard
          key={a.key}
          account={a}
          onReconnect={() => {
            setReconnectHost(a.host);
            setShowForm(true);
          }}
        />
      ))}
      {formOpen ? (
        <ConnectForm
          key={reconnectHost ?? ''}
          entry={entry}
          initialHost={reconnectHost ?? undefined}
          onBusy={onBusy}
          onFailed={onFailed}
          onDone={() => {
            setShowForm(false);
            setReconnectHost(null);
          }}
        />
      ) : (
        <div>
          <button type="button" onClick={() => setShowForm(true)}>
            <LogIn size={14} /> Connect another account
          </button>
        </div>
      )}
    </>
  );
}

function AccountCard({ account: a, onReconnect }: { account: ConnectedIntegration; onReconnect(): void }) {
  const qc = useQueryClient();
  const rate = useRateLimitStore((st) => st.limits[a.key]);
  const push = useToastStore((st) => st.push);
  const [error, setError] = useState<unknown>(null);
  const [now] = useState(() => Date.now());

  const disconnect = async (): Promise<void> => {
    const r = await choose({
      title: `Disconnect ${a.login}?`,
      message: `GitHappens will forget the ${a.authType === 'oauth' ? 'OAuth token' : 'access token'} for ${a.login} on ${a.host}.`,
      choices: [
        { value: 'cancel', label: 'Cancel' },
        { value: 'ok', label: 'Disconnect', danger: true },
      ],
      // Revoking is the safe default for tokens GitHappens obtained itself (OAuth); a PAT may be shared
      // with other tools, so it is only revoked on request.
      checkbox: {
        label: `Also revoke the token at ${providerLabel(a.kind)}`,
        initial: a.authType === 'oauth',
      },
    });
    if (r?.value !== 'ok') return;
    try {
      setError(null);
      await intInvoke('auth:disconnect', { integrationKey: a.key, revoke: r.checked });
      push({ kind: 'success', title: `Disconnected ${a.login}` });
      void qc.invalidateQueries({ queryKey: ik.integrations() });
    } catch (e) {
      setError(e);
    }
  };

  return (
    <div className={s.card}>
      <UserAvatar user={a} size={36} />
      <div className={s.cardMain}>
        <div className={s.login}>
          {a.login}
          {a.name && a.name !== a.login && <span className={s.meta}> · {a.name}</span>}
        </div>
        <div className={s.meta}>
          {a.host} · {a.authType === 'oauth' ? 'OAuth' : 'Personal access token'} · connected{' '}
          {formatDate(Math.floor(a.connectedAt / 1000))}
          {rate && (
            <span className={s.rate}>
              {' '}
              · API {rate.remaining}/{rate.limit}
              {rate.remaining < rate.limit * 0.1 && `, resets ${formatRetry(rate.resetAt, now)}`}
            </span>
          )}
        </div>
      </div>
      <div className={s.cardActions}>
        <button type="button" title="Reconnect" onClick={onReconnect}>
          <RefreshCw size={14} /> Reconnect
        </button>
        <button type="button" title="Disconnect" onClick={() => void disconnect()}>
          <Trash2 size={14} /> Disconnect
        </button>
      </div>
      {a.scopes.length > 0 ? (
        <div className={s.scopes} aria-label="Granted scopes">
          {a.scopes.map((sc) => (
            <span key={sc} className={s.scope}>
              {sc}
            </span>
          ))}
        </div>
      ) : (
        <div className={s.warn}>
          Scopes unknown (fine-grained token) — missing permissions surface per action.
        </div>
      )}
      {error !== null && (
        <div className={s.warn}>
          <ProviderErrorLine error={error} />
        </div>
      )}
      {hasOrgSelector(a) && <OrgSelector account={a} />}
      <IntegrationSshActions account={a} />
    </div>
  );
}

/** Azure DevOps (any auth) and Jira Cloud OAuth accounts are scoped to one organization / site. */
const hasOrgSelector = (a: ConnectedIntegration): boolean =>
  a.kind === 'azure-devops' || (a.kind === 'jira-cloud' && a.authType === 'oauth');

/** Organization (Azure DevOps) / site (Jira Cloud) picker of a connected account (spec 10 §4.1). */
function OrgSelector({ account: a }: { account: ConnectedIntegration }) {
  const qc = useQueryClient();
  const push = useToastStore((st) => st.push);
  const orgs = useIntegrationOrgs(a.key);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const isAzure = a.kind === 'azure-devops';
  const noun = isAzure ? 'organization' : 'site';
  const list = orgs.data ?? [];
  const current = list.find((o) => o.selected);

  const select = async (id: string): Promise<void> => {
    if (!id || id === current?.id) return;
    setBusy(true);
    setError(null);
    try {
      const next = await intInvoke('auth:selectOrganization', { integrationKey: a.key, id });
      push({ kind: 'success', title: `${a.login} now uses ${list.find((o) => o.id === id)?.name ?? id}` });
      await qc.invalidateQueries({ queryKey: ik.integrations() });
      void qc.invalidateQueries({ queryKey: ik.orgs(a.key) });
      if (next.key !== a.key) void qc.invalidateQueries({ queryKey: ik.orgs(next.key) });
      void qc.invalidateQueries({ queryKey: ['provider', 'remotes'] });
      void qc.invalidateQueries({ queryKey: ['issues'] });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={s.orgs}>
      {orgs.error ? (
        <ProviderErrorLine error={orgs.error} onRetry={() => void orgs.refetch()} />
      ) : (
        <>
          {isAzure && !orgs.isPending && !current && (
            <div className={s.orgPrompt} role="status">
              Pick an organization to enable Azure Boards.
            </div>
          )}
          <label className={s.orgRow}>
            <Building2 size={14} aria-hidden />
            <span>{isAzure ? 'Organization' : 'Jira site'}</span>
            <select
              value={current?.id ?? ''}
              disabled={busy || orgs.isPending || list.length === 0}
              aria-label={`${a.login} ${noun}`}
              onChange={(e) => void select(e.target.value)}
            >
              {!current && (
                <option value="">
                  {orgs.isPending ? 'Loading…' : list.length ? `Choose an ${noun}…` : `No ${noun}s found`}
                </option>
              )}
              {list.map((o) => (
                <option key={o.id} value={o.id} title={o.url}>
                  {o.name}
                </option>
              ))}
            </select>
            {busy && <Loader2 size={14} className={uiStyles.spin} />}
          </label>
        </>
      )}
      {error !== null && <ProviderErrorLine error={error} />}
    </div>
  );
}

function ConnectForm({
  entry,
  initialHost,
  onBusy,
  onFailed,
  onDone,
}: {
  entry: IntegrationEntry;
  initialHost?: string;
  onBusy(b: boolean): void;
  onFailed(f: boolean): void;
  onDone(): void;
}) {
  const qc = useQueryClient();
  const availability = useOAuthAvailability().data ?? {};
  const push = useToastStore((st) => st.push);
  const needsHost = !entry.host;
  const [hostText, setHostText] = useState(initialHost ?? '');
  const [username, setUsername] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [flow, setFlow] = useState<{ flowId: string } | null>(null);
  const progress = useOAuthProgressStore((st) => (flow ? st.flows[flow.flowId] : undefined));

  const host = entry.host ?? normalizeHost(hostText);
  const hostError =
    needsHost && hostText.trim() && !host ? 'Enter a host name like ' + entry.hostPlaceholder : null;
  const oauthAllowed = !!availability[entry.kind] && !entry.selfHosted;
  const flowActive = !!flow && progress?.phase !== 'done' && progress?.phase !== 'error';
  const flowDone = !!flow && progress?.phase === 'done';
  const flowError = flow && progress?.phase === 'error' ? (progress.error ?? 'Authorization failed') : null;

  useEffect(() => {
    onBusy(flowActive || busy);
  }, [flowActive, busy, onBusy]);

  const handledFlow = useRef<string | null>(null);
  useEffect(() => {
    if (!flowDone || !flow || handledFlow.current === flow.flowId) return;
    handledFlow.current = flow.flowId;
    void qc.invalidateQueries({ queryKey: ik.integrations() });
    onDone();
  }, [flowDone, flow, qc, onDone]);

  // OAuthWaitingOverlay gives up after 5 minutes (spec 10 §4.1).
  useEffect(() => {
    if (!flow || !flowActive) return;
    const t = setTimeout(() => {
      void intInvoke('auth:cancelOAuth', { flowId: flow.flowId }).catch(() => undefined);
      setFlow(null);
      setError(new Error('Timed out waiting for the browser. Try again.'));
    }, OAUTH_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [flow, flowActive]);

  const startOAuth = async (): Promise<void> => {
    try {
      setError(null);
      setBusy(true);
      onFailed(false);
      const r = await intInvoke('auth:startOAuth', { kind: entry.kind, host: host ?? undefined });
      setFlow(r);
    } catch (e) {
      setError(e);
      onFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const cancelOAuth = (): void => {
    if (flow) void intInvoke('auth:cancelOAuth', { flowId: flow.flowId }).catch(() => undefined);
    setFlow(null);
  };

  const connectPat = async (): Promise<void> => {
    if (!host || !token.trim()) return;
    try {
      setError(null);
      setBusy(true);
      onFailed(false);
      const acc = await intInvoke('auth:connectPat', {
        kind: entry.kind,
        host,
        token: token.trim(),
        username: username.trim() || undefined,
      });
      setToken('');
      push({ kind: 'success', title: `Connected ${acc.login} on ${acc.host}` });
      await qc.invalidateQueries({ queryKey: ik.integrations() });
      onDone();
    } catch (e) {
      setError(e);
      onFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const openTokenPage = async (): Promise<void> => {
    if (!host) return;
    try {
      openExternal(await intInvoke('auth:tokenPageUrl', { kind: entry.kind, host }));
    } catch (e) {
      setError(e);
    }
  };

  if (flowActive) {
    const device = progress?.phase === 'device-code' && progress.userCode;
    return (
      <div className={s.oauthBox} aria-live="polite">
        {device ? (
          <>
            <span>Enter this code on {progress.verificationUri ?? 'the verification page'}:</span>
            <div className={s.row}>
              <span className={s.userCode}>{progress.userCode}</span>
              <button type="button" title="Copy code" onClick={() => copyText(progress.userCode!)}>
                <Copy size={14} /> Copy
              </button>
              {progress.verificationUri && (
                <button type="button" onClick={() => openExternal(progress.verificationUri!)}>
                  <ExternalLink size={14} /> Open page
                </button>
              )}
            </div>
          </>
        ) : (
          <span className={s.row}>
            <Loader2 size={14} className={uiStyles.spin} />
            {progress?.phase === 'exchanging'
              ? 'Finishing sign-in…'
              : 'Waiting for the browser… Approve access there.'}
          </span>
        )}
        <div className={s.row}>
          {progress?.verificationUri && !device && (
            <button type="button" onClick={() => copyText(progress.verificationUri!)}>
              <Copy size={14} /> Copy link
            </button>
          )}
          <button type="button" onClick={cancelOAuth}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={s.form}>
      {needsHost && (
        <label className={s.field}>
          {entry.kind === 'jira-cloud' ? 'Site' : 'Server URL'}
          <input
            type="text"
            value={hostText}
            placeholder={entry.hostPlaceholder}
            spellCheck={false}
            onChange={(e) => setHostText(e.target.value)}
          />
          {hostError && <span className={s.error}>{hostError}</span>}
        </label>
      )}
      {oauthAllowed && (
        <>
          <div className={s.row}>
            <button
              type="button"
              className="primary"
              disabled={busy || (needsHost && entry.kind !== 'jira-cloud' && !host)}
              onClick={() => void startOAuth()}
            >
              <LogIn size={14} />{' '}
              {entry.kind === 'jira-cloud' ? 'Connect with Atlassian' : `Connect to ${entry.label}`}
            </button>
            {entry.kind === 'jira-cloud' && (
              <span className={s.or}>Sign in in the browser, then pick a site.</span>
            )}
          </div>
          <span className={s.or}>
            {entry.kind === 'jira-cloud'
              ? 'or use your Atlassian e-mail and an API token'
              : 'or use a personal access token'}
          </span>
        </>
      )}
      <div className={s.row}>
        <button type="button" disabled={!host} onClick={() => void openTokenPage()}>
          <KeyRound size={14} /> Create token
        </button>
        <span className={s.or}>Opens {entry.label} with the required scopes preselected.</span>
      </div>
      {entry.usernameLabel && (
        <label className={s.field}>
          {entry.usernameLabel}
          <input
            type="text"
            value={username}
            spellCheck={false}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
      )}
      <form
        className={s.field}
        onSubmit={(e) => {
          e.preventDefault();
          void connectPat();
        }}
      >
        {entry.tokenLabel}
        <div className={s.row}>
          <input
            type="password"
            value={token}
            autoComplete="off"
            spellCheck={false}
            style={{ flex: 1, minWidth: 200 }}
            onChange={(e) => setToken(e.target.value)}
          />
          <button
            type="submit"
            className={oauthAllowed ? undefined : 'primary'}
            disabled={busy || !host || !token.trim() || (!!entry.usernameLabel && !username.trim())}
          >
            {busy ? <Loader2 size={14} className={uiStyles.spin} /> : null} Connect with token
          </button>
        </div>
      </form>
      {flowError && <p className={s.error}>{flowError}</p>}
      {error !== null && <p className={s.error}>{errorLine(error)}</p>}
    </div>
  );
}
