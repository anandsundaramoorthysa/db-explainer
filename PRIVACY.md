# Privacy

DB Explainer collects no personal data and has no telemetry or analytics.

## Stored on your computer

| What | Where | Why |
|---|---|---|
| Saved connections (host, port, database, user, file path; no password) | VS Code global state. It can sync through Settings Sync if you have that turned on | List your databases |
| AI profiles (label, provider, address, model, expiry date; no key) | VS Code global state | List your AI services |
| Database passwords and each AI profile's API key | VS Code secret storage, never settings | Connect and call your AI service |
| The AI hosts you allowed | VS Code global state | Ask once before sending to a host that is not on your computer |
| Team notes | `.dbexplainer/notes.md` in your workspace (path is a setting) | Shared meaning of tables and values |

Remove a connection from the sidebar to delete its saved details and password. Delete a profile in **Manage AI Keys** to remove its key, or use **DB Explainer: Remove API Key** for the one in use. A key you paste into the chat is not sent, not kept in the conversation and not saved in the notes.

## What is sent to your AI service

Each question sends one request to the service of the profile in use (or the one at `dbExplainer.ai.baseUrl` if you have no profiles). If you turn on `dbExplainer.ai.fallback` and that service answers 401, 429 or 503, the same request goes to the next valid profile instead, and you are asked to allow its host first. Expired keys are never used. It contains:

- your question and the recent conversation
- names, types, keys and indexes of the tables relevant to the question, and a list of all table names
- row counts and simple statistics (how many values are empty or different, and minimum and maximum for numbers and dates)
- the matching lines of your team notes
- for shared SQL, the text of the file you shared

Before an answer is shown, DB Explainer checks the SQL it contains. On a live connection it asks the database to compile each query without running it, so no rows are read: `EXPLAIN` on SQLite, MySQL, MariaDB and PostgreSQL, and `sp_describe_first_result_set` on SQL Server. If the database refuses a query, the database's error message (it names tables, columns or SQL keywords) is sent to your AI service once, so the assistant can correct the query. Shared SQL has no database to ask.

When you ask why a query is slow, the database's plan for it is sent too. The plan comes from `EXPLAIN`, which does not run the query: it holds the database's estimates (such as how many rows it expects to read) and the query's own text, not row values.

If you use GitHub Copilot, the same request goes to Copilot through VS Code instead of to an address you set, under GitHub's terms. VS Code asks you once to allow DB Explainer to use Copilot, and DB Explainer asks once too. `@dex` in Copilot Chat sends exactly what the DB Explainer chat sends.

The checks that underline problems in .sql files, the table diagram and the data dictionary send nothing anywhere: they work from the structure on your computer.

**Row values are not sent** unless you press **Let the AI see these rows**. Then up to `dbExplainer.ai.sampleRows` rows are sent, with columns that look sensitive (such as email, phone, password, token, card, national ID) replaced by `[hidden]` and emails, long numbers and tokens removed from other values. This reduces the risk but cannot catch everything.

What the AI service does with the request is governed by that service's own terms. A local server such as Ollama keeps everything on your machine.

## Contact

Questions: [sanand03072005@gmail.com](mailto:sanand03072005@gmail.com).
