# Live task mentor

[中文](mentor.zh-CN.md) · [English](mentor.en.md) · [Back to README](../README.en.md)

## Start with your own task

1. Open a workspace and relevant code files, and configure your AI service in settings.
2. Enter your goal in “我想完成的任务” (My task) on the right and choose your experience level. For example: build a Python expense tracker; I know functions and want hints before code review.
3. Select “提交任务，开始指导” (Submit task and start). The mentor creates a route and gives you the first goal, hint, and verification method.
4. Write code yourself. Reviews trigger after about 5 seconds without typing and after execution. Model response time is additional; 5 seconds is only the idle delay.
5. Read the panel and code-line feedback, then press F5 when execution is needed to verify your work. Click file and line references to navigate.
6. After the current code passes review, select “进入下一步” (Next step). The mentor does not skip ahead automatically or overwrite your code.

The mentor makes no automatic calls before you start a task. AI judgments can be wrong: run the prescribed checks rather than treating a successful review as proof of correctness.

## Automatic reviews and usage

- “暂停 / 恢复” (Pause / Resume) controls automatic reviews. Pausing cancels a pending mentor request.
- “自动检查” (Automatic review) supports after typing and execution, after execution only, or manual only.
- Automatic requests are at least 20, 30, or 60 seconds apart. Rapid edits are combined into the latest snapshot.
- The default hourly limit is 30 automatic reviews, configurable to 10, 30, 60, or unlimited. It does not limit task creation, manual checks, or questions.
- “检查这一步” (Check this step) requests a manual review; the question field asks about the current step.
- A hidden page does not initiate automatic reviews. Editing, saving, and running code do not wait for the mentor.

Every actual request to your configured service may incur a charge. The interface counts requests and provider-reported tokens. Some services omit usage data; the numbers are not a cost estimate or provider billing statement. Try manual mode first when using expensive models and check your provider's billing rules.

Network, permission, quota, or response-format errors pause automatic reviews while preserving progress. Resolve the error before resuming. A cancelled request may already have been processed by the service; cancellation does not guarantee a refund.

## What is sent

The mentor uses the current and other open code files: up to 6 files and about 36,000 characters, including unsaved edits. Context may also include the task, selected text, and actual execution output. Long files are truncated, so open smaller relevant files when necessary.

The mentor applies these default filename and directory exclusions, case-insensitively:

- `.env` and `.env.*`.
- Files ending in `.pem`, `.key`, `.p12`, `.pfx`, or `.keystore`.
- Files named `credential`, `credentials`, `secret`, or `secrets`, optionally followed by an extension, such as `credentials.json`. Names such as `secret_config.py` that merely contain the word are not excluded.
- `id_rsa`, `id_ed25519`, and `id_ecdsa`, optionally followed by an extension.
- Files under a `.git`, `.ssh`, `.aws`, or `data` path segment.

**Filename filtering does not redact content.** Secrets and private details in ordinary source files, task text, selected code, or execution output may still be sent. Pause the mentor first or remove such content before continuing. Ordinary chat and AI completion remain explicitly requested with their own context controls; these exclusions apply only to the mentor, not to all AI features.

Starting a task with automatic reviews enabled sends context to your configured endpoint. The provider's policies determine how it stores and uses data. Running the workbench locally does not keep all data local when you use remote AI.

## Code versions and execution evidence

Code changes invalidate older reviews. Output from an old program version is not treated as evidence that new code was verified. Edits during an active review cancel it, and the latest version can be reviewed later. Editing after a successful review requires another check before advancing.

Feedback distinguishes static code review from code plus execution results. The mentor does not execute arbitrary commands, install software, or automatically rewrite code. You control dependency installation and program behavior.

## Persistence

The route, current step, and recent feedback are stored locally in `data/mentor-sessions.json` and restored after refresh or restart. Each workspace has its own task; paused status persists. This file may contain private goals and code feedback, so do not commit it.

“新任务” (New task) asks before ending the current task. Confirming clears its progress without deleting code. Back up important code and learning records separately.


See the [editor and upgrade guide](editor.en.md) for v0.3 semantic completion, hint levels, streaming and backups.
