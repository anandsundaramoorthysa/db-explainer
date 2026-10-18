# Security policy

## Supported versions

Only the latest release receives security fixes.

## Reporting a vulnerability

Please do **not** open a public issue for a security problem. Use GitHub's private reporting instead:
[Report a vulnerability](https://github.com/anandsundaramoorthysa/db-explainer/security/advisories/new),
or email [sanand03072005@gmail.com](mailto:sanand03072005@gmail.com?subject=DB%20Explainer%20security).

Include what you found, how to reproduce it, and which version you tested. You can expect a first reply within a few days.

## What this extension does with your database

- **Read-only by design.** Only a single SELECT (or EXPLAIN of a SELECT) can be run. Every statement is checked before it goes anywhere, then run inside a read-only transaction that is never committed, with a row limit and a time limit. SQLite files are opened as an in-memory copy, so the file on disk is never changed. Use a read-only database account as well: it is the stronger protection.
- **You press Run.** The AI can suggest queries but never runs one. Nothing runs without a click.
- **Rows stay private.** Query results are shown to you only. They are sent to the AI service only when you press "Let the AI see these rows", and then only a few rows with sensitive-looking columns hidden.
- **What the AI normally sees.** Table, column, key and index names, row counts and simple statistics (counts of empty and distinct values, and ranges for numbers and dates), your team notes, and your questions. Text values are never read for statistics.
- **Secrets.** Database passwords and the AI key are kept in VS Code secret storage. The AI key is sent only over HTTPS, or to a local server.
- **No telemetry.** The extension collects no usage data.
- **The chat page** runs with a strict content security policy. AI replies cannot load images or run scripts.

See [PRIVACY.md](PRIVACY.md) for the full data description.
