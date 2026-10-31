import { keyProblem } from './ai/keyScan';
import { isValidDate, Profile, ProfileStore } from './ai/profiles';
import { AiService } from './ai/service';

export interface ChangeKeyDeps {
  store: ProfileStore;
  service: AiService;
  /** One password box. Returns undefined if the developer cancels. */
  promptKey: (forWhat: string) => PromiseLike<string | undefined>;
  /** One date box, filled with the current date. Undefined means Escape (keep it), an empty string means remove it. */
  promptDate: (current: string) => PromiseLike<string | undefined>;
  /** Used when there are no profiles: the old single key. */
  setLegacyKey: (key: string) => PromiseLike<void>;
  /** Shows the outcome. The key is never part of `text`. */
  report: (ok: boolean, text: string, profileId?: string) => void;
}

/** The one way to change a key: ask for it, keep it, optionally ask for the new expiry, then check it works. */
export async function changeKey(d: ChangeKeyDeps, profileId?: string): Promise<void> {
  const profile: Profile | undefined = d.store.get(profileId) ?? (profileId ? undefined : d.store.active());
  if (profileId && !profile) return;
  const typed = (await d.promptKey(profile ? `"${profile.label}"` : 'your AI service'))?.trim();
  if (!typed) return;
  const problem = keyProblem(typed);
  if (problem) {
    d.report(false, `${problem} Nothing was changed.`, profile?.id);
    return;
  }
  if (!profile) {
    await d.setLegacyKey(typed);
  } else {
    // The profile may have been deleted while the box was open. Do not bring it back or store a key for nothing.
    if (!d.store.get(profile.id)) return;
    await d.store.setKey(profile.id, typed);
    // An old expiry date would make the new key look expired, so offer to update it in the same go.
    if (profile.expiresAt) {
      const date = (await d.promptDate(profile.expiresAt))?.trim();
      if (date !== undefined && (date === '' || isValidDate(date))) {
        // Start from the profile as it is now, not as it was before the boxes opened, so edits made in between are kept.
        const now = d.store.get(profile.id);
        if (now) {
          const { expiresAt: _old, ...rest } = now;
          await d.store.save(date ? { ...rest, expiresAt: date } : rest);
        }
      } else if (date !== undefined) {
        d.report(false, 'That is not a real date (YYYY-MM-DD), so the expiry date was left as it was.', profile.id);
      }
    }
  }
  const r = await d.service.test(profile?.id);
  d.report(r.ok, r.ok ? `Key saved. ${r.message}` : `Key saved, but the check failed: ${r.message}`, profile?.id);
}
