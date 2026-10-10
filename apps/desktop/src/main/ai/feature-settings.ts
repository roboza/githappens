import {
  AI_FEATURE_GROUP_INFO,
  AI_FEATURE_GROUP_OF,
  type AiEffort,
  type AiEffortOverrides,
  type AiFeature,
  type AiFeatureInstructions,
} from '../../shared/ipc/ai-contract';

/**
 * Per-feature AI settings (spec 12 §2.2 / §4.5), pure so they can be unit tested.
 *
 * Effort: per-feature override (`ai.effortOverrides`) → global `ai.effort` (unless `auto`) → feature default
 * (low for commit/stash messages, medium for explain/PR/changelog, high for conflicts/composer).
 */
export function resolveEffort(
  feature: AiFeature,
  globalEffort: AiEffort | 'auto' | undefined,
  overrides: AiEffortOverrides | undefined,
): AiEffort {
  const group = AI_FEATURE_GROUP_OF[feature];
  const own = overrides?.[group];
  if (own) return own;
  if (globalEffort && globalEffort !== 'auto') return globalEffort;
  return AI_FEATURE_GROUP_INFO[group].defaultEffort;
}

/** The feature's own custom instructions (`ai.featureInstructions`), trimmed; '' when none. */
export function featureInstructions(feature: AiFeature, map: AiFeatureInstructions | undefined): string {
  return map?.[AI_FEATURE_GROUP_OF[feature]]?.trim() ?? '';
}
