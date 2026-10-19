# Changelog

## 1.0.3

- Dex now checks its own SQL before you see it. It finds mistakes that the schema reveals (NOT IN over a column that allows NULL, a WHERE that undoes a LEFT JOIN, grouping by a name, a count inflated by a join, a table or column that does not exist, a join on the wrong columns, an inner join that drops rows with a NULL key) and warns you, and it asks the AI once to fix them. A query you paste for review is checked the same way.
- On SQLite, MySQL, MariaDB and PostgreSQL connections, each suggested query is planned with EXPLAIN (it is not run and no rows are read), and if the database refuses it the assistant is asked to correct it. See PRIVACY.md.
- The assistant no longer guesses the capitalisation of a value in a filter, and gives short, question-specific reminders to models that ignore long instructions.
- Queries in a code block that starts with a comment, holds two statements, or uses <sql> tags are now found and get a Run button. A query no longer appears twice in the chat.

## 1.0.2

- More accurate SQL from Dex: it no longer guesses the capitalisation of a value in a filter, warns that NOT IN returns nothing when the subquery can contain NULL, gives one complete corrected query when it finds a problem, rounds money, and says which statuses a revenue figure includes.
- Statistics now give exact NULL counts, so a single NULL in a large table is no longer rounded away.

## 1.0.1

- The chat assistant now has a name, Dex, a round avatar beside each reply, and a short welcome message when the chat opens.

## 1.0.0

First release.

- Chat with a database in plain English: what a table is for, how tables connect, what a column holds.
- Share a live database (MySQL and MariaDB, PostgreSQL, SQL Server, SQLite) through a read-only connection, or share SQL by file, selection or clipboard. No export step.
- Writes SQL for a goal and explains a pasted query step by step, checked against the real schema.
- Runs queries on request: SELECT only, you press Run, read-only transaction, 100-row limit, 15-second limit.
- Row values stay private. A few masked rows go to the AI only when you press "Let the AI see these rows".
- Table statistics (row counts, empty and distinct counts, ranges for numbers and dates) improve answers without reading text values.
- Team notes in `.dbexplainer/notes.md` that every answer uses.
- Bring your own AI: any OpenAI-compatible service, including local models such as Ollama.
