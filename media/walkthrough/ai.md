# Bring your own AI

DB Explainer has no AI of its own. It talks to any service that speaks the OpenAI chat format, including a local model.

1. Set `dbExplainer.ai.baseUrl`. The default is `http://localhost:11434/v1`, which is Ollama.
2. Set `dbExplainer.ai.model`, for example `qwen2.5-coder:7b` or `gpt-4o-mini`.
3. If your service needs a key, run **DB Explainer: AI: Set API Key**. It is stored in VS Code secret storage.
4. Run **DB Explainer: AI: Test Connection** to check.

The first time you use a service that is not on your own computer, you are asked to allow it. What is sent: table and column names, your notes and your questions. Row values are never sent unless you choose to.
