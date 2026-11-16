import { AiError, isLocalUrl, normalizeBaseUrl } from './client';
import { keyProblem } from './keyScan';
import { COPILOT_ADDRESS, isValidDate, keysOf, modelsOf, newProfileId, preset, PRIMARY_KEY, Profile, ProfileStore, Provider, withModel } from './profiles';

/** The Add and Edit form as the page sends it. No vscode import, so these rules can be tested on their own. */
export interface ProfileInput {
  id?: string;
  label?: string;
  provider?: Provider;
  baseUrl?: string;
  model?: string;
  expiresAt?: string;
  /** One key, or several separated by spaces, commas or line breaks. */
  key?: string;
}

export type AddressChoice = 'keep' | 'remove' | undefined;

export interface FormOptions {
  /** A key pasted in the chat, used for a new profile when none is typed. */
  pendingKey?: string;
  /** Saved keys would start going to a new host. Undefined means the developer backed out. */
  confirmAddress: (host: string, keyCount: number) => PromiseLike<AddressChoice>;
}

export function splitKeys(text: string | undefined): string[] {
  return [...new Set((text ?? '').split(/[\s,;]+/).filter(Boolean))];
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Saves the form. Returns the profile id, or the reason to show on the form. */
export async function saveProfileForm(store: ProfileStore, m: ProfileInput, opts: FormOptions): Promise<{ id: string } | { error: string }> {
  const existing = m.id ? store.get(m.id) : undefined;
  const provider = m.provider ?? 'custom';
  const label = (m.label ?? '').trim() || (provider === 'vscode' ? 'Copilot' : preset(provider).name);
  const model = (m.model ?? '').trim();
  if (provider === 'vscode') {
    // No address and no key: Copilot is reached through VS Code. Any keys an edited profile had are no longer needed.
    if (!model) return { error: 'Pick a Copilot model.' };
    const id = existing?.id ?? newProfileId();
    if (existing) for (const k of [...keysOf(existing)].reverse()) await store.removeKey(id, k.id);
    const base = existing ? modelsOf(withModel(existing, model)) : [model];
    await store.save({ id, label, provider, baseUrl: COPILOT_ADDRESS, model, models: base });
    return { id };
  }
  const baseUrl = (m.baseUrl ?? '').trim();
  const expiresAt = (m.expiresAt ?? '').trim();
  const typed = splitKeys(m.key);
  for (const k of typed) {
    const problem = keyProblem(k);
    if (problem) return { error: problem };
  }
  // A key typed in the form wins. Otherwise a key pasted in the chat is used for a new profile, and an existing one is kept.
  const first = typed[0] ?? (!existing ? opts.pendingKey : undefined);
  const hasKey = !!(first || (existing && (await store.usableKeys({ ...existing, expiresAt: undefined, extraKeys: existing.extraKeys?.map((k) => ({ id: k.id })) }, new Date())).length));

  if (!baseUrl) return { error: 'Enter the base URL of the service.' };
  try {
    normalizeBaseUrl(baseUrl, hasKey);
  } catch (e) {
    return { error: (e as AiError).message.replace(/ Fix the setting dbExplainer\.ai\.baseUrl\./, '') };
  }
  if (!model) return { error: 'Enter a model name.' };
  if (expiresAt && !isValidDate(expiresAt)) return { error: 'The expiry date must be a real date.' };
  if (!hasKey && !isLocalUrl(baseUrl)) return { error: 'This service needs an API key.' };

  // Saved keys belong to the service they were made for, so moving the address is a decision and not a side effect of an edit.
  let dropKeys: string[] = [];
  if (existing && hostOf(existing.baseUrl) !== hostOf(baseUrl)) {
    const moving: string[] = [];
    for (const k of keysOf(existing)) {
      const replaced = k.id === PRIMARY_KEY && typed.length > 0;
      if (!replaced && (await store.key(existing.id, k.id))) moving.push(k.id);
    }
    if (moving.length) {
      const choice = await opts.confirmAddress(hostOf(baseUrl) ?? baseUrl, moving.length);
      if (!choice) return { error: 'The address was not changed, and neither was anything else.' };
      if (choice === 'remove') dropKeys = moving;
    }
  }

  const profile: Profile = {
    id: existing?.id ?? newProfileId(),
    label,
    provider,
    baseUrl,
    model,
    ...(expiresAt ? { expiresAt } : {}),
    // The form edits the first key only. The other keys and saved models stay as they are.
    ...(existing?.extraKeys ? { extraKeys: existing.extraKeys } : {}),
    ...(existing?.currentKeyId ? { currentKeyId: existing.currentKeyId } : {}),
    ...(existing ? { models: modelsOf(withModel(existing, model)) } : {}),
  };
  await store.save(profile, first);
  // Extra keys first: removing the first key moves the next one into its place.
  for (const id of [...dropKeys].reverse()) await store.removeKey(profile.id, id);
  const { error } = await addKeysToProfile(store, profile.id, typed.slice(1).join(' '));
  return error ? { error } : { id: profile.id };
}

export interface AddOutcome {
  added: string[];
  duplicates: number;
  error?: string;
}

/** Adds one or more keys, separated by spaces, commas or line breaks. Keys already on the profile are skipped. */
export async function addKeysToProfile(store: ProfileStore, id: string, text: string, expiresAt?: string): Promise<AddOutcome> {
  const typed = splitKeys(text);
  for (const k of typed) {
    const problem = keyProblem(k);
    if (problem) return { added: [], duplicates: 0, error: problem };
  }
  if (expiresAt && !isValidDate(expiresAt)) return { added: [], duplicates: 0, error: 'The expiry date must be a real date.' };
  const added: string[] = [];
  let duplicates = 0;
  for (const key of typed) {
    const p = store.get(id);
    if (!p) break;
    if (await store.duplicateOf(p, key)) {
      duplicates++;
      continue;
    }
    // An empty first slot is filled first, so the first key is never missing while others are saved.
    if (!(await store.key(id))) {
      await store.setKey(id, key);
      if (expiresAt) await store.setKeyExpiry(id, PRIMARY_KEY, expiresAt);
      added.push(PRIMARY_KEY);
      continue;
    }
    const keyId = await store.addKey(id, key, expiresAt);
    if (keyId) added.push(keyId);
  }
  return { added, duplicates };
}
