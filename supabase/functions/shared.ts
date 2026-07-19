/**
 * Resolves the target response language based on user profile settings
 * and optional request-level overrides.
 *
 * Rules:
 * 1. Use request-level override or ui_language_override if set.
 * 2. If not, use the ui_language from the profile.
 * 3. Fallback to academic version default:
 *    - 'bangla_version' -> Bengali
 *    - 'english_version'/'english_medium' -> English
 */
export function resolveLanguage(profile: any, requestOverride?: string): 'Bengali' | 'English' {
  const lang = requestOverride || profile?.ui_language_override || profile?.ui_language;
  if (lang) {
    const l = lang.toLowerCase();
    if (l.startsWith('bn') || l === 'bengali' || l === 'bangla') {
      return 'Bengali';
    }
    if (l.startsWith('en') || l === 'english') {
      return 'English';
    }
  }

  const version = profile?.version;
  if (version === 'bangla_version') {
    return 'Bengali';
  }

  return 'English';
}
