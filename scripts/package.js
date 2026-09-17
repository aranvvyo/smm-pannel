// Builds instasmm.zip — the distributable project archive.
// Excludes node_modules, runtime DB files, logs, and .env (secrets).
// Usage: node scripts/package.js   (or: npm run package)
import AdmZip from 'adm-zip';
import { readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// Patterns matched against the path RELATIVE to root. A directory name here
// excludes it and everything under it.
const IGNORE_DIRS = new Set(['node_modules', '.git', 'data', '.claude']);
// Basenames always skipped anywhere in the tree.
const IGNORE_FILES = new Set(['.env', 'instasmm.zip', '.DS_Store']);
const IGNORE_EXT = new Set(['.db', '.db-journal', '.log']);

function shouldSkip(rel) {
  const parts = rel.split(path.sep);
  if (parts.some((p) => IGNORE_DIRS.has(p))) return true;
  const base = parts[parts.length - 1];
  if (IGNORE_FILES.has(base)) return true;
  const ext = path.extname(base);
  if (IGNORE_EXT.has(ext)) return true;
  return false;
}

console.log('[instasmm] packaging project → instasmm.zip');
const zip = new AdmZip();
let count = 0;

const walk = (dir, rel = '') => {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const childRel = rel ? `${rel}/${entry}` : entry;
    if (shouldSkip(childRel)) continue;
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, childRel);
    } else if (st.isFile()) {
      zip.addLocalFile(full, path.dirname(childRel));
      count++;
    }
  }
};

walk(root);

const outPath = path.join(root, 'instasmm.zip');
zip.writeZip(outPath);
console.log(`[instasmm] wrote ${outPath} with ${count} files`);
console.log(`[instasmm] size: ${(statSync(outPath).size / 1024 / 1024).toFixed(2)} MB`);
console.log('[instasmm] (node_modules / data / .env excluded — run `npm install` on the target machine)');