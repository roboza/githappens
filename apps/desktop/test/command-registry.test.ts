import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  acceptsFreeText,
  fetchArgItems,
  getArgProvider,
  registerArgProvider,
} from '../src/renderer/src/commands/args';
import { clearMru, getMru } from '../src/renderer/src/commands/mru';
import { parsePrefix } from '../src/renderer/src/commands/prefix';
import {
  DEFAULT_CONTEXT,
  disabledReason,
  getCommand,
  getCommands,
  getContext,
  isCommandEnabled,
  registerCommands,
  runCommand,
  setArgRequestHandler,
  setContextProvider,
  useCommandRegistry,
} from '../src/renderer/src/commands/registry';
import type { CommandDef } from '../src/renderer/src/commands/types';

const disposers: (() => void)[] = [];
const reg = (defs: CommandDef[]): (() => void) => {
  const d = registerCommands(defs);
  disposers.push(d);
  return d;
};

afterEach(() => {
  disposers.splice(0).forEach((d) => d());
  setContextProvider(() => DEFAULT_CONTEXT);
  setArgRequestHandler(undefined);
  clearMru();
  vi.restoreAllMocks();
});

const cmd = (id: string, extra: Partial<CommandDef> = {}): CommandDef => ({
  id,
  title: id,
  category: 'View',
  run: vi.fn(),
  ...extra,
});

describe('command registry', () => {
  it('registers and unregisters commands', () => {
    const dispose = reg([cmd('a'), cmd('b')]);
    expect(getCommands().map((c) => c.id)).toEqual(['a', 'b']);
    dispose();
    expect(getCommands()).toEqual([]);
    dispose(); // idempotent
    expect(useCommandRegistry.getState().entries).toEqual([]);
  });

  it('later registrations shadow earlier ones until disposed', () => {
    const first = cmd('x', { title: 'First' });
    reg([first, cmd('y')]);
    const dispose = reg([cmd('x', { title: 'Second' })]);
    expect(getCommand('x')?.title).toBe('Second');
    expect(getCommands().map((c) => c.id)).toEqual(['x', 'y']);
    dispose();
    expect(getCommand('x')).toBe(first);
  });

  it('runs a command with the current context and an argument, recording MRU', async () => {
    const run = vi.fn();
    reg([cmd('branch.checkout', { arg: { kind: 'branch' }, run })]);
    setContextProvider(() => ({ ...DEFAULT_CONTEXT, activeRepo: '/r' }));
    await expect(runCommand('branch.checkout', 'main')).resolves.toBe('ran');
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ activeRepo: '/r' }), 'main');
    expect(getMru()[0]).toBe('branch.checkout');
  });

  it('does not run disabled commands and exposes the reason', async () => {
    const run = vi.fn();
    const c = cmd('remote.push', {
      run,
      when: (ctx) => ctx.hasRemotes,
      whenReason: () => 'No remotes configured',
    });
    reg([c]);
    expect(isCommandEnabled(c)).toBe(false);
    expect(disabledReason(c)).toBe('No remotes configured');
    await expect(runCommand('remote.push')).resolves.toBe('disabled');
    expect(run).not.toHaveBeenCalled();

    setContextProvider(() => ({ ...DEFAULT_CONTEXT, hasRemotes: true }));
    expect(disabledReason(c)).toBeUndefined();
    await expect(runCommand('remote.push')).resolves.toBe('ran');
    expect(run).toHaveBeenCalledOnce();
  });

  it('asks for the argument when a two-stage command runs without one', async () => {
    const run = vi.fn();
    const handler = vi.fn();
    setArgRequestHandler(handler);
    reg([cmd('repo.open', { arg: { kind: 'repo' }, run })]);
    await expect(runCommand('repo.open')).resolves.toBe('needsArg');
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: 'repo.open' }));
    expect(run).not.toHaveBeenCalled();
  });

  it('reports unknown ids and propagates run errors', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(runCommand('nope')).resolves.toBe('notFound');
    reg([
      cmd('boom', {
        run: () => {
          throw new Error('kaput');
        },
      }),
    ]);
    await expect(runCommand('boom')).rejects.toThrow('kaput');
  });

  it('falls back to the default context when the provider throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setContextProvider(() => {
      throw new Error('x');
    });
    expect(getContext()).toEqual(DEFAULT_CONTEXT);
  });
});

describe('argument providers', () => {
  it('registers, shadows and disposes providers', async () => {
    const d1 = registerArgProvider('branch', () => [{ id: 'main', label: 'main' }]);
    const d2 = registerArgProvider('branch', async (q) => [{ id: q, label: q }]);
    expect(await fetchArgItems('branch', 'dev')).toEqual([{ id: 'dev', label: 'dev' }]);
    d2();
    expect(await fetchArgItems('branch', 'dev')).toEqual([{ id: 'main', label: 'main' }]);
    d1();
    expect(getArgProvider('branch')).toBeUndefined();
    expect(await fetchArgItems('branch', '')).toEqual([]);
  });

  it('applies kind defaults for filtering and free text', () => {
    const d = registerArgProvider('commitQuery', () => []);
    expect(getArgProvider('commitQuery')).toMatchObject({ filter: 'none', allowFreeText: true });
    d();
    const d2 = registerArgProvider('tag', () => []);
    expect(getArgProvider('tag')).toMatchObject({ filter: 'fuzzy', allowFreeText: false });
    expect(acceptsFreeText('tag')).toBe(false);
    d2();
    expect(acceptsFreeText('tag')).toBe(true); // no provider: free text
    expect(acceptsFreeText('text')).toBe(true);
  });

  it('swallows provider errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = registerArgProvider('stash', () => Promise.reject(new Error('x')));
    expect(await fetchArgItems('stash', '')).toEqual([]);
    d();
  });
});

describe('prefix modes', () => {
  it('parses palette prefixes', () => {
    expect(parsePrefix('fetch')).toEqual({ mode: null, rest: 'fetch' });
    expect(parsePrefix('> fetch')).toEqual({ mode: null, rest: 'fetch' });
    expect(parsePrefix('@main').mode?.kind).toBe('branch');
    expect(parsePrefix('#src/app').mode?.kind).toBe('file');
    expect(parsePrefix(': fix bug')).toMatchObject({ mode: { kind: 'commitQuery' }, rest: 'fix bug' });
  });
});
