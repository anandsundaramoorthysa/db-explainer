import * as vscode from 'vscode';
import { AiError, ChatMessage } from './client';
import { CopilotBridge } from './service';

/** Copilot's chat models, reached through VS Code, so no API key is needed. VS Code asks the developer once to allow it. */
export function vscodeCopilot(timeoutMs = 60000): CopilotBridge & { onChange: (fn: () => void) => vscode.Disposable } {
  const select = (id?: string): Thenable<vscode.LanguageModelChat[]> => vscode.lm.selectChatModels({ vendor: 'copilot', ...(id ? { id } : {}) });
  return {
    async models() {
      try {
        return [...new Set((await select()).map((m) => m.id))];
      } catch {
        return [];
      }
    },
    onChange: (fn) => vscode.lm.onDidChangeChatModels(fn),
    async chat(model: string, messages: ChatMessage[], onText?: (soFar: string) => void): Promise<string> {
      const [m] = await select(model);
      if (!m) throw new AiError(`Copilot has no model called "${model}" any more.`, 'model');
      // These models take no system message, so the instructions go first as the developer's own words.
      const turns = messages.map((x) => (x.role === 'assistant' ? vscode.LanguageModelChatMessage.Assistant(x.content) : vscode.LanguageModelChatMessage.User(x.role === 'system' ? `Instructions for this conversation:\n${x.content}` : x.content)));
      const cancel = new vscode.CancellationTokenSource();
      let timedOut = false;
      let timer = setTimeout(() => ((timedOut = true), cancel.cancel()), timeoutMs);
      try {
        const res = await m.sendRequest(turns, { justification: 'DB Explainer sends your question, the structure of your database and your team notes, never row values, to answer it.' }, cancel.token);
        let text = '';
        for await (const piece of res.text) {
          clearTimeout(timer);
          timer = setTimeout(() => ((timedOut = true), cancel.cancel()), timeoutMs);
          text += piece;
          onText?.(text);
        }
        if (!text.trim()) throw new AiError('Copilot returned an empty answer.', 'empty');
        return text.trim();
      } catch (e) {
        if (e instanceof AiError) throw e;
        if (timedOut) throw new AiError('Copilot took too long to answer.', 'timeout');
        const code = String((e as { code?: unknown }).code ?? '');
        if (code === vscode.LanguageModelError.NoPermissions.name) throw new AiError('DB Explainer is not allowed to use Copilot yet. Choose Allow when VS Code asks, then ask again.', 'auth');
        if (code === vscode.LanguageModelError.Blocked.name) throw new AiError('Copilot is busy or you have reached its limit. Try again shortly, or switch profile in the status bar.', 'rate');
        if (code === vscode.LanguageModelError.NotFound.name) throw new AiError(`Copilot has no model called "${model}" any more.`, 'model');
        throw new AiError(`Copilot could not answer: ${(e as Error).message ?? e}`, 'server');
      } finally {
        clearTimeout(timer);
        cancel.dispose();
      }
    },
  };
}
