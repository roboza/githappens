import { createElement, useMemo, type ReactNode } from 'react';

import { parseMarkdown, type Inline } from './markdown-parse';
import { openExternal } from './update-api';
import styles from './Update.module.css';

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.type) {
      case 'strong':
        return <strong key={i}>{n.text}</strong>;
      case 'em':
        return <em key={i}>{n.text}</em>;
      case 'code':
        return <code key={i}>{n.text}</code>;
      case 'link':
        return (
          <a
            key={i}
            href={n.href}
            className={styles.link}
            title={n.href}
            onClick={(e) => {
              e.preventDefault();
              openExternal(n.href);
            }}
          >
            {n.text}
          </a>
        );
      default:
        return n.text;
    }
  });
}

/** Renders the safe Markdown subset from `markdown-parse.ts` — text nodes only, links via shell:openExternal. */
export function Markdown({ source }: { source: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return (
    <div className={styles.notes}>
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'heading':
            return createElement(
              `h${Math.min(6, Math.max(1, b.level + 1))}`,
              { key: i },
              renderInline(b.inline),
            );
          case 'list': {
            const items = b.items.map((it, j) => <li key={j}>{renderInline(it)}</li>);
            return b.ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>;
          }
          case 'code':
            return (
              <pre key={i}>
                <code>{b.text}</code>
              </pre>
            );
          default:
            return <p key={i}>{renderInline(b.inline)}</p>;
        }
      })}
    </div>
  );
}
