import { AVATAR_SCHEME } from '../../shared/ipc/graph-contract';
import type { AvatarService } from './avatar-service';

/** Privileges of the avatar scheme: a standard, secure scheme usable from `<img>` and canvas. */
export const AVATAR_SCHEME_PRIVILEGES = {
  scheme: AVATAR_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
} as const;

/** Subset of Electron's `protocol` module used here (keeps this module testable without Electron). */
export interface ProtocolLike {
  registerSchemesAsPrivileged?(schemes: Array<typeof AVATAR_SCHEME_PRIVILEGES>): void;
  handle(scheme: string, handler: (request: Request) => Response | Promise<Response>): void;
}

/**
 * Must run before `app.ready` (Electron allows `registerSchemesAsPrivileged` only once, so if other
 * schemes are added later, pass `AVATAR_SCHEME_PRIVILEGES` in the same call instead).
 */
export function registerAvatarScheme(
  protocol: Required<Pick<ProtocolLike, 'registerSchemesAsPrivileged'>>,
): void {
  protocol.registerSchemesAsPrivileged([AVATAR_SCHEME_PRIVILEGES]);
}

/** After `app.ready`: serve `githappens-avatar://avatar/<hash>?s=<size>` from the AvatarService. */
export function handleAvatarProtocol(protocol: Pick<ProtocolLike, 'handle'>, svc: AvatarService): void {
  protocol.handle(AVATAR_SCHEME, (request) => svc.handle(request));
}
