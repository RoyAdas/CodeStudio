# Usage guide

[中文](usage.zh-CN.md) · [English](usage.en.md) · [Back to README](../README.en.md)

## Start and stop

Download the Windows x64 Release ZIP, fully extract it into a writable folder, and double-click `Start.cmd` or `启动工作台.cmd`. Keep the `runtime/`, `dist/`, server files, and launcher together. Your browser opens a local `127.0.0.1` address; the interface is not hosted on an external website.

If port 8765 is occupied, the launcher chooses an available port between 8766 and 8784. Starting again reuses the service for the same installation directory. Closing the browser does not stop it. Use `Stop.cmd` or `停止工作台.cmd` to stop the server and any program it is running.

## Language runtimes

The package includes Node. Install Python for Python programs and GCC/G++ or Clang/Clang++ for C/C++. Add tools to PATH, or enter full executable paths in “设置 → 运行环境” (Settings → Runtime) and save to repeat detection. Install project dependencies such as PyTorch in the Python environment you choose.

One-click launch starts the workbench; it does not install every language or project dependency. v0.2.0 supports Windows x64 only.

## Files and shortcuts

Use “打开文件夹” (Open Folder) at the bottom left to enter your project path. Saving writes directly into that folder. The top buttons create files and directories. The included `examples/` contains Python, C/C++, and standard-input examples.

| Action | Shortcut |
| --- | --- |
| Save current file | Ctrl + S |
| Save and run | F5 |
| Ordinary completion | Ctrl + Space |
| AI completion | Ctrl + Alt + Space |
| Quick open | Ctrl + P |
| Find in file | Ctrl + F |
| Undo edits or AI insertion | Ctrl + Z |

Ordinary completion provides Python/C/C++ keywords, snippets, and current-file identifiers without an API. Select with arrow keys, confirm with Enter or Tab, and use Tab to move through snippet placeholders. Full language-server type and member analysis is not included.

Unsaved changes are stored as local drafts in the current browser and can be restored after refresh. Ctrl+S writes to disk, and running also saves the current file. Drafts are not backups; clearing browser data may delete them.

## Run programs

Supported extensions are `.py`, `.c`, `.cpp`, `.cc`, `.cxx`, `.js`, and `.mjs`. C/C++ defaults to single-file C11/C++17 compilation. Select multiple sources or a Python virtual environment in **项目设置 / Project Settings**. F5 saves every modified open file before execution. See [project environments and builds](project.en.md).

The terminal shows actual output, errors, and exit codes. For standard input, type into the terminal input field and press Enter; EOF signals end of input. Quote run arguments containing spaces. “停止” (Stop) terminates the current program. The default execution limit is 120 seconds, adjustable to 10–600 seconds in settings; compilation is limited to 30 seconds.

Programs run with your current Windows account's permissions, without a sandbox. Do not run untrusted code or forward the service to the public internet.

## Configure AI

Open the top-right settings button and select “AI 服务” (AI Service):

1. Provider: custom compatible endpoint, DeepSeek, Ollama, or an Anthropic-compatible endpoint.
2. Protocol: Chat Completions, Responses, or Anthropic Messages, as required by your provider.
3. URL: a base URL or full endpoint. Include `/v1` when required by the provider.
4. Model: the exact model name you are allowed to use.
5. Key: enter it only in settings. Enable the no-key option for local endpoints that do not require authentication.

“测试连接” (Test connection) makes a short request that may incur a charge. Adapters are tested against local mocks; real providers may still have differing parameters, response formats, or access restrictions.

Keys are encrypted using DPAPI under your current Windows account and saved in `data/`. Changing the endpoint clears the previous key. After changing computers or accounts, enter the key again. Do not upload configuration files or paste keys into Issues.

AI completion previews suggestions before insertion; Ctrl+Z undoes them. The ordinary chat context button controls whether relevant file content accompanies chat messages. **The task mentor uses its own open-file snapshots and can send them automatically after a task starts; the chat context switch does not control the mentor.** See the [mentor guide](mentor.en.md) for transmission scope and pause controls.

## Troubleshooting and updating

- Missing interpreter or compiler: install the required tool, enter its path in Runtime settings, and save.
- Browser did not open: use the address shown by the launcher, or check `data/server-error.log`. Logs may include local paths; remove private content before sharing.
- API errors: check URL, protocol, model permissions, key, and quota. A mentor error pauses automatic reviews; resolve the error and resume manually.
- Updating the installation: stop the server first and back up the selected workspace and local configuration you wish to retain. Encrypted keys only work on the original computer and Windows account.

`data/` contains settings, mentor progress, and logs. Code lives in your selected workspace, which may be outside the installation directory. Confirm that path before backing up your code, and stop the server before moving the installation folder.
