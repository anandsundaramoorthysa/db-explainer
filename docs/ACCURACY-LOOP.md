# Accuracy loop: status and how to continue

Goal: make Dex's SQL answers correct, tested end to end with a real model, fixing what the test finds, then testing again.

## How to run the live test

Needs a running model. Ollama is used by default (`http://localhost:11434/v1`).

```
npm run build
set LIVE_MODEL=qwen2.5:3b-instruct      (PowerShell: $env:LIVE_MODEL='qwen2.5:3b-instruct')
set LIVE_RUNS=2                          (repeats per question)
npx vitest run --config vitest.live.config.ts
```

Other models: `llama3.2:3b` is installed too. For a hosted model set `LIVE_BASE_URL` and `LIVE_KEY`.
A report per model is written to `.tmp/live-<model>.json` (not committed). The questions and the pass rules are in
`test/live/dex.live.ts`. Each run uses the extension's own conversation code, the real SQLite test database, and runs the
SQL Dex writes through the read-only guard.

The test database `test/fixtures/sql_explainer_test.db` is a rebuild from the description (source: `test/fixtures/db/accuracy.sql`).
Replace it with the original if you have it, and rerun the five counts (2, 9, 0, 3, 10).

## What was found and fixed (loops 1 to 5)

| Found by the live test | Fix |
|---|---|
| Dex wrote `'Cancelled'` and got 0 rows. Cause: my own rule text contained a capitalised example that the model copied | Rule rewritten with no example, as an instruction: write `LOWER(col) = 'lowercase text'` (per dialect, in `CASE_RULE`) |
| A long system prompt is ignored by small models | Short, question-specific `REMINDERS FOR THIS QUESTION` after the question (`remindersFor` in `src/ai/prompt.ts`) |
| "Keep answers short" made models answer a comparison with bare SQL | Prompt says never answer a comparison, review or "why" with only SQL |
| INNER JOIN silently dropped the order with a NULL customer | Pitfall rule and reminder: use LEFT JOIN when the key allows NULL |
| NOT IN over a nullable column was not warned about | `src/ai/lint.ts` warns from the schema, whatever the model says |
| A WHERE on the right table undoes a LEFT JOIN; GROUP BY a name merges people | Same lint, also run on a query the developer pastes ("Problems found in your query") |
| Statistics rounded one NULL in a large table to 0% | Exact NULL counts in `src/db/stats.ts` |
| Every query showed twice in the chat (text plus the Run block) | `stripSqlBlocks` removes runnable SQL from the text before it is shown |
| My own judges were too lenient (S5 passed with swapped counts) | S5 now checks the numbers against the true counts |

Lint warnings are added to what the developer reads, never to the history sent back to the AI. Nothing new is sent to the AI,
so PRIVACY.md is unchanged.

## Latest live result (loop 5, 2 runs per question, 3B models)

| Question | qwen2.5:3b | llama3.2:3b |
|---|---|---|
| S1 cancelled orders (value casing, keep the NULL-customer order) | 2/2 | 2/2 |
| S2 NOT IN vs NOT EXISTS (both forms, NULL explained, 9 rows) | 1/2 | 2/2 |
| S3 review a broken query (diagnosis plus ONE corrected query) | 0/2 | 0/2 |
| S4 total revenue (statuses said, ROUND) | 1/2 | 2/2 |
| S5 orders per customer (true counts) | 2/2 | 0/2 |

## What is still open

1. **S3 on both models.** The diagnosis now always reaches the developer (the lint finds both problems), but the 3B models still
   write a "corrected" query that keeps `WHERE o.status` or `GROUP BY c.name`. Ideas: lint the corrected query and ask the model once
   more with the warnings ("fix these problems") before showing it; or accept that the lint warning on the corrected query is enough.
2. **llama3.2 on S5**: counts rows inflated by the order_items join, or returns no SQL. Idea: a lint for `COUNT(x)` over a one-to-many join.
3. **Run-to-run variance** on qwen (S2, S4). Run with `LIVE_RUNS=3` or more before judging a change.
4. These are 3B models, the hardest case. Run the same test against a stronger model (hosted, or a larger Ollama model) before deciding
   how much more to build.
5. Not done: checking text literals against the real stored values (the privacy-safe local version would read distinct values locally and
   only correct or warn, never send them to the AI). Only worth doing if casing mistakes still appear with a stronger model.

## Before releasing

These changes are on branch `accuracy-loop`, not on `main`, and `package.json` is still 1.0.2. Bump to 1.0.3, add a CHANGELOG entry,
run `npm run build`, `npm test`, `npm run test:ui`, `npm run test:e2e`, and `npx vsce package --no-dependencies`.
