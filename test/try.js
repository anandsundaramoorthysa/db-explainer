// Opens this copy of the extension in a separate VS Code window, with its own settings and saved keys. Run with: npm run try
const { spawn } = require('child_process');
const path = require('path');

const repo = path.resolve(__dirname, '..');
const args = [`--extensionDevelopmentPath="${repo}"`, `--user-data-dir="${path.join(repo, '.vscode-test', 'try-profile')}"`];
spawn('code', args, { shell: true, stdio: 'inherit' }).on('exit', (code) => process.exit(code ?? 0));
