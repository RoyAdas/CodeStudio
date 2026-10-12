# v0.5 toolbox guide

Open Toolbox in the top bar or editor toolbar. Both Chinese and English are supported. Closing the browser does not stop the workbench service.

![Toolbox in English](images/toolbox.png)

Coverage warns and skips incomplete Python files it cannot parse. These files are absent from coverage totals; executed tests retain their actual results.

## Ten new capabilities

1. **Git management**: initialize the current folder, inspect status/diffs, stage or unstage individual paths, set repository author identity, commit, inspect the latest 20 commits, push and fast-forward-only pull. Requires Git for Windows and existing machine credentials. Configure origin in the terminal. AI explains or proposes messages from only the displayed diff, capped at 10,000 characters; you edit and commit explicitly.
2. **Search and code editing**: literal project search/replacement, path/case filters, Black for Python, clangd for C/C++ formatting, Prettier for supported other files, and Python/C/C++ semantic rename. Every edit opens a difference preview before draft acceptance and saving. Changed baselines are rejected. Language-service refactoring depends on valid project configuration.
3. **Local history**: save captures both previous and next content; duplicate snapshots merge and the latest 20 versions per file are retained under data/file-history. Restore begins with a comparison. Each text snapshot is limited to 2 MB. Deleted-file recovery and a total disk quota are not implemented.
4. **AI context picker**: choose up to 16 project files, including closed files, using open drafts when available. The preview lists separate chat and mentor scope/character counts. Chat: 120,000 total and 50,000 per file. Mentor: 36,000 total and 18,000 per file, active file first, truncated entries marked with an ellipsis. Current code, selection, task, tests or output may be included separately. Selection persists per workspace in the local browser.
5. **Multiple AI profiles**: store up to 16 endpoints, protocols, models and encrypted keys; route chat, completion and mentoring independently. Default routes use Settings. Activating a profile copies it into default settings, and deleting that profile does not erase the copied default. Compatible Chat Completions, Responses and Anthropic Messages endpoints are supported. Windows DPAPI keys are tied to the user and machine.
6. **Offline templates**: Python word counter, expense tracker, pytest exercise, C algorithms and C++ multi-file practice. Create a new child directory with skeleton code, tests and a mentor goal without overwriting existing folders. The goal fills the mentor input; you submit it. TODO skeletons may fail their initial tests.
7. **pytest and branch coverage**: choose unittest/pytest, collect coverage, inspect parameterized cases and rerun only failures. Editor executed/missing-line markings clear after edits. Bundled tools do not require pip installation into the project; project dependencies still do. Automatic third-party pytest plugin loading is disabled.
8. **Interactive terminals**: up to six independent PowerShell ConPTY sessions in the project directory. Closing Toolbox preserves shells; changing workspace or stopping the service closes them. Commands execute with your Windows user privileges.
9. **Learning reviews and mistakes**: per-workspace mentor progress, needs-fix feedback and approximate visible-page practice minutes. AI reviews remain drafts until Confirm and save. Records live in data/learning.json; the timing is not an assessment of proficiency.
10. **Updates and rollback**: manual GitHub checks only; official RoyAdas/CodeStudio Release downloads, SHA256/version/path verification, settings backups and separate versions directories. Save drafts and stop execution before switching. Register complete older installation folders for rollback. Remote download availability depends on the network; local editing and startup do not.

## Install and upgrade

Windows 10/11 x64; ConPTY requires Windows 10 1809+. Packages include Node, language services, debugpy, formatters and test tools. Install Python and C/C++ compilers separately. Formatting, pytest, coverage and debugging require Python 3.10+. Git features require Git for Windows.

Save and stop the old version. Fully extract v0.5.0 to a new writable folder and double-click Start.cmd. Settings → Upgrade & backup can migrate an old installation such as G:\CodeStudio or import an encrypted backup. Source files and virtual environments remain in the original workspace. Manual migration imports settings/mentor/learning records, but not the separate file-history folder; the new automatic updater copies file history. Key migration requires the same Windows user and machine. Register the old installation in Toolbox to enable rollback.

Encrypted settings backups include settings, mentor sessions and learning records. Local file history is separate, unencrypted and not included in those backups. Do not upload data folders. Project execution and terminal commands have local user privileges; this application is not an isolation sandbox.

## Source preparation

Initially install dependencies and verified runtime components online:

    npm ci
    npm run prepare:languages
    npm run prepare:debugger
    npm run prepare:python
    npm run typecheck
    npm run build
    npm test
    npm run test:e2e
    npm run package:win
    npm run test:package

Preparation and packaging currently target Windows. AI regression tests use local mock providers and do not establish compatibility with every real model or relay.
