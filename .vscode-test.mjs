import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/**/*.test.js',
  launchArgs: ['--enable-proposed-api=libiaorobot.libiao-copilot'],
  mocha: {
    ui: 'tdd',
    timeout: 20000,
    color: true
  }
});