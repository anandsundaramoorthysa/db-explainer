# Contributing

Thank you for helping. Bug reports, ideas and pull requests are all welcome. Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Set up

```
npm ci
npm run build
npm test
```

Press F5 in VS Code to start an Extension Development Host.

## Project layout

| Path | What is there |
|---|---|
| `src/model` | The shared database model, table search and context building |
| `src/importer` | Turns SQL text into the model |
| `src/db` | One driver per engine, the SELECT-only guard, statistics |
| `src/ai` | The AI client, prompts, masking of sample rows |
| `src/chat` | The conversation: ask, run, explain rows |
| `src/panel.ts`, `media/chat.*` | The chat panel |
| `src/extension.ts` | Commands, settings, wiring |
| `test` | Unit tests and the Docker integration tests |

## Tests

- `npm test` runs the unit tests. They use a real SQLite database and a fake AI.
- `node test/integration/docker.js up`, then `npm run test:integration`, then `... down`, runs the same checks against MySQL, PostgreSQL, SQL Server and SQLite in Docker. Run this when you change a driver.

## Rules that must not be broken

1. Nothing may write to a user's database. Changes to the guard in `src/db/sqlGuard.ts` need tests for the new case.
2. Row values must not reach the AI unless the developer presses **Let the AI see these rows**. Statistics never read text values.
3. Passwords and keys stay in secret storage and never appear in logs or messages.

## Pull requests

Keep a pull request to one change, update the docs and [CHANGELOG.md](CHANGELOG.md), and make sure `npm run typecheck` and `npm test` pass.

## Contact

- **Open an issue**: [github.com/anandsundaramoorthysa/db-explainer/issues](https://github.com/anandsundaramoorthysa/db-explainer/issues)
- **Start a discussion**: [github.com/anandsundaramoorthysa/db-explainer/discussions](https://github.com/anandsundaramoorthysa/db-explainer/discussions)
- **Email**: [sanand03072005@gmail.com](mailto:sanand03072005@gmail.com?subject=About%20DB%20Explainer)
