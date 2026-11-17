/** The part of a VS Code CancellationToken that is used. Kept as a shape so this needs no vscode import and can be tested. */
export interface TokenLike {
  isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

/** An AbortSignal that fires when the token is cancelled, also when it was cancelled already. Call dispose when done. */
export function abortOn(token: TokenLike): { signal: AbortSignal; dispose: () => void } {
  const abort = new AbortController();
  const sub = token.onCancellationRequested(() => abort.abort());
  if (token.isCancellationRequested) abort.abort();
  return { signal: abort.signal, dispose: () => sub.dispose() };
}
