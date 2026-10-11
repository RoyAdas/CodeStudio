import { spawn } from 'node:child_process';
for (const file of ['tests/realtime-mentor.e2e.mjs', 'tests/project.e2e.mjs']) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], { stdio: 'inherit', windowsHide: true });
    child.once('error', reject); child.once('exit', resolve);
  });
  if (code !== 0) process.exit(code || 1);
}
