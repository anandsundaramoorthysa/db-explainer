# Accuracy loop: what was done, how to repeat it, what is left

Goal: make Dex's SQL answers correct, tested end to end with a real model, fixing what the test finds, then testing again.

## How to run the live test

Needs a running model. Ollama is used by default (`http://localhost:11434/v1`).

```
npm run build
$env:LIVE_MODEL='qwen2.5:3b-instruct'   # PowerShell. Also installed: llama3.2:3b
$env:LIVE_RUNS='3'                       # repeats per question; small models vary a lot, use 3 or more
npx vitest run --config vitest.live.config.ts
```

For a hosted model set `LIVE_BASE_URL` and `LIVE_KEY`. A report per model is written to `.tmp/live-<model>.json` (not committed).
The five questions and the rules for judging them are in `test/live/dex.live.ts`. Each run uses the extension's own conversation code
with the real SQLite test database and runs the SQL Dex writes through the read-only guard.

Two scores are printed: **correct** (strict) and **correct or clearly flagged** (the answer is wrong but tells the developer what
is wrong, so nothing fails silently).

`test/fixtures/sql_explainer_test.db` is a rebuild from the description (source: `test/fixtures/db/accuracy.sql`), because the
original file was not in the repo. Replace it with the original if you have it and rerun the five counts (2, 9, 0, 3, 10).

## What the live test found, and the fix for each

| Found | Fix |
|---|---|
| Dex wrote `'Cancelled'` and got 0 rows. Cause: the rule text had a capitalised example that the model copied | Rule rewritten with no example, as an instruction: `LOWER(col) = 'lowercase text'` (`CASE_RULE`) |
| Small models lose a long system prompt | Short question-specific reminders after the question (`remindersFor`) |
| "Keep answers short" produced bare SQL for comparisons | Prompt says never answer a comparison, review or "why" with only SQL |
| NOT IN over a nullable column, WHERE undoing a LEFT JOIN, GROUP BY a name, COUNT inflated by a child join, invented tables and columns, undefined aliases, a join on columns the foreign key does not link, an inner join dropping rows with a NULL key | `src/ai/lint.ts`: found from the schema (and NULL counts), shown to the developer, and also run on a query the developer pastes |
| The model ignores its own rules | `src/ai/review.ts` and `Conversation.ask`: the answer is checked, and the model is asked once to fix the problems. Only the final answer enters the history |
| SQL in a block that starts with a comment, holds two statements, or sits in `<sql>` tags was not found (no Run button, no checks) | `extractSql` splits blocks into statements, skips leading comments, accepts `<sql>` |
| Query review failed when a sentence came before the query | `pastedSql` finds the query anywhere in the question |
| Models write SQL the database rejects (syntax, nested aggregates) | The database is asked to plan each query with `EXPLAIN` (SQLite, MySQL/MariaDB, PostgreSQL). Its error goes back to the model once. See PRIVACY.md |
| Every query showed twice in the chat | `stripSqlBlocks` removes runnable SQL from the text |
| Statistics rounded one NULL in a large table to 0% | Exact NULL counts |
| The table parser read `JOIN` as an alias and skipped the next table | Alias pattern refuses SQL keywords |
| Some of my judges were too lenient or had bugs | S5 checks the numbers; S1 and S5 judges fixed |

## Latest live results (3 runs per question, 3B models, the hardest case)

| | qwen2.5:3b | llama3.2:3b |
|---|---|---|
| Start (1.0.2 prompt only) | 2/5 correct | not measured |
| Loop 11, correct | 12/15 | 8/15 |
| Loop 11, correct or clearly flagged | 13/15 | 10/15 |

Best qwen results across loops: 13/15. Results move by 1 to 3 questions between identical runs, so judge a change over 3 or more runs.

## What is still open

1. **Small models still make reasoning mistakes**: a wrong filter, a repaired query that is malformed, revenue built on the wrong columns, one of the two requested queries missing. The lint and the plan check catch many of these, but not all.
2. **Test a stronger model** (a hosted one, or a larger Ollama model) before building more. Most of the remaining failures are model quality.
3. **SQL Server** is not plan-checked (it has no plain `EXPLAIN`). `SET SHOWPLAN_XML` or `SET PARSEONLY` could be used.
4. **Not done on purpose**: checking text literals against the real stored values. The privacy-safe version would read distinct values locally and only correct or warn, never send them to the AI. Worth doing only if casing mistakes appear with a stronger model.
