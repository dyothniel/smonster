// REPL driver for smonster (Electron desktop app). Run on a machine with a real X11/Wayland
// display reachable (no xvfb needed here - this sandbox has DISPLAY/WAYLAND_DISPLAY already).
// Designed for agents: wrap in tmux, send-keys commands, capture-pane output.
import { _electron as electron } from 'playwright-core';
import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';

const APP_DIR = path.resolve(import.meta.dirname, '../../..');
const SHOT_DIR = process.env.SCREENSHOT_DIR || '/tmp/shots';
fs.mkdirSync(SHOT_DIR, { recursive: true });

let app = null;
let page = null;

const electronBin = path.join(APP_DIR, 'node_modules/electron/dist/electron');
const MAIN_ENTRY = path.join(APP_DIR, 'dist-electron/electron/main/index.js');

const COMMANDS = {
  async launch() {
    if (app) return console.log('already launched');
    // This sandbox sets ELECTRON_RUN_AS_NODE=1 globally for its own tooling - if left set,
    // Electron's binary runs the entry file as plain Node (require('electron').app is then
    // just a path string, not the API), so the window never opens. Must be stripped.
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({
      executablePath: electronBin,
      args: [MAIN_ENTRY],
      env,
      timeout: 30_000,
    });
    page = await app.firstWindow();
    page.on('console', (msg) => console.log(`[console:${msg.type()}] ${msg.text()}`));
    page.on('pageerror', (err) => console.log(`[pageerror] ${err.message}\n${err.stack || ''}`));
    page.on('requestfailed', (req) => console.log(`[requestfailed] ${req.method()} ${req.url()} -> ${req.failure()?.errorText}`));
    // Playwright auto-dismisses native confirm()/alert() without a handler (returns false) -
    // this app uses confirm() for the team-delete danger-zone action, so auto-accept here or
    // that flow can never be driven through to completion.
    page.on('dialog', async (dialog) => {
      console.log(`[dialog:${dialog.type()}] ${dialog.message()}`);
      await dialog.accept();
    });
    page.on('response', (res) => {
      if (res.url().includes('localhost:3002')) console.log(`[response] ${res.status()} ${res.url()}`);
    });
    console.log('launched.', app.windows().length, 'windows:');
    for (const w of app.windows()) console.log(' ', w.url());
  },

  async ss(name) {
    if (!page) return console.log('ERROR: launch first');
    const f = path.join(SHOT_DIR, (name || `ss-${Date.now()}`) + '.png');
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

  // Sets the value directly + fires input/change events (vanilla JS app, no framework) -
  // more reliable than keystroke simulation for our plain <input> fields.
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

  async type(text) {
    if (page) await page.keyboard.type(text, { delay: 30 });
  },
  async press(key) {
    if (page) await page.keyboard.press(key);
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

  async windows() {
    if (!app) return console.log('ERROR: launch first');
    for (const w of app.windows()) console.log(' ', w.url());
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
const rl = readline.createInterface({ input: stdin, output: process.stdout, prompt: 'driver> ' });

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

console.log('smonster driver - "help" for commands, "launch" to start');
rl.prompt();
