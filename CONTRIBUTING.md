# Contributing / 贡献指南

欢迎提交问题、改进建议和 Pull Request。You can contribute bug reports, ideas, documentation, and focused changes.

## Local setup / 本机开发

Use Windows x64 and a Node.js version matching `package.json`'s `engines`. From the repository root:

```sh
npm ci
npm run prepare:languages
npm run prepare:debugger
npm run prepare:python
npm run build
npm start
```

Python and C/C++ execution require the corresponding external tools. Install test Chromium once with `npx playwright install chromium`. Before sending a change, run the checks relevant to it:

```sh
npm run typecheck
npm test
npm run test:e2e
```

Tests use local mocks; do not put real API credentials in test fixtures. Windows release packaging uses `npm run package:win`.

开发环境使用 Windows x64 和项目声明支持的 Node.js。Python、C/C++ 工具另行安装。测试使用本机模拟接口，不需要真实密钥；修改代码后运行相关检查，并在 PR 中说明验证结果。

## Pull requests / 提交改动

- Keep changes focused. Explain the user-visible problem, resulting behavior, and validation performed.
- Preserve local-only serving, Windows key protection, workspace path checks, and explicit user approval before inserting AI suggestions or advancing a mentor step.
- Update both README versions when user-facing setup or behavior changes, and maintain the Chinese/English interface translations.
- Retain third-party license notices when adding or redistributing dependencies.

请围绕具体问题提交改动，说明行为变化和验证结果。涉及用户使用方式时同步更新中英文文档；保持本机监听、工作区路径限制和明确的 AI 操作确认。

## What must stay local / 不应提交的文件

Never commit `data/`, logs, backups, personal workspaces, API keys, provider account details, downloaded runtimes, or build output. Inspect screenshots and fixtures for secrets and local personal paths before adding them. Encrypted credentials are still private and must not be committed.

`data/`、日志、备份、个人工作区、密钥、账号信息、下载的运行时和构建产物都不进入仓库。截图与测试数据也需要去除私人内容，加密后的密钥同样不能提交。

## Report a problem / 问题反馈

Use the issue templates. Include version, Windows version, steps, expected and actual behavior, and redacted logs if needed. Do not attach the complete `data/` directory. If a bug involves AI, include protocol and model name only when safe; omit keys and private code.

问题模板会引导你填写版本、环境和复现步骤。请先删除日志、截图里的私人内容。AI 问题可以说明协议和模型，不能公开密钥或私人代码。

By contributing, you agree that your contributions are licensed under this repository's MIT license.

提交贡献表示你同意该贡献使用仓库的 MIT 许可证。
