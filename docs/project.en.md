# Project environments and builds

[中文](project.zh-CN.md) · [English](project.en.md) · [Back to README](../README.en.md)

v0.2.0 adds **项目设置 / Project Settings** below the file tree and **项目 / Project** in the top menu. Settings belong to the current workspace and are saved in its root as `.codestudio.json`. Switching folders loads that workspace's configuration.

## Python virtual environments

Install Python first and confirm a working system interpreter in Settings → Runtime. In Project Settings → Python Environment, choose:

- **Auto**: prefer the project's `.venv`; use system Python when the directory does not exist. An existing broken environment produces an error rather than silently falling back.
- **Project environment only**: a missing or invalid environment must be created or repaired before running.
- **System Python**: ignore the project environment and use the interpreter configured or detected in global Runtime settings.

Click **Save settings and create virtual environment** to create the folder with local Python. Python's bundled resources bootstrap pip; no third-party packages are downloaded. No activation script is needed: F5 invokes the environment's interpreter directly. Creation has a 180-second limit; wait for it to finish before switching workspaces or running programs.

The environment must be a direct child of the workspace root, such as `.venv`, `venv`, or `.venv-study`. Existing directories are never overwritten. Failed partial environments are left for inspection. An existing environment needs `pyvenv.cfg` and `Scripts/python.exe`. Recreate environments after moving projects or computers.

Install project dependencies yourself in a terminal, for example:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

The workbench does not run this command automatically. Do not commit environment folders to GitHub; add custom environment names to the project's `.gitignore`.

## C / C++ multi-file builds

Configure GCC/G++ or Clang/Clang++ first. In Project Settings → C / C++ Build, select the source files that should compile together and save.

- C lists accept `.c`. C++ lists accept `.cpp`, `.cc`, `.cxx`, and `.c`.
- F5 saves every modified open file, then builds the matching language's list. When the list is nonempty, the active source file must be selected.
- An empty list keeps single-file execution. Unselected files and other example entry points are not compiled automatically.
- Extra header directories are workspace-relative paths, one per line. Quoted includes beside each source continue to work.
- Defaults are C11 and C++17. Other selectable standards require support from your compiler.
- Mixed projects compile `.c` with the C compiler and link with the C++ compiler. Shared interface headers need the usual `extern "C"` declarations.

Temporary source and object files preserve original diagnostic filenames and lines. Owned temporary files are cleaned after completion, errors, and cancellation. Multi-file programs run from the workspace root; single-file programs run from the source directory. Arrange relative data-file paths accordingly. Each source compilation and link step has a 30-second limit.

Open `examples/c-project` or `examples/cpp-project` **itself** as the workspace and press F5 in its entry file to try the bundled examples.

## Configuration example

```json
{
  "version": 1,
  "python": { "mode": "auto", "venv": ".venv" },
  "build": {
    "c": ["main.c", "src/total.c"],
    "cpp": [],
    "includeDirs": ["include"],
    "cStandard": "c11",
    "cppStandard": "c++17"
  }
}
```

`version: 1` describes the configuration format, not the software version. Paths must stay within the workspace. API keys are not stored here. Malformed JSON is reported and blocks execution without automatically replacing the file. Save manually edited configuration before viewing its effective settings.

CMake, external-library link options, incremental builds, breakpoint debugging, and language servers are not included. Basic completion remains keywords, snippets, and current-file identifiers. Configurable AI endpoints and task mentoring keep their existing behavior.
