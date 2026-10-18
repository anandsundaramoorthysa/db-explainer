# DB Explainer

Understand any database by chatting with it. Share a live database (read-only) or a SQL file, then ask in plain English. No export, no setup scripts.

[![CI](https://github.com/anandsundaramoorthysa/db-explainer/actions/workflows/ci.yml/badge.svg)](https://github.com/anandsundaramoorthysa/db-explainer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## What it does

- **Meet Dex.** The chat assistant is called Dex.
- **Explains the database.** "What is the orders table for?" "How do payments connect to products?" "What does the status column mean?"
- **Writes SQL for your goal.** "Top five customers by total spend this year." The query uses your real table and column names and your database's dialect.
- **Explains a query you paste.** Step by step, checked against the schema.
- **Runs queries when you ask.** Press Run under any SQL. See the rows in the chat.
- **Remembers what your team knows.** Notes such as "status 3 means shipped" live in a file in your repo and improve every answer.

## Two ways to share a database

| | Live connection | Shared SQL |
|---|---|---|
| How | Add a connection in the sidebar | Right-click a `.sql` file, or select SQL and run **Share SQL With the Chat** |
| Databases | MySQL and MariaDB, PostgreSQL, SQL Server, SQLite | Scripts for any of those, including SQL Server scripts |
| Explain and write SQL | Yes | Yes |
| Row counts and statistics | Yes | No |
| Run queries | Yes | No, there is no data |

## Safe by design

- **Read-only.** Only one SELECT (or EXPLAIN of a SELECT) can run. It is checked first, then run in a read-only transaction that is never committed, with a 100-row limit and a 15-second limit. SQLite files are copied into memory, so the file is never touched. Use a read-only database account too.
- **You press Run.** The AI suggests, you decide.
- **Rows stay private.** The AI sees names, keys, counts and simple statistics, never row values. If you want it to explain a result, press **Let the AI see these rows**: a few rows are sent, with sensitive-looking columns hidden.
- **Passwords and keys** are kept in VS Code secret storage.
- **No telemetry.**

Details: [SECURITY.md](SECURITY.md) and [PRIVACY.md](PRIVACY.md).

## Get started

1. Open the **DB Explainer** icon in the activity bar.
2. **Add a database connection**, or share a SQL file.
3. Set up your AI (below), then open the chat and ask.

## Bring your own AI

DB Explainer has no AI of its own. It works with any service that speaks the OpenAI chat format, including local models.

| Setting | Meaning |
|---|---|
| `dbExplainer.ai.baseUrl` | Default `http://localhost:11434/v1` (Ollama). Also works with LM Studio, OpenAI, OpenRouter and others |
| `dbExplainer.ai.model` | For example `qwen2.5-coder:7b` or `gpt-4o-mini` |
| `dbExplainer.ai.maxTokensParam` | Switch to `max_completion_tokens` for models that require it |

Run **DB Explainer: AI: Set API Key** if your service needs a key, and **DB Explainer: AI: Test Connection** to check. The first time you use a host that is not on your computer, you are asked to allow it.

## Team notes

Run **DB Explainer: Add a Team Note**, or use the note box under an answer. Notes go in `.dbexplainer/notes.md`. Commit the file and your whole team gets the same answers.

## Commands

| Command | What it does |
|---|---|
| DB Explainer: Open Chat | Opens the chat panel |
| DB Explainer: Add Database Connection | Saves and connects a database |
| DB Explainer: Share SQL With the Chat | Shares the open file, the selection, or clipboard SQL |
| DB Explainer: Refresh Schema | Reads the structure again |
| DB Explainer: Add a Team Note / Open Team Notes | Works with the notes file |
| DB Explainer: AI: Set API Key / Clear API Key / Test Connection | Manage your AI service |

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `dbExplainer.query.maxRows` | 100 | Most rows a query returns |
| `dbExplainer.query.timeoutSeconds` | 15 | Queries running longer are cancelled |
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
