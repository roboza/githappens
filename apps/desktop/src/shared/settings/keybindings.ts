import { z } from 'zod';

/**
 * User keybinding overrides (spec 13 §5.2), stored per profile in `profiles/<id>/keybindings.json`.
 *
 * Semantics: when a command has at least one override entry, the entries *replace* that command's
 * default bindings. An entry with an empty `key` means "no binding" (unbind). `mac` replaces `key`
 * on macOS. Keys are chords such as `ctrl+shift+k` or `mod+p` (`mod` = Ctrl, or Cmd on macOS).
 */
export interface KeybindingOverride {
  command: string;
  key: string;
  /** `textInputFocus` / `!textInputFocus`; omitted = everywhere. */
  when?: string;
  mac?: string;
}

const chord = z
  .string()
  .max(64)
  .regex(/^$|^[a-z0-9+\-=,./;'[\]\\`]+$/i, 'Invalid key chord');

export const keybindingOverrideSchema = z.object({
  command: z.string().min(1).max(200),
  key: chord,
  when: z.string().max(200).optional(),
  mac: chord.optional(),
});

export const keybindingOverridesSchema = z.array(keybindingOverrideSchema).max(2000);

export function parseKeybindingOverrides(
  raw: unknown,
): { ok: true; value: KeybindingOverride[] } | { ok: false; error: string } {
  const r = keybindingOverridesSchema.safeParse(raw);
  return r.success
    ? { ok: true, value: r.data }
    : { ok: false, error: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
}
