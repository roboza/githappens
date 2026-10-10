import { describe, expect, it } from 'vitest';

import { EVENT_CHANNELS, INVOKE_CHANNELS } from '../src/shared/ipc/contract';

/**
 * spec 02 §9 "Every IPC channel in §5.3 is implemented": each channel / event named in the §5.3 contract is
 * allowlisted (the `ipc.test` coverage test then guarantees a handler for every allowlisted channel, and the
 * contract's `Exhaustive` check keeps the typed contract and the allowlist in sync).
 */
const SPEC_INVOKE = [
  'git:repo:open',
  'git:repo:close',
  'git:repo:info',
  'git:engine:info',
  'git:engine:setExecutable',
  'git:status',
  'git:log:start',
  'git:log:next',
  'git:log:dispose',
  'git:commit:detail',
  'git:refs',
  'git:revParse',
  'git:mergeBase',
  'git:isAncestor',
  'git:diff',
  'git:diff:numstat',
  'git:show:file',
  'git:blame',
  'git:stash:list',
  'git:remotes',
  'git:config:list',
  'git:config:get',
  'git:worktrees',
  'git:submodules',
  'git:conflicts',
  'git:config:set',
  'git:op:run',
  'git:op:cancel',
  'git:lock:remove',
  'git:output:list',
  'git:prompt:answer',
] as const;

const SPEC_EVENTS = [
  'git:progress',
  'git:op:state',
  'git:repo:changed',
  'git:output:append',
  'git:prompt',
  'git:engine:changed',
] as const;

describe('spec 02 §5.3 channels', () => {
  it('every invoke channel is part of the typed, allowlisted contract', () => {
    const missing = SPEC_INVOKE.filter((c) => !(INVOKE_CHANNELS as readonly string[]).includes(c));
    expect(missing).toEqual([]);
  });

  it('every event is part of the typed, allowlisted contract', () => {
    const missing = SPEC_EVENTS.filter((c) => !(EVENT_CHANNELS as readonly string[]).includes(c));
    expect(missing).toEqual([]);
  });
});
