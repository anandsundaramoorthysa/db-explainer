# DB Explainer

Understand any database by chatting with it. Share a live database (read-only) or a SQL file, then ask in plain English. No export, no setup scripts.

[![CI](https://github.com/anandsundaramoorthysa/db-explainer/actions/workflows/ci.yml/badge.svg)](https://github.com/anandsundaramoorthysa/db-explainer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## What it does

- **Meet Dex.** The chat assistant is called Dex.
- **Explains the database.** "What is the orders table for?" "How do payments connect to products?" "What does the status column mean?"
- **Checks its own SQL.** Mistakes the schema reveals are warned about before you run anything, and the assistant is asked to fix them.
- **Writes SQL for your goal.** "Top five customers by total spend this year." The query uses your real table and column names and your database's dialect.
- **Explains a query you paste.** Step by step, checked against the schema.
- **Runs queries when you ask.** Press Run under any SQL. See the rows in the chat.
- **Remembers what your team knows.** Notes such as "status 3 means shipped" live in a file in your repo and improve every answer.
- **Checks .sql files as you type, with no AI.** `= NULL`, a misspelled command, an unknown column, tables joined by a comma with nothing linking them, and filters that cannot use an index are underlined. Turn it off with `dbExplainer.editor.checks`.
- **Explain and Check speed above every statement.** One click explains a statement in the chat. Check speed asks the database how it would run the query (`EXPLAIN`, nothing is run) and explains how to make it faster, with the index to add.
- **A table diagram.** See every table and how they link, click one to ask about it, or copy it as Mermaid for a README.
- **A data dictionary.** One command writes a Markdown page describing every table, with the diagram and your team notes, ready to commit.
- **Try it with no setup.** "Try the sample database" opens a small store database that ships with the extension.
- **No key needed with GitHub Copilot.** Use Copilot's models through VS Code, or ask `@dex` in Copilot Chat.

## Two ways to share a database

| | Live connection | Shared SQL |
|---|---|---|
| How | Add a connection in the sidebar, or paste a connection string | Right-click a `.sql` file, or select SQL and run **Share SQL With the Chat** |
| Databases | MySQL and MariaDB, PostgreSQL, SQL Server, SQLite | Scripts for any of those, including SQL Server scripts |
| Explain and write SQL | Yes | Yes |
| Row counts and statistics | Yes | No |
| Run queries | Yes | No, there is no data |

## Safe by design

- **Read-only.** Only one SELECT (or EXPLAIN of a SELECT) can run. It is checked first, then run in a read-only transaction that is never committed, with a 100-row limit and a 15-second limit. SQLite files are copied into memory, so the file is never touched. Use a read-only database account too.
- **You press Run.** The AI suggests, you decide.
- **Rows stay private.** The AI sees names, keys, counts and simple statistics, never row values. If you want it to explain a result, press **Let the AI see these rows**: a few rows are sent, with sensitive-looking columns hidden.
- **Encrypted connections check the server's certificate.** For a self-signed certificate, choose your provider's certificate authority file, or connect without the check for that connection.
- **Passwords and keys** are kept in VS Code secret storage.
- **No telemetry.**

Details: [SECURITY.md](SECURITY.md) and [PRIVACY.md](PRIVACY.md).

## Get started

1. Open the **DB Explainer** icon in the activity bar.
2. Press **Try the sample database** to look around with no setup, or **Add a database connection** (pasting a connection string works), or share a SQL file.
3. Press **Use Copilot** if you have GitHub Copilot, or add a free AI key (below), then ask in the chat.
4. Open any `.sql` file: problems are underlined, and **Explain** and **Check speed** appear above each statement.

The sidebar's title bar also has **Show Table Diagram**, and the `...` menu has **Export Data Dictionary**. A short walkthrough opens from **Help > Welcome**.

## Bring your own AI

DB Explainer has no AI of its own. It works with GitHub Copilot (no key: press **Use Copilot** in the chat or run **DB Explainer: Use GitHub Copilot**), Gemini, Groq, OpenRouter, OpenAI, Claude or a local Ollama.

Open **DB Explainer: Manage AI Keys** and add a profile for **Gemini, Groq, OpenRouter, OpenAI, Claude or Ollama**. Each profile has its own address, model, key and optional expiry date. The status bar shows the one in use; click it to switch in one step.

- **Several keys on one profile.** Paste one or several keys in the box on a profile and each is checked straight away. When a key has expired, is refused (401 or 403) or hits a rate limit (429), the next valid key of that profile is used automatically and the chat tells you. Every key goes only to that profile's own address. Check your provider's terms before using several keys to get past its limits.
- **Several model versions on one profile.** Save versions under **Saved models** and press one to use it, or pick it from the status bar.
- **Retired models are replaced for you.** Saving a key checks which models the service offers today and picks the best one if yours is gone. If a model disappears later, the next question tries your other saved models and then the service's own list, best first, keeps the first one that answers, and tells you.
- **Keys stay in VS Code secret storage**, never in settings, and the page only shows the last four characters.
- **Warned 3 days before a key expires.** An expired key is never used.
- **Fallback (optional).** Turn on **Manage AI Keys > Fall back to the next valid profile on 401, 429 or 503** and a 401, 429 or 503 answer moves on to the next valid profile. Your table and column names then go to that service, and you are asked to allow it the first time.
- **A key pasted into the chat is never sent.** You are offered to save it as a profile instead.

### Change a key in one step

Click **Change key** on a profile, or the status bar then **Change key for ...**, or **DB Explainer: Change API Key**. Type the new key (and a new expiry date if the profile has one). It is saved and checked straight away. When a key is rejected, the error message has a **Change key** button too.

Existing `dbExplainer.ai.*` settings keep working until you save your first profile. After that, the profile replaces them.

| Setting | Meaning |
|---|---|
| `dbExplainer.ai.baseUrl` | Default `http://localhost:11434/v1` (Ollama). Also works with LM Studio, OpenAI, OpenRouter and others |
| `dbExplainer.ai.model` | For example `qwen2.5-coder:7b` or `gpt-4o-mini` |
| `dbExplainer.ai.maxTokensParam` | Switch to `max_completion_tokens` for models that require it |

**DB Explainer: Test AI Connection** checks the profile in use. The first time you use a host that is not on your computer, you are asked to allow it.

## Team notes

Run **DB Explainer: Add a Team Note**, or use the note box under an answer. Notes go in `.dbexplainer/notes.md`. Commit the file and your whole team gets the same answers.

## Commands

| Command | What it does |
|---|---|
| DB Explainer: Open Chat | Opens the chat panel |
| DB Explainer: Try the Sample Database | Opens a small read-only store database, so you can try everything with no setup |
| DB Explainer: Explain This SQL / Why Is This Query Slow? | Act on the statement under the cursor (also above each statement, and on the editor's right-click menu) |
| DB Explainer: Show Table Diagram / Export Data Dictionary | Picture and Markdown description of the database in use |
| DB Explainer: Use GitHub Copilot (No Key) | Sets up Copilot in one step |
| DB Explainer: Add Database Connection | Saves and connects a database |
| DB Explainer: Share SQL With the Chat | Shares the open file, the selection, or clipboard SQL |
| DB Explainer: Refresh Schema | Reads the structure again |
| DB Explainer: Add a Team Note / Open Team Notes | Works with the notes file |
| DB Explainer: Manage AI Keys / Switch AI Profile / Change API Key | Profiles for Gemini, Groq, OpenRouter, OpenAI, Claude and Ollama |
| DB Explainer: Change API Key / Remove API Key / Test AI Connection | Act on the profile in use |

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `dbExplainer.query.maxRows` | 100 | Most rows a query returns |
| `dbExplainer.query.timeoutSeconds` | 15 | Queries running longer are cancelled |
| `dbExplainer.ai.fallback` | off | Try the next valid profile on 401, 429 or 503 |
| `dbExplainer.ai.sampleRows` | 5 | Rows sent when you let the AI see a result |
| `dbExplainer.context.maxTables` | 12 | Tables described in full for each question |
| `dbExplainer.notes.path` | `.dbexplainer/notes.md` | Notes file in the workspace |

## Limits to know about

- Very large schemas: every table name is always listed, but only the most relevant tables are described in full for each question. Mention a table by name to pull it in.
- Shared SQL is read by a parser. Statements it cannot read are reported, and the AI still sees the original text.
- The AI can be wrong. Check important queries before trusting the result.

## Develop

```
npm ci
npm run try                 # builds and opens a separate VS Code window running this copy
npm run build
npm test                    # unit tests, includes a real SQLite database
node test/integration/docker.js up
npm run test:integration    # MySQL, PostgreSQL, SQL Server and SQLite
node test/integration/docker.js down
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Contact

Questions or ideas? Reach out any of these ways:

- **Open an issue**: [github.com/anandsundaramoorthysa/db-explainer/issues](https://github.com/anandsundaramoorthysa/db-explainer/issues)
- **Start a discussion**: [github.com/anandsundaramoorthysa/db-explainer/discussions](https://github.com/anandsundaramoorthysa/db-explainer/discussions)
- **Email**: [sanand03072005@gmail.com](mailto:sanand03072005@gmail.com?subject=About%20DB%20Explainer)

Please report security problems privately, as described in [SECURITY.md](SECURITY.md).

---

## Credits

Created by [Anand Sundaramoorthy SA](https://github.com/anandsundaramoorthysa) and [Aflin Rinosha](https://github.com/aflinrinosha2004).

---

## License

Released under the **MIT License**. See [LICENSE](LICENSE).

## Acknowledgments

Built with these open-source projects: [mysql2](https://github.com/sidorares/node-mysql2), [node-postgres](https://github.com/brianc/node-postgres), [node-mssql](https://github.com/tediousjs/node-mssql), [sql.js](https://github.com/sql-js/sql.js), [node-sql-parser](https://github.com/taozhi8833998/node-sql-parser) and [markdown-it](https://github.com/markdown-it/markdown-it).

This project is independent and is not affiliated with or endorsed by the owners of any database product named here. All product names belong to their owners.

---

<p align="center">
  <a href="https://github.com/anandsundaramoorthysa/db-explainer">GitHub</a> ·
  <a href="https://github.com/anandsundaramoorthysa/db-explainer/issues">Issues</a> ·
  <a href="https://github.com/anandsundaramoorthysa/db-explainer/discussions">Discussions</a>
</p>
