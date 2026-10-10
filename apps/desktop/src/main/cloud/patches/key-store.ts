import { createHash } from 'node:crypto';

import { secretAccount, type SecretStore } from '../../secrets/secret-store';
import type { PatchKeyStore } from './patch-service';

/**
 * E2E keys of the user's own Cloud Patches in the SecretStore (spec 14: "Copy link" keeps working after a
 * restart). Account: `<profileId>/cloud/patch-key/<server hash>/<patchId>`; nothing is stored while no
 * server is configured. The server never sees these keys.
 */
export function createPatchKeyStore(o: {
  secrets: SecretStore;
  profileId(): string;
  serverUrl(): string | null;
}): PatchKeyStore {
  const account = (patchId: string): string | null => {
    const server = o.serverUrl();
    if (!server || !/^[A-Za-z0-9]{8,64}$/.test(patchId)) return null;
    const host = createHash('sha256').update(server.toLowerCase()).digest('hex').slice(0, 16);
    return secretAccount(o.profileId(), 'cloud', `patch-key/${host}/${patchId}`);
  };
  return {
    get(patchId) {
      const a = account(patchId);
      return a && o.secrets.available ? o.secrets.get(a) : null;
    },
    set(patchId, key) {
      const a = account(patchId);
      if (a && o.secrets.available) o.secrets.set(a, key);
    },
    delete(patchId) {
      const a = account(patchId);
      if (a && o.secrets.available) o.secrets.delete(a);
    },
  };
}
