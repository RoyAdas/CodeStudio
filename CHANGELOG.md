# Changelog / 更新记录

## v0.2.0 — 2026-10-11

Project environments and builds / 项目环境与多文件构建。

- Per-workspace `.codestudio.json` settings and a project settings UI.
- Python auto/system/venv modes; create a new local virtual environment with bundled pip, without downloading dependencies or replacing existing directories.
- Explicit C/C++ source lists, mixed C/C++ builds, header directories, and selectable language standards.
- F5 saves all modified open files before execution. Empty build lists preserve single-file behavior.
- Unicode source paths, original diagnostic filenames/lines, exclusive temporary files, and cleanup on success, errors, and cancellation.
- Workspace-bound path validation, malformed-configuration errors, bilingual project guides, and two multi-file examples.
- Regression coverage for project configuration, actual environment isolation, mixed-language linking, browser operations, and portable launchers.

### Known limits / 已知限制

- Windows x64, Chinese UI; install Python and GCC/Clang separately.
- No language server, debugger, CMake, external-library link options, or incremental build. Basic completion and AI request behavior remain as in v0.1.0.
- Virtual environments are local and must be recreated after moving projects or computers. Third-party packages are installed manually.

## v0.1.0 — 2026-10-10

First public release / 首个公开版本。

- Windows x64 local browser workbench with a bundled Node runtime and start/stop launchers.
- Monaco editing, project file management, browser drafts, and Python/C/C++ basic completion.
- Single-file Python, C11, C++17, and JavaScript execution with standard input, cancellation, and time limits.
- C/C++ compilation uses temporary ASCII filenames to support Unicode installation paths and source filenames with Windows MinGW, preserving source files, diagnostics and local includes.
- Configurable Chat Completions, Responses, and Anthropic Messages endpoints; local Windows-account encryption for API keys.
- Task-based AI mentoring with step plans, hints, idle/run reviews, explicit step advancement, and persistent workspace progress.
- Automatic-review pause, interval and hourly limits, request/token usage reporting, and sensitive-filename exclusions for mentor context.
- Chinese and English documentation, example programs, repeatable build and test entry points, and a Windows release package.

### Known limits / 已知限制

- Windows x64 and Chinese UI only. Language runtimes and project dependencies must be installed separately.
- Basic completion, single-file compilation, and local execution without an isolated sandbox; no VS Code extension marketplace, language server, breakpoint debugger, or multi-file build integration.
- AI adapters are covered by local mocks. Real providers and models are not universally verified, and model reviews do not guarantee program correctness.
- Automatic-review limits do not cap manual requests. Provider-reported token counts may be unavailable and do not represent a bill.

Future candidates: semantic completion, streaming AI responses, and Chinese/English interface switching.

后续候选方向：语义补全、AI 流式回复与界面中英切换。
