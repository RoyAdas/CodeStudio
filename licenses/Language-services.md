# Bundled language services

- Pyright 1.1.414, Microsoft Corporation, MIT: https://github.com/microsoft/pyright
  The Windows package includes the upstream license at `node_modules/pyright/LICENSE.txt` and the package's bundled third-party notices.
- clangd 23.1.0, LLVM contributors, Apache-2.0 WITH LLVM-exception: https://github.com/clangd/clangd
  The complete official Windows runtime folder is included under `language-runtime/clangd`, with its upstream licenses and Clang resource headers. The archive digest is pinned in `language-runtime.json`.

These components provide local language analysis; their inclusion does not change CodeStudio's MIT license.
