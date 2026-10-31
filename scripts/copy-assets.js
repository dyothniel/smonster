// Copie les fichiers non-.ts que `tsc` ne copie jamais lui-même (schémas SQL, renderer Electron
// en vanilla HTML/CSS/JS...) de leur dossier source vers le dossier `dist` correspondant, en
// conservant la même arborescence relative — tsc compile les .ts, ce script s'occupe du reste.
// Appelé après `tsc` dans les scripts `build`/`build:electron` de package.json.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const JOBS = [
  { srcRoot: path.join(ROOT, 'app'), distRoot: path.join(ROOT, 'dist'), extensions: ['.sql'] },
  {
    srcRoot: path.join(ROOT, 'electron'),
    distRoot: path.join(ROOT, 'dist-electron', 'electron'),
    extensions: ['.html', '.css', '.js'],
  },
];

function copyAssets({ srcRoot, distRoot, extensions }) {
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const srcPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(srcPath);
        continue;
      }
      if (!extensions.includes(path.extname(entry.name))) continue;
      const relPath = path.relative(srcRoot, srcPath);
      const destPath = path.join(distRoot, relPath);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(srcPath, destPath);
      console.log(`copy-assets: ${relPath}`);
    }
  }
  walk(srcRoot);
}

for (const job of JOBS) {
  if (fs.existsSync(job.srcRoot)) copyAssets(job);
}
