# Bring your own AI

DB Explainer has no AI of its own. It works with Gemini, Groq, OpenRouter, OpenAI, Claude or a local Ollama.

1. Run **DB Explainer: Manage AI Keys** and press **Add profile**. Choose Gemini, Groq, OpenRouter, OpenAI, Claude or Ollama; the address and a model are filled in for you.
2. Paste your key. It is stored in VS Code secret storage, never in settings, and is never sent anywhere except that service.
3. Press **Test connection** to check.
4. To change a key later, press **Change key** on the profile (or click the AI item in the status bar). One box, then it is checked for you.

Optional: tick **Manage AI Keys > Fall back to the next valid profile on 401, 429 or 503** to move on to the next profile when one is rejected or busy.

You can also paste a key into the chat: it is never sent, and you are offered to save it as a profile.

The first time you use a service that is not on your own computer, you are asked to allow it. What is sent: table and column names, your notes and your questions. Row values are never sent unless you choose to.
