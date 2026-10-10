import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';

import type { DetectedTool, ToolKind } from '../../../../shared/ipc/tools-contract';
import type { SettingKey } from '../../../../shared/settings/registry';
import { IpcError } from '../../lib/api';
import { useSetting, useSettingsStore } from '../../stores/settings';
import { toolsInvoke } from '../../tools/api';
import styles from './ExternalToolsPanel.module.css';

const TESTS: { kind: ToolKind; label: string }[] = [
  { kind: 'editor', label: 'Test editor' },
  { kind: 'terminal', label: 'Test terminal' },
  { kind: 'diff', label: 'Test diff tool' },
  { kind: 'merge', label: 'Test merge tool' },
];

/**
 * Preferences → External Tools extras (spec 13 External Tools, §7 step 13): what was detected on this machine,
 * one-click "Use", and a Test button per tool kind that launches the configured tool on temp files.
 */
export function ExternalToolsPanel() {
  const qc = useQueryClient();
  const detected = useQuery({
    queryKey: ['tools', 'detect'],
    queryFn: () => toolsInvoke('tools:detect', {}),
    staleTime: Infinity,
  });
  const [busy, setBusy] = useState<ToolKind | 'scan' | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const rescan = async (): Promise<void> => {
    setBusy('scan');
    try {
      qc.setQueryData(['tools', 'detect'], await toolsInvoke('tools:detect', { refresh: true }));
    } finally {
      setBusy(null);
    }
  };

  const test = async (kind: ToolKind): Promise<void> => {
    setBusy(kind);
    setResult(null);
    try {
      const r = await toolsInvoke('tools:test', { kind });
      setResult({ ok: true, text: `Started ${r.launched}.` });
    } catch (e) {
      setResult({ ok: false, text: e instanceof IpcError || e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const d = detected.data;
  return (
    <section className={styles.panel} aria-label="Detected external tools">
      <div className={styles.head}>
        <h3 className={styles.title}>Detected on this computer</h3>
        <span className={styles.spacer} />
        <button type="button" onClick={() => void rescan()} disabled={busy === 'scan'} title="Scan again">
          <RefreshCw size={12} /> Rescan
        </button>
      </div>
      <div className={styles.tests}>
        {TESTS.map((t) => (
          <button key={t.kind} type="button" disabled={!!busy} onClick={() => void test(t.kind)}>
            {busy === t.kind ? 'Starting…' : t.label}
          </button>
        ))}
      </div>
      {result && <p className={result.ok ? styles.result : styles.resultError}>{result.text}</p>}
      {detected.isLoading && <p className={styles.muted}>Looking for installed tools…</p>}
      {detected.error && <p className={styles.resultError}>{(detected.error as Error).message}</p>}
      {d && (
        <>
          <ToolGroup title="Editors" tools={d.editors} uses={[{ key: 'tools.editor', label: 'Use' }]} />
          <ToolGroup title="Terminals" tools={d.terminals} uses={[{ key: 'tools.terminal', label: 'Use' }]} />
          <ToolGroup
            title="Diff & merge tools"
            tools={d.diffTools}
            uses={[
              { key: 'tools.diffTool', label: 'Use for diff' },
              { key: 'tools.mergeTool', label: 'Use for merge' },
            ]}
          />
        </>
      )}
    </section>
  );
}

type UseKey = Extract<SettingKey, 'tools.editor' | 'tools.terminal' | 'tools.diffTool' | 'tools.mergeTool'>;

function ToolGroup(props: { title: string; tools: DetectedTool[]; uses: { key: UseKey; label: string }[] }) {
  return (
    <div className={styles.group}>
      <h4 className={styles.groupTitle}>{props.title}</h4>
      {props.tools.map((t) => (
        <ToolRow key={t.id} tool={t} uses={props.uses} />
      ))}
    </div>
  );
}

function ToolRow({ tool, uses }: { tool: DetectedTool; uses: { key: UseKey; label: string }[] }) {
  const set = useSettingsStore((s) => s.set);
  const first = useSetting(uses[0]!.key);
  const second = useSetting(uses[1]?.key ?? uses[0]!.key);
  const current = [first, uses[1] ? second : undefined];
  return (
    <div className={styles.tool}>
      <span className={`${styles.dot} ${tool.path ? styles.found : ''}`} aria-hidden />
      <span className={styles.name}>
        {tool.label}
        {current.some((c) => c === tool.id) && <span className={styles.current}>in use</span>}
      </span>
      {tool.path ? (
        <span className={styles.path} title={tool.path}>
          {tool.path}
        </span>
      ) : (
        <span className={styles.missing}>Not found</span>
      )}
      <span className={styles.actions}>
        {uses.map((u, i) => (
          <button
            key={u.key}
            type="button"
            disabled={!tool.path || current[i] === tool.id}
            onClick={() => void set(u.key, tool.id as never)}
          >
            {u.label}
          </button>
        ))}
      </span>
    </div>
  );
}
