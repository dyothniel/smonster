// Variante de driver.mjs pour une DEUXIÈME instance Electron, avec son propre --user-data-dir
// (donc son propre browser-profiles/, refresh-token.enc, etc.) - simule une vraie seconde
// machine pour vérifier la synchro multi-machine, sans toucher au userData de l'instance par
// défaut (déjà utilisée par driver.mjs / la fenêtre déjà ouverte).
import { _electron as electron } from 'playwright-core';
import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';

const APP_DIR = path.resolve(import.meta.dirname, '../../..');
const SHOT_DIR = process.env.SCREENSHOT_DIR || '/tmp/shots';
const USER_DATA_DIR = '/tmp/claude-1000/-home-thinolord-Projets-smonster/d318483b-7f00-455b-95b1-a5af5600f395/scratchpad/instanceB-userdata';
fs.mkdirSync(SHOT_DIR, { recursive: true });

let app = null;
let page = null;

const electronBin = path.join(APP_DIR, 'node_modules/electron/dist/electron');
const MAIN_ENTRY = path.join(APP_DIR, 'dist-electron/electron/main/index.js');

const COMMANDS = {
  async launch() {
    if (app) return console.log('already launched');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({
      executablePath: electronBin,
      args: [MAIN_ENTRY, `--user-data-dir=${USER_DATA_DIR}`],
      env,
      timeout: 30_000,
    });
    page = await app.firstWindow();
    page.on('console', (msg) => console.log(`[B:console:${msg.type()}] ${msg.text()}`));
    page.on('pageerror', (err) => console.log(`[B:pageerror] ${err.message}`));
    page.on('dialog', async (dialog) => {
      console.log(`[B:dialog:${dialog.type()}] ${dialog.message()}`);
      await dialog.accept();
    });
    console.log('B launched.', app.windows().length, 'windows:');
    for (const w of app.windows()) console.log(' ', w.url());
  },
  async ss(name) {
    if (!page) return console.log('ERROR: launch first');
    const f = path.join(SHOT_DIR, (name || `ssB-${Date.now()}`) + '.png');
    await page.screenshot({ path: f });
    console.log('screenshot:', f);
  },
  async click(sel) {
    if (!page) return console.log('ERROR: launch first');
    const r = await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return 'NOT_FOUND';
      el.click();
      return 'OK';
    }, sel);
    console.log('click', sel, '->', r);
  },
  async 'click-text'(text) {
    if (!page) return console.log('ERROR: launch first');
    const r = await page.evaluate((t) => {
      const els = [...document.querySelectorAll('button, a, [role="button"]')];
      const el = els.find((e) => e.textContent?.trim() === t) ?? els.find((e) => e.textContent?.includes(t));
      if (!el) return 'NOT_FOUND';
      el.click();
      return 'OK: ' + el.tagName;
    }, text);
    console.log('click-text', JSON.stringify(text), '->', r);
  },
  async fill(args) {
    if (!page) return console.log('ERROR: launch first');
    const sp = args.indexOf(' ');
    const sel = sp === -1 ? args : args.slice(0, sp);
    const value = sp === -1 ? '' : args.slice(sp + 1);
    const r = await page.evaluate(
      ({ sel, value }) => {
        const el = document.querySelector(sel);
        if (!el) return 'NOT_FOUND';
        el.focus();
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return 'OK';
      },
      { sel, value }
    );
    console.log('fill', sel, '->', r);
  },
  async wait(sel) {
    if (!page) return console.log('ERROR: launch first');
    try {
      await page.waitForSelector(sel, { timeout: 10_000 });
      console.log('found:', sel);
    } catch {
      console.log('TIMEOUT:', sel);
    }
  },
  async eval(expr) {
    if (!page) return console.log('ERROR: launch first');
    try {
      console.log(JSON.stringify(await page.evaluate(expr)));
    } catch (e) {
      console.log('ERROR:', e.message);
    }
  },
  async text(sel) {
    if (!page) return console.log('ERROR: launch first');
    console.log(await page.evaluate((s) => (s ? document.querySelector(s) : document.body)?.innerText ?? '(null)', sel || null));
  },
  async quit() {
    if (app) await app.close().catch(() => {});
    app = null;
    page = null;
  },
  help() {
    console.log('commands:', Object.keys(COMMANDS).join(', '));
  },
};

const stdin = fs.createReadStream(null, { fd: fs.openSync('/dev/stdin', 'r') });
const rl = readline.createInterface({ input: stdin, output: process.stdout, prompt: 'B> ' });

rl.on('line', async (line) => {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  if (!cmd) return rl.prompt();
  const fn = COMMANDS[cmd];
  if (!fn) {
    console.log('unknown:', cmd, ' - try: help');
    return rl.prompt();
  }
  try {
    await fn(rest.join(' '));
  } catch (e) {
    console.log('ERROR:', e.message);
  }
  if (cmd === 'quit') {
    rl.close();
    process.exit(0);
  }
  rl.prompt();
});
rl.on('close', async () => {
  await COMMANDS.quit();
  process.exit(0);
});

console.log('instance B driver - "help" for commands, "launch" to start');
rl.prompt();
