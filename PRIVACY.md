# Privacy

DB Explainer collects no personal data and has no telemetry or analytics.

## Stored on your computer

| What | Where | Why |
|---|---|---|
| Saved connections (host, port, database, user, file path; no password) | VS Code global state. It can sync through Settings Sync if you have that turned on | List your databases |
| Database passwords and your AI API key | VS Code secret storage | Connect and call your AI service |
| The AI hosts you allowed | VS Code global state | Ask once before sending to a host that is not on your computer |
| Team notes | `.dbexplainer/notes.md` in your workspace (path is a setting) | Shared meaning of tables and values |

Remove a connection from the sidebar to delete its saved details and password. Use **DB Explainer: AI: Clear API Key** to remove the key.

## What is sent to your AI service

Each question sends one request to the service at `dbExplainer.ai.baseUrl`. It contains:

- your question and the recent conversation
- names, types, keys and indexes of the tables relevant to the question, and a list of all table names
- row counts and simple statistics (how many values are empty or different, and minimum and maximum for numbers and dates)
- the matching lines of your team notes
- for shared SQL, the text of the file you shared

**Row values are not sent** unless you press **Let the AI see these rows**. Then up to `dbExplainer.ai.sampleRows` rows are sent, with columns that look sensitive (such as email, phone, password, token, card, national ID) replaced by `[hidden]` and emails, long numbers and tokens removed from other values. This reduces the risk but cannot catch everything.

What the AI service does with the request is governed by that service's own terms. A local server such as Ollama keeps everything on your machine.

## Contact

Questions: [sanand03072005@gmail.com](mailto:sanand03072005@gmail.com).
