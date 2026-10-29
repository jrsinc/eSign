// Runs every test/NN-name.test.js suite against its own fresh server: a temporary data folder, email
// off (messages are printed to the server log, where suites read codes and passwords), and no .env.
//   npm test                  all suites
//   npm test -- identity      only suites whose file name contains "identity"
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const filter = process.argv[2] || '';
const suites = fs.readdirSync(__dirname).filter((f) => /^\d+-.+\.test\.js$/.test(f) && f.includes(filter)).sort();

// Settings that must never reach a test server (real email, production checks).
const BLOCKED = /^(SMTP_|MAIL_FROM|NOTIFY_EMAIL|SUPPORT_EMAIL|ADMIN_PASSWORD|NODE_ENV|BASE_URL|DATA_DIR|BACKUP_DIR|AUTO_BACKUP|PORT$|APP_NAME|COMPANY_NAME|TRUST_PROXY|LOGIN_CODE)/;
// A suite can ask for server settings on its first line: `// env: LOGIN_CODE=off OTHER=value`.
const suiteEnv = (file) => {
  const m = /^\/\/ env:(.*)$/m.exec(fs.readFileSync(path.join(__dirname, file), 'utf8').split('\n')[0]);
  return m ? Object.fromEntries(m[1].trim().split(/\s+/).map((kv) => kv.split('='))) : {};
};
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !BLOCKED.test(k)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntilUp(base) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error('test server did not start');
}

function runNode(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

(async () => {
  let passed = 0;
  const failed = [];
  for (const [i, suite] of suites.entries()) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'method365-test-'));
    const dataDir = path.join(dir, 'data');
    fs.mkdirSync(dataDir);
    const logFile = path.join(dir, 'server.log');
    const port = 4100 + i;
    const base = `http://127.0.0.1:${port}`;
    const env = { ...cleanEnv, ENV_FILE: 'none', DATA_DIR: dataDir, PORT: String(port), BASE_URL: base, COMPANY_NAME: 'JRS', ...suiteEnv(suite) };

    console.log(`\n=== ${suite}`);
    const log = fs.openSync(logFile, 'w');
    const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', log, log] });
    try {
      await waitUntilUp(base);
      const { code, out } = await runNode([path.join(__dirname, suite), logFile, ROOT], { ...env, B: base });
      const p = (out.match(/^PASS /gm) || []).length;
      const f = out.match(/^FAIL .*/gm) || [];
      passed += p;
      f.forEach((line) => failed.push(`${suite}: ${line.slice(6)}`));
      if (code !== 0 && !f.length) failed.push(`${suite}: stopped with an error (exit code ${code})\n${out.split('\n').slice(-15).join('\n')}`);
    } catch (e) {
      failed.push(`${suite}: ${e.message}\n${fs.readFileSync(logFile, 'utf8').slice(-2000)}`);
    } finally {
      server.kill();
      await new Promise((r) => (server.exitCode !== null ? r() : server.once('exit', r)));
      fs.closeSync(log);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  console.log(`\n${passed} passed, ${failed.length} failed in ${suites.length} suites`);
  if (failed.length) {
    console.log(`\nFailures:\n- ${failed.join('\n- ')}`);
    process.exit(1);
  }
})();
