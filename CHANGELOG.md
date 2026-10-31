# Changelog

## 1.1.0

New

- **AI profiles.** Save several AI services as profiles (Gemini, Groq, OpenRouter, OpenAI, Claude, Ollama, or any OpenAI-compatible address), each with its own base URL, model, key and optional expiry date. Existing dbExplainer.ai.* settings keep working until you save your first profile, after which the profile replaces them.
- **Manage AI Keys page.** Lists profiles with label, provider, an editable model dropdown, expiry date and status (active, expiring soon, expired), with add, edit, delete, Test connection and Use this profile. The Add form asks for the provider, key and model first; label, address and expiry are under Advanced, and each provider has a "Get a key" link.
- **Keys only in secret storage**, never in settings. The page shows only the last four characters, and a key typed in the form is cleared from the page once it is saved.
- **Expiry.** A warning 3 days before a key expires (once a day, in one message), and an expired key is never used.
- **Status bar** shows the provider and model in use. Click it to switch profile in one step, add a profile or change a key. It turns amber when no AI is set up.
- **Change a key in one step.** A "Change key" button on every profile, an item in the status bar menu, the command "Change API Key", and a "Change key" button on the "key rejected" message. You type the key (and a new expiry date if there is one) and it is checked immediately.
- **A key pasted into the chat is never sent** to the AI, kept in the conversation or saved in the team notes. You are offered to save it as a profile. Besides the keys of the six providers, it recognises JSON web tokens, bearer tokens and api_key=... assignments, and it leaves table names such as dbo.CustomerOrderItems2024 alone.
- **Clear errors for 401, 429 and 503**, naming the profile and saying what to do next, with optional fallback to the next valid profile (setting dbExplainer.ai.fallback, off by default). Your table and column names go to the next service only if you turn this on and allow that host.
- **First-run help.** When no AI is set up, the chat shows an "Add an AI key" button that opens the Add form, and the sidebar has a "Set up AI" link.
- Command names are now "Change API Key", "Remove API Key" (asks first) and "Test AI Connection".

Fixed

- Closing and reopening the chat tab could leave the database list no longer updating.
- A reply that stalled after it began could hang a question or Test connection for ever. It now times out.
- The Manage AI Keys page lost a half-filled form when you switched tabs, and kept showing a key as valid after its expiry date passed while VS Code stayed open.
- A form error on Save (a bad address or date) cleared the key you had pasted.
- Changing a key while the dialogs were open could overwrite edits made meanwhile, or bring back a deleted profile.
- Fallback: a profile with a bad address or no model is now skipped instead of stopping the chain, you are no longer asked to trust a host whose address is invalid, and the final message names the failure that matters.
- A Retry-After given as a date no longer reads "try again in Wed, 21 Oct... seconds", and a base URL with a query string works.
- A key with characters that cannot be sent in a request is refused with a clear message.
- Keyboard focus is kept after a button on the Manage page is used, and its buttons have labels that name the profile.

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
