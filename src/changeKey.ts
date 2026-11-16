import { keyProblem } from './ai/keyScan';
import { addKeysToProfile } from './ai/profileForm';
import { isValidDate, keysOf, Profile, ProfileStore } from './ai/profiles';
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

const DUPLICATE = 'That key is already saved on this profile.';

/** The one way to change a key: ask for it, keep it, optionally ask for the new expiry, then check it works. With no keyId it is the key in use. */
export async function changeKey(d: ChangeKeyDeps, profileId?: string, keyId?: string): Promise<void> {
  const profile: Profile | undefined = d.store.get(profileId) ?? (profileId ? undefined : d.store.active());
  if (profileId && !profile) return;
  const keys = profile ? keysOf(profile) : [];
  const target = profile ? (keys.find((k) => k.id === keyId) ?? keys.find((k) => k.id === d.store.currentKeyId(profile))) : undefined;
  const position = target ? keys.indexOf(target) + 1 : 0;
  const typed = (await d.promptKey(profile ? `"${profile.label}"${keys.length > 1 ? `, key ${position}` : ''}` : 'your AI service'))?.trim();
  if (!typed) return;
  const problem = keyProblem(typed);
  if (problem) {
    d.report(false, `${problem} Nothing was changed.`, profile?.id);
    return;
  }
  if (!profile || !target) {
    await d.setLegacyKey(typed);
  } else {
    // The profile may have been deleted while the box was open. Do not bring it back or store a key for nothing.
    const latest = d.store.get(profile.id);
    if (!latest || !keysOf(latest).some((k) => k.id === target.id)) return;
    if (await d.store.duplicateOf(latest, typed, target.id)) {
      d.report(false, `${DUPLICATE} Nothing was changed.`, profile.id);
      return;
    }
    await d.store.setKey(profile.id, typed, target.id);
    // An old expiry date would make the new key look expired, so offer to update it in the same go.
    if (target.expiresAt) {
      const date = (await d.promptDate(target.expiresAt))?.trim();
      if (date !== undefined && (date === '' || isValidDate(date))) {
        // The store starts from the profile as it is now, not as it was before the boxes opened, so edits made in between are kept.
        await d.store.setKeyExpiry(profile.id, target.id, date);
      } else if (date !== undefined) {
        d.report(false, 'That is not a real date (YYYY-MM-DD), so the expiry date was left as it was.', profile.id);
      }
    }
  }
  const r = await d.service.test(profile?.id, target?.id);
  d.report(r.ok, r.ok ? `Key saved. ${r.message}` : `Key saved, but the check failed: ${r.message}`, profile?.id);
}

/** Adds keys and checks each one straight away. Returns the outcome in one sentence, and whether every key added works. */
export async function addAndCheckKeys(store: ProfileStore, service: AiService, id: string, text: string, expiresAt?: string): Promise<{ ok: boolean; text: string }> {
  const r = await addKeysToProfile(store, id, text, expiresAt);
  if (r.error) return { ok: false, text: `${r.error} Nothing was added.` };
  if (!r.added.length) return { ok: false, text: r.duplicates ? `${DUPLICATE} Nothing was added.` : 'Nothing was added.' };
  const tests = [];
  for (const keyId of r.added) tests.push(await service.test(id, keyId));
  const bad = tests.filter((t) => !t.ok);
  const count = `${r.added.length} key${r.added.length === 1 ? '' : 's'} added`;
  const skipped = r.duplicates ? ` ${r.duplicates} already saved, so skipped.` : '';
  return bad.length ? { ok: false, text: `${count}, but ${bad.length} failed the check: ${bad[0].message}${skipped}` } : { ok: true, text: `${count} and checked.${skipped}` };
}

/** Adds keys from one box. Several can be pasted together. The keys never pass through the web page. */
export async function addKey(d: ChangeKeyDeps, profileId?: string): Promise<void> {
  const profile = d.store.get(profileId) ?? (profileId ? undefined : d.store.active());
  if (!profile) return;
  const typed = (await d.promptKey(`"${profile.label}" (paste several separated by spaces if you like)`))?.trim();
  if (!typed) return;
  const r = await addAndCheckKeys(d.store, d.service, profile.id, typed);
  d.report(r.ok, r.text, profile.id);
}
