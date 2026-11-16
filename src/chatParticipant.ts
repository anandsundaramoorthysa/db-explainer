import * as vscode from 'vscode';
import { detectApiKey } from './ai/keyScan';
import { Conversation } from './chat/conversation';
import { SourceManager } from './sources';

export interface ParticipantDeps {
  sources: SourceManager;
  /** Its own conversation, so Copilot Chat and the DB Explainer panel keep separate histories. */
  conversation: Conversation;
  aiReady: () => boolean;
  copilotAvailable: () => boolean;
}

/** @dex in Copilot Chat: the same answers as the DB Explainer panel, with the same checks and the same privacy. */
export function registerDex(context: vscode.ExtensionContext, deps: ParticipantDeps): void {
  const handler: vscode.ChatRequestHandler = async (request, chatContext, stream) => {
    // A new Copilot chat starts a new conversation here too.
    if (!chatContext.history.length) deps.conversation.reset();
    const source = deps.sources.active();
    if (!source) {
      stream.markdown('Nothing is shared with DB Explainer yet.');
      stream.button({ command: 'dbExplainer.trySample', title: 'Try the sample database' });
      stream.button({ command: 'dbExplainer.addConnection', title: 'Add a database connection' });
      return;
    }
    if (!deps.aiReady()) {
      stream.markdown('DB Explainer has no AI set up yet.');
      if (deps.copilotAvailable()) stream.button({ command: 'dbExplainer.ai.useCopilot', title: 'Use Copilot (no key)' });
      stream.button({ command: 'dbExplainer.ai.manage', title: 'Manage AI keys' });
      return;
    }
    if (detectApiKey(request.prompt)) {
      stream.markdown('That looks like an API key, so it was not sent anywhere. Save keys in **DB Explainer: Manage AI Keys** instead.');
      return;
    }
    stream.progress(`Looking at ${source.label}...`);
    try {
      const a = await deps.conversation.ask(source, request.prompt, undefined, { draft: () => undefined, checking: () => stream.progress('Checking the answer...') });
      stream.markdown(a.text);
      if (a.sql.length && source.connector) stream.button({ command: 'dbExplainer.openChat', title: 'Open DB Explainer to run it' });
    } catch (e) {
      stream.markdown(`DB Explainer could not answer: ${(e as Error).message}`);
    }
  };
  const dex = vscode.chat.createChatParticipant('dbExplainer.dex', handler);
  dex.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
  context.subscriptions.push(dex);
}
