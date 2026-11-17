# Changelog

## 1.2.1

Security

- **Pasted connection strings now ask about encryption.** A connection string for a server that is not on your computer, with no ssl or sslmode in it, used to connect without encryption and without asking, so the password crossed the network in plain text. It now asks the same question as the step-by-step Add flow. A string that says ssl one way or the other is respected.
- **A project cannot redirect your AI settings.** `dbExplainer.ai.baseUrl`, `dbExplainer.ai.model` and `dbExplainer.ai.fallback` can now only be set in your own user settings, so a cloned repository's `.vscode/settings.json` can no longer point an old saved key at another service. The "allow this service" message now says the saved API key goes to it too.
- **Check speed no longer sends a key.** A query with an API key in it is stopped the same way a key typed in the chat is, in every place SQL is sent to the AI.
- **Security updates to the build tools.** esbuild 0.24 to 0.25 and fast-uri 3.1.8 to 3.1.9, which fix known advisories. They are used only to build the extension and are not shipped in it as separate files.

Fixed

- **Fewer paid retries.** Only a reply that really says the model is missing or retired (a 404, or the service's own words such as "does not exist" or "decommissioned") starts the replace-the-model search. Errors about token limits, context length or unsupported settings no longer do, so they cannot trigger extra requests or change the saved model.
- **Your saved model is not replaced when you press Test or Save.** If it is not in the service's list (aliases such as `llama3.2` for `llama3.2:latest` often are not), you are told and offered a suggestion, and nothing is changed. A retired model is still replaced when a question actually fails because the model is gone, and the replacement is now the closest model of the same family and size, not the largest.
- **Edits made while a confirmation was open are kept.** Moving a profile to another host no longer overwrites a key rotation, an added key or a model change made in the meantime, and a profile deleted in the meantime is not brought back.
- **A stalled stream now times out.** A server that only sends keep-alive pings no longer holds the answer open past the 60 second limit, and the connection is released when an answer ends or fails.
- **A cut-off answer is no longer shown as finished.** If a stream stops without its end marker, you get an error instead of half an answer.
- **Cancelling in Copilot Chat stops the request.** `@dex` now cancels the AI call, retries nothing and spends no more quota.

## 1.2.0

New

- **Several API keys on one profile.** Paste one or several keys into the box on a profile, or in the Add form, each with an optional expiry date and its own Test button. When a key has expired, is refused (401 or 403) or hits a rate limit (429), the next valid key of the same profile is used automatically, the chat says so, and that key is tried first from then on. A profile counts as expired only when all its keys have. Keys go only to the profile's own address, and profiles from 1.1.0 keep working unchanged.
- **Several model versions on one profile.** Save versions under "Saved models" and press one to use it, or pick it from the status bar menu.
- **Replies appear as they are written.** The checked answer replaces the draft when it is ready, and Run buttons only appear on the checked answer.
- **SQL Server queries are checked too.** A suggested query is compiled with sp_describe_first_result_set without being run, so the assistant can fix one the database refuses.
- **A retired model is replaced for you.** Saving a key picks the best model the service offers today if the suggested one is gone. If a model disappears later, the question is tried with your other saved models and then the service's own models, best first, and the first that answers becomes the model in use. You only see an error if none answers.

- **Underlines problems in .sql files as you type, with no AI**: `= NULL`, a misspelled command such as `SELEC`, an unknown column, a comma join with nothing linking the tables, and a function on a filtered column. The `= NULL` and comma-join checks also make Dex correct its own SQL.
- **Explain and Check speed above every statement** in .sql files, and on the editor's right-click menu. Explaining a statement with nothing shared shares the file first, so its own tables are used.
- **Why is this slow?** The database is asked how it would run the query (EXPLAIN, nothing is run), and Dex explains the plan and suggests indexes. Also a "Why slow?" button under every query in the chat. Not yet on SQL Server.
- **Table diagram**: every table and its links, with keys marked. Click a table to ask about it, or copy the picture as Mermaid.
- **Data dictionary**: one command writes a Markdown page about every table, with the diagram and the team notes. It opens unsaved, so nothing is overwritten.
- **Try the sample database** with no setup, from the sidebar, the chat or the walkthrough.
- **GitHub Copilot with no key**: one click sets it up, and `@dex` answers in Copilot Chat. Needs VS Code 1.90 or later.

Fewer steps

- **Paste a connection string** to add a database in one go. Adding one by hand is also shorter: host and port share a box, the name is filled in, and encryption is only asked about for a server that is not on your computer.
- **The provider picks itself** from the key you paste, when the key's shape shows it.
- **Saving a profile checks the key straight away** and fills the model dropdown from the service's own list.
- Key expiry dates can be changed right on the key's row.

Fixed

- Editing a profile's address to a different host now asks first, instead of quietly sending the saved keys to the new address.
- A notes path pointing at a neighbouring folder with a similar name (C:\proj-other beside C:\proj) is now refused.
- A long reply no longer fails just because it took more than 60 seconds overall. The limit now counts from the last text received.
- Error messages no longer name an old command or send people using profiles to the settings.

Changed

- **Encrypted Postgres and MySQL connections now check the server's certificate.** Before, they were encrypted but did not check who was answering, so someone on the network could pretend to be the database and capture the password. If the check fails, one click either trusts your provider's certificate authority file or connects without the check, remembered for that connection. An existing encrypted connection to a server with a self-signed certificate asks once after this update. A connection string with `sslmode=no-verify` keeps working without the check.
- VS Code 1.90 or later is now needed, for Copilot and Copilot Chat.

For maintainers

- The release workflow publishes to the Marketplace when a VSCE_PAT secret is set, and `npm run try` opens a test window.

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
