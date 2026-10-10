import type { RepoId } from '@githappens/git/types';

import type { PrDraftResult } from '../../../../shared/ipc/ai-contract';
import { describeAiError, needsSettings, openAiPreferences } from '../../ai/api';
import { useAiEnabled, useAiRun } from '../../ai/hooks';
import { SparkleButton } from './SparkleButton';
import s from './Ai.module.css';

/**
 * "Generate title & description" for the Create-PR form (spec 12 §4.4, spec 10): explains `base...head`
 * and fills the chosen template. Title and body stream into the form; the user can still edit them.
 */
export function PrDraftButton({
  repoId,
  head,
  base,
  template,
  onFill,
}: {
  repoId: RepoId;
  head: string;
  base: string;
  template?: string;
  onFill(draft: Partial<PrDraftResult>): void;
}) {
  const enabled = useAiEnabled();
  const run = useAiRun('prDraft');
  if (!enabled) return null;
  const generate = async (): Promise<void> => {
    const r = await run.start(
      { repoId, head, base, template: template?.trim() ? template : undefined },
      { onPartial: (p) => onFill(p as Partial<PrDraftResult>) },
    );
    if (r) onFill(r);
  };
  return (
    <>
      <SparkleButton
        label="Generate title and description with AI"
        text="Generate title & description"
        disabled={!head || !base}
        running={run.running}
        onRun={() => void generate()}
        onCancel={run.cancel}
      />
      {run.state.error && (
        <span className={s.error} role="alert">
          {describeAiError(run.state.error)}{' '}
          {needsSettings(run.state.error) && (
            <button type="button" className={s.linkBtn} onClick={openAiPreferences}>
              Open AI settings
            </button>
          )}
        </span>
      )}
    </>
  );
}
