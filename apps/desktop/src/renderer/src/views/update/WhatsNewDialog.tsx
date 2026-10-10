import { useEffect } from 'react';
import { create } from 'zustand';

import type { WhatsNew } from '../../../../shared/ipc/update-contract';
import { BrandWordmark } from '../../components/BrandLogo';
import { Modal } from '../../components/Modal';
import { useToastStore } from '../../stores/toasts';
import { Markdown } from './Markdown';
import { errorText, fetchWhatsNewOnce, updateInvoke } from './update-api';

const useWhatsNew = create<{ notes: WhatsNew | null; set(n: WhatsNew | null): void }>((set) => ({
  notes: null,
  set: (notes) => set({ notes }),
}));

/** Opens the release notes for the running version on demand (e.g. Help › What's new). */
export async function showWhatsNew(): Promise<void> {
  try {
    const notes = await updateInvoke('update:whatsNew', { force: true });
    if (notes) useWhatsNew.getState().set(notes);
    else useToastStore.getState().push({ kind: 'info', title: 'No release notes for this version' });
  } catch (e) {
    useToastStore
      .getState()
      .push({ kind: 'error', title: 'Could not load release notes', body: errorText(e) });
  }
}

/** "What's new" (spec 15 §4): shown once after the app version changes, from the bundled CHANGELOG. */
export function WhatsNewDialog() {
  const notes = useWhatsNew((s) => s.notes);
  const setNotes = useWhatsNew((s) => s.set);
  useEffect(() => {
    void fetchWhatsNewOnce().then((n) => {
      if (n) setNotes(n);
    });
  }, [setNotes]);
  return (
    <Modal
      title={notes ? `What's new in GitHappens ${notes.version}` : "What's new"}
      open={notes !== null}
      onClose={() => setNotes(null)}
    >
      {notes && (
        <>
          <BrandWordmark size={20} />
          <Markdown source={notes.markdown} />
        </>
      )}
    </Modal>
  );
}
