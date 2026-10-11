# v0.4 debugging, tests and AI changes

## Python debugging

The Windows package includes pinned debugpy. It does not install project dependencies. Python 3.10 or a newer Python 3 is required; debugging uses the effective system interpreter or project environment.

Open a `.py` file. Click the gutter or press F9 to toggle a breakpoint. Select Debug in the activity bar and start Python debugging. Open edits are saved first. You can pause at entry; arguments use the existing terminal argument field.

Inspect the current line, workspace call stack and variables. Continue, step over, step into, step out, pause or stop. Ask mentor about this state explicitly sends the paused location and up to 50 variable values. A paused program is not completion evidence. Automatic mentoring waits during debugging and does not automatically send variables.

This version shows workspace frames and variables from the first two non-expensive scopes. Object expansion, expression evaluation, debugging stdin, conditional breakpoints, multiprocess debugging and C/C++ debugging are outside its scope. Use normal Run for interactive input. Existing C/C++ editing, completion, diagnostics and execution remain available.

Execution, debugging, testing and environment operations are mutually exclusive. Debugging uses the configured execution timeout. Stop and restart after changing code; a paused session belongs to its saved launch sources.

## Python tests and mentor review

The Tests panel uses standard-library unittest without installing another framework. The default directory is `.` and pattern is `test*.py`. Save and run tests to see real passed, failed, errored, skipped, expected-failure and unexpected-success cases and details. Follow your interpreter's unittest discovery rules for subdirectories; an `__init__.py` is normally needed.

Tests execute with the current Python environment and Windows account permissions. Stop and time limits are supported. Empty, interrupted or erroneous runs cannot pass. Skips and expected failures are shown separately and are not counted as verified passing cases.

Results fingerprint workspace Python, JSON, text and CSV files, excluding environments, dependency caches and common sensitive paths. Limits are 1,000 files and 2 MB per file. Unsaved open edits invalidate results immediately. Mentor review also verifies disk inputs against the recorded snapshot. Changes to external dependencies, environment variables or other data types are not fully covered; rerun after such changes.

Mentor auto-review can use completed tests with the existing interval limits, or you can request review manually. Failed, empty, interrupted or stale tests prevent a passed review even if the model claims success. Passing tests does not automatically finish a task: the current acceptance criteria still matter and you choose advancement.

## Reviewing AI changes

Choose Review AI changes from the editor toolbar, or Generate AI test suggestions in Tests. Your configured provider receives the first six open files, including unsaved code, and selected test results. Close unrelated files first.

The proposal contains complete content for up to eight files. Compare original and proposed content side by side, select files to accept, or reject the proposal. Test generation is limited to `test*.py` files. New files require an existing parent directory; proposals cannot delete, rename, access sensitive paths or edit existing files omitted from the input.

Acceptance checks whether the draft changed and rejects stale proposals. Accepted content is an unsaved edit; Ctrl+S or saving before execution writes it to disk. Existing models support editor undo. Undo last acceptance reverses the last batch only if no later edit would be overwritten. Unsaved new files can be withdrawn; undoing a saved new file leaves an empty file rather than deleting it.

Generated tests require explicit review, saving and execution. Check that assertions express the actual requirements. Test output and debugger variables may contain personal information; inspect them before requesting AI review.

## Source setup and upgrades

After `npm ci`, run both `npm run prepare:languages` and `npm run prepare:debugger` before building. The debugger preparation uses an official PyPI file with a pinned SHA256. Startup and local debugging do not download components. Upstream licenses remain in the package.

Stop the old version, extract the new package into a new folder, then migrate the old workbench folder or import an encrypted backup under Settings → Upgrade & backup. Code and Python environments stay in the original workspace.
