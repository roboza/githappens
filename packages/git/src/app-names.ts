/** Names the app writes into repositories. */

/** Per-repo state directory inside the git dir (`<gitDir>/githappens/…`). */
export const APP_DIR_NAME = 'githappens';

/** Hidden ref namespace (undo pins, PR heads, push previews, Git Flow pins); never surfaced to the UI. */
export const HIDDEN_REF_PREFIX = 'refs/githappens/';

export const isHiddenRef = (fullName: string): boolean => fullName.startsWith(HIDDEN_REF_PREFIX);

/** Git config section for app keys (`githappens.ai`, `githappens.agentSetup`). */
export const CONFIG_SECTION = 'githappens';
