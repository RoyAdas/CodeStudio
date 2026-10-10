# Changelog / 更新记录

## v0.1.0 — 2026-10-10

First public release / 首个公开版本。

- Windows x64 local browser workbench with a bundled Node runtime and start/stop launchers.
- Monaco editing, project file management, browser drafts, and Python/C/C++ basic completion.
- Single-file Python, C11, C++17, and JavaScript execution with standard input, cancellation, and time limits.
- Configurable Chat Completions, Responses, and Anthropic Messages endpoints; local Windows-account encryption for API keys.
- Task-based AI mentoring with step plans, hints, idle/run reviews, explicit step advancement, and persistent workspace progress.
- Automatic-review pause, interval and hourly limits, request/token usage reporting, and sensitive-filename exclusions for mentor context.
- Chinese and English documentation, example programs, repeatable build and test entry points, and a Windows release package.

### Known limits / 已知限制

- Windows x64 and Chinese UI only. Language runtimes and project dependencies must be installed separately.
- Basic completion, single-file compilation, and local execution without an isolated sandbox; no VS Code extension marketplace, language server, breakpoint debugger, or multi-file build integration.
- AI adapters are covered by local mocks. Real providers and models are not universally verified, and model reviews do not guarantee program correctness.
- Automatic-review limits do not cap manual requests. Provider-reported token counts may be unavailable and do not represent a bill.

Potential v0.2 work: Python virtual environments, semantic completion, multi-file builds, streaming AI responses, and Chinese/English interface switching.

v0.2 候选方向：Python 虚拟环境、语义补全、多文件构建、AI 流式回复与界面中英切换。
