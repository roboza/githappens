import { choose } from '../../components/Dialogs';
import { useToastStore } from '../../stores/toasts';
import { errorText, reposInvoke } from './api';

/**
 * Help › "Install `githappens` command in PATH" (spec 03 §7 step 4): explain what will change, ask for
 * consent, install, and show a manual command when the app lacks permission.
 */
export async function installCliCommand(): Promise<void> {
  const toast = useToastStore.getState().push;
  let status;
  try {
    status = await reposInvoke('cli:status', {});
  } catch (e) {
    toast({ kind: 'error', title: 'Command-line tool', body: errorText(e) });
    return;
  }
  const r = await choose({
    title: status.installed ? 'Reinstall the githappens command?' : 'Install the githappens command',
    message: (
      <>
        {status.description}
        <br />
        Then run <code>githappens .</code> or <code>githappens -p &lt;path&gt;</code> to open a repository.
      </>
    ),
    choices: [
      { value: 'cancel', label: 'Cancel' },
      { value: 'install', label: status.installed ? 'Reinstall' : 'Install', primary: true },
    ],
  });
  if (r?.value !== 'install') return;
  try {
    const res = await reposInvoke('cli:install', {});
    if (res.ok) {
      toast({ kind: 'success', title: 'Command-line tool installed', body: res.message });
      return;
    }
    if (res.manualCommand) {
      await choose({
        title: 'Finish installing the githappens command',
        message: (
          <>
            {res.message}
            <pre style={{ whiteSpace: 'pre-wrap', userSelect: 'text' }}>
              <code>{res.manualCommand}</code>
            </pre>
          </>
        ),
        choices: [{ value: 'ok', label: 'Close', primary: true }],
      });
    } else toast({ kind: 'error', title: 'Could not install the command', body: res.message });
  } catch (e) {
    toast({ kind: 'error', title: 'Could not install the command', body: errorText(e) });
  }
}
