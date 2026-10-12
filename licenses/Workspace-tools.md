# Workspace tools bundled in v0.5.0

The Windows package preserves upstream licenses with the components listed below.

- Microsoft node-pty 1.1.0 (MIT), including its Windows ConPTY runtime: https://github.com/microsoft/node-pty — node_modules/node-pty/LICENSE.
- xterm.js 6.0.0 and addon-fit 0.11.0 (MIT): https://github.com/xtermjs/xterm.js — license copies in this licenses folder; browser code is included in dist.
- Prettier 3.9.10 (MIT): https://github.com/prettier/prettier — node_modules/prettier/LICENSE and upstream notices.

Pure Python wheels are pinned by version, official download URL and SHA256 in python-runtime.json. The package extracts the complete wheels under python-runtime/lib, including dist-info license documents and metadata for Black, pytest, coverage and their dependencies. Exact license texts are retained in each distribution; dependencies may have different terms (MIT, BSD and Apache).

The package does not include Python itself, Git, or C/C++ compilers. Installing these tools remains the user's choice. CodeStudio's source is MIT; bundled dependencies retain their upstream terms.
