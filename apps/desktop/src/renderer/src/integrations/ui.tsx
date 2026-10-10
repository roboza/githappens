import type { ProviderUser } from '@githappens/providers/types';
import { CheckCircle2, CircleDashed, CircleDot, XCircle } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';

import { Avatar } from '../components/Avatar';
import { friendlyError, openExternal, openIntegrationsPreferences } from './api';
import {
  parseMarkdown,
  rollupTone,
  stateTone,
  STATE_LABEL,
  type Block,
  type Inline,
  type Tone,
} from './helpers';
import type { PrRollupStatus, PrState } from '@githappens/providers/types';
import s from './ui.module.css';

/** Shared bits for the integrations views (avatars, errors, markdown, status chips). */

export const toneClass = (t: Tone): string => s[`tone-${t}`] ?? '';

/** Provider avatar image with an initials fallback, served via the avatar protocol (spec 10 §4.10). */
export function UserAvatar({
  user,
  size = 20,
}: {
  user: Pick<ProviderUser, 'login' | 'name' | 'avatarUrl' | 'email'>;
  size?: number;
}) {
  return (
    <Avatar
      name={user.name || user.login}
      email={user.email || user.login}
      url={user.avatarUrl}
      size={size}
      className={s.avatar}
    />
  );
}

/** Inline error with the matching action: Reconnect / Retry / Learn more. */
export function ProviderErrorLine({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const f = friendlyError(error);
  return (
    <div className={s.errorBox} role="alert">
      <strong>{f.title}</strong>
      {f.detail && <span className={s.errorDetail}>{f.detail}</span>}
      {f.action === 'reconnect' && (
        <button type="button" className={s.linkBtn} onClick={openIntegrationsPreferences}>
          Reconnect account
        </button>
      )}
      {f.action === 'help' && f.helpUrl && (
        <button type="button" className={s.linkBtn} onClick={() => openExternal(f.helpUrl!)}>
          Learn more
        </button>
      )}
      {onRetry && f.action !== 'reconnect' && (
        <button type="button" className={s.linkBtn} onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function RollupIcon({ rollup, size = 13 }: { rollup: PrRollupStatus; size?: number }) {
  const cls = toneClass(rollupTone(rollup));
  const label = { success: 'Checks passing', pending: 'Pending', failure: 'Failing', none: 'No checks' }[
    rollup
  ];
  const Icon =
    rollup === 'success'
      ? CheckCircle2
      : rollup === 'failure'
        ? XCircle
        : rollup === 'pending'
          ? CircleDot
          : CircleDashed;
  return <Icon size={size} className={cls} aria-label={label} />;
}

export function StateChip({ state }: { state: PrState }) {
  return <span className={`${s.chip} ${toneClass(stateTone(state))}`}>{STATE_LABEL[state]}</span>;
}

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.t) {
      case 'text':
        return <span key={i}>{n.v}</span>;
      case 'code':
        return <code key={i}>{n.v}</code>;
      case 'bold':
        return <strong key={i}>{renderInline(n.v)}</strong>;
      case 'italic':
        return <em key={i}>{renderInline(n.v)}</em>;
      case 'strike':
        return <del key={i}>{renderInline(n.v)}</del>;
      case 'link':
        return (
          <a
            key={i}
            href={n.href}
            title={n.href}
            onClick={(e) => {
              e.preventDefault();
              openExternal(n.href);
            }}
          >
            {renderInline(n.v)}
          </a>
        );
    }
  });
}

function renderBlocks(blocks: Block[]): ReactNode[] {
  return blocks.map((b, i) => {
    switch (b.t) {
      case 'heading': {
        const H = `h${Math.min(6, b.level)}` as 'h1';
        return <H key={i}>{renderInline(b.v)}</H>;
      }
      case 'para':
        return (
          <p key={i} style={{ whiteSpace: 'pre-line' }}>
            {renderInline(b.v)}
          </p>
        );
      case 'code':
        return (
          <pre key={i}>
            <code>{b.v}</code>
          </pre>
        );
      case 'quote':
        return <blockquote key={i}>{renderBlocks(b.v)}</blockquote>;
      case 'rule':
        return <hr key={i} />;
      case 'list': {
        const L = b.ordered ? 'ol' : 'ul';
        return (
          <L key={i}>
            {b.items.map((it, j) => (
              <li key={j} className={it.checked !== undefined ? s.task : undefined}>
                {it.checked !== undefined && <input type="checkbox" checked={it.checked} readOnly disabled />}
                {renderInline(it.v)}
              </li>
            ))}
          </L>
        );
      }
    }
  });
}

/** Markdown-ish renderer (no raw HTML; links open in the system browser). */
export function Markdown({ text, empty = 'No description provided.' }: { text: string; empty?: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  if (!text.trim()) return <p className={s.muted}>{empty}</p>;
  return <div className={s.md}>{renderBlocks(blocks)}</div>;
}

/** ISO timestamp → unix seconds for lib/format `formatDate`. */
export const isoSecs = (iso: string | undefined): number => (iso ? Math.floor(Date.parse(iso) / 1000) : 0);

export { s as uiStyles };
