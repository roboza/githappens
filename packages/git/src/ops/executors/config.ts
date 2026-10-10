import { configSetArgs, isSecretConfigKey, withGlobalConfigLock } from '../../service/config';
import type { OpRegistry } from '../queue';
import { define, git } from './util';

/** `git:config:set` (spec 02 §5.3, §6.11): queued because it takes `config.lock`. */
export const configOps: OpRegistry = {
  'config.set': define(
    'config.set',
    {
      label: (op) => (op.value === null ? `Unset ${op.key}` : `Set ${op.key}`),
      touches: ['config', 'remotes', 'submodules'],
    },
    async (ctx, op) => {
      const args = configSetArgs(op.key, op.value, op.scope);
      const write = () => git(ctx, args, { expectedExitCodes: op.value === null ? [0, 5] : [0] });
      await (op.scope === 'global' ? withGlobalConfigLock(write) : write());
      const shown = op.value === null ? '' : isSecretConfigKey(op.key) ? ' = ***' : ` = ${op.value}`;
      return { summary: `${op.value === null ? 'Unset' : 'Set'} ${op.key}${shown}` };
    },
  ),
};
