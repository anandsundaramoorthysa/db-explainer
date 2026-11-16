/* Choosing a model from a service's own list when the one in use is gone. No vscode import, so it can be tested on its own. */

/** Ids that are not chat models: speech, embeddings, safety filters, image and agent systems. */
const NOT_CHAT = /(embed|whisper|tts|speech|audio|transcri|guard|moderat|rerank|dall-e|image|imagen|veo|realtime|search|davinci|babbage|^text-|playai|orpheus|compound|safeguard|distil|aqa|learnlm|computer-use)/i;

export function isChatModel(id: string): boolean {
  return !!id.trim() && !NOT_CHAT.test(id);
}

/** A rough "how capable" score from the name alone: size in billions of parameters, plus or minus well-known tier words. */
export function modelScore(id: string): number {
  const sizes = [...id.toLowerCase().matchAll(/(\d+(?:\.\d+)?)b(?![a-z])/g)].map((m) => Number(m[1]));
  let score = Math.min(sizes.length ? Math.max(...sizes) : 0, 1000);
  if (/(^|[-_/.:])(pro|large|versatile|opus|sonnet|ultra|max|plus)($|[-_/.:])/i.test(id)) score += 40;
  // Whole words only: "gemini" contains "mini" but is not a small model.
  if (/(^|[-_/.:])(mini|nano|lite|instant|small|tiny|haiku)($|[-_/.:])/i.test(id)) score -= 30;
  if (/(preview|exp($|[-_])|experimental|beta)/i.test(id)) score -= 15;
  return score;
}

/** Chat models only, most capable first. Ties keep the service's own order. */
export function rankModels(ids: string[]): string[] {
  const unique = [...new Set(ids.map((m) => m.replace(/^models\//, '')))].filter(isChatModel);
  return unique.map((id, i) => ({ id, i, s: modelScore(id) })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.id);
}

/**
 * The models to try, in order, when `current` is gone: the developer's own saved models that the service still offers, then the
 * service's other models, best first. With no list from the service, only the saved ones.
 */
export function replacementsFor(current: string, saved: string[], listed: string[], max = 6): string[] {
  const offered = new Set(listed.map((m) => m.replace(/^models\//, '')));
  const own = saved.filter((m) => m !== current && (!offered.size || offered.has(m)));
  const rest = rankModels(listed).filter((m) => m !== current && !own.includes(m));
  return [...own, ...rest].slice(0, max);
}
