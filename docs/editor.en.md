# v0.3 editor, AI and upgrades

## Local semantic completion

Windows packages bundle Pyright 1.1.414 and clangd 23.1.0. They need no startup download. Python and C/C++ support member completion, signature help, hover information, F12 navigation to definitions within the workspace, and live diagnostics. Analysis uses unsaved open-file edits; you still control saving.

Python uses the effective project interpreter and virtual environment for third-party imports. C/C++ analysis uses project sources, header directories, language standards and detected compilers. A subsequent edit or query restarts services after configuration changes. Install compilers separately; language services do not replace building and running code.

Ordinary completion does not call AI. Missing services retain keyword/snippet completion and show their status above the terminal. Large projects, complex macros and unconfigured external libraries may need further configuration. F12 currently opens workspace files only, not external standard-library/environment files. Diagnostics do not prove the program's logic is correct.

Click a problem to navigate to it, or choose Ask mentor. With a task, this explains the current step; otherwise it opens an AI chat.

## Streaming AI replies

Chat supports text streams from Chat Completions, Responses and Anthropic Messages. Replies appear progressively and support Stop and Retry. Stopping cancels the local provider request; a provider may still charge for generated output.

Disable streaming in settings when needed. Successful ordinary JSON replies are displayed directly. Only an explicit rejection of the stream parameter causes an automatic non-stream retry. Disconnects, provider errors and partial replies do not trigger automatic duplicate requests. Incomplete assistant replies are excluded from subsequent conversation context.

## Mentor hint depth

Manual reviews and questions offer Light hint, Detailed approach and Example for this step. Examples appear as code blocks without editing files automatically. Automatic checks always use light hints. Pause, intervals, hourly limits and explicit step advancement remain available.

## Chinese and English

Choose 中文 or English in the top bar. The choice applies immediately and persists locally. New AI requests ask for the selected language. Existing generated plans, chats and user code retain their original content.

## Upgrade and backup

Save open files, stop the old version, then extract and start the new version in a separate folder.

- **From v0.1/v0.2:** Settings → Upgrade & backup → enter the old workbench folder, such as `G:\CodeStudio`, and migrate. Only old settings and mentor progress are read; original files and code stay untouched.
- **Later upgrades:** Export an encrypted backup and import it in the new version. It contains API URLs, models, encrypted keys, interface language, tool paths and mentor progress. The workspace path must still exist.
- **Local restoration:** The page lists the latest 20 backups. Reading old settings for the first time and each restore create a backup under `data/backups`. A failed restore attempts to roll back.

Backups use the current Windows account's protection. Restore on the same computer and account; re-enter keys on a different computer. Code, virtual environments, browser drafts, run logs and dependencies are excluded and need separate preservation. Never commit backups to GitHub.

Source developers run `npm ci` and `npm run prepare:languages` before building. Downloaded components are checked against pinned SHA256 digests. Building/packaging can use the network; the installed editor and ordinary language features work offline.
