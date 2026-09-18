/**
 * Static link checker: for every `import { a, b } from './x.js'` in src/,
 * verify the target module actually exports those names. Catches the class of
 * error that blanks a whole ES-module page (one bad binding kills the graph).
 * Run: node tools/check-imports.mjs
 */
import { readFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = [...walk(path.join(ROOT, 'src'))];

/** Exported names of a module: declarations, re-exports, and `export { }`. */
function exportsOf(file) {
  const src = readFileSync(file, 'utf8');
  const names = new Set();
  const decl =
    /^export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
  for (const m of src.matchAll(decl)) names.add(m[1]);
  // export const a = 1, b = 2;
  for (const m of src.matchAll(/^export\s+(?:const|let|var)\s+([^;=]+)/gm)) {
    for (const part of m[1].split(',')) {
      const id = part.trim().split(/[\s=]/)[0];
      if (/^[A-Za-z_$][\w$]*$/.test(id)) names.add(id);
    }
  }
  // export { a, b as c }
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      const as = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(t);
      names.add(as ? as[1] : t);
    }
  }
  if (/^export\s+default/m.test(src)) names.add('default');
  return names;
}

const cache = new Map();
const exportCache = (f) => cache.get(f) ?? (cache.set(f, exportsOf(f)), cache.get(f));

let problems = 0;
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file);
  const re = /import\s+(?:([\w$]+)\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(re)) {
    const spec = m[3];
    if (!spec.startsWith('.')) continue; // bare (three) resolved by import map
    const target = path.resolve(path.dirname(file), spec);
    if (!statSync(target, { throwIfNoEntry: false })) {
      console.log(`MISSING FILE  ${rel} -> ${spec}`);
      problems++;
      continue;
    }
    const have = exportCache(target);
    for (const part of m[2].split(',')) {
      const t = part.trim();
      if (!t) continue;
      const from = /\bas\b/.test(t) ? t.split(/\s+as\s+/)[0].trim() : t;
      if (!have.has(from)) {
        console.log(`BAD BINDING   ${rel}: '${from}' is not exported by ${spec}`);
        problems++;
      }
    }
  }
  // namespace/default imports from local files
  for (const m of src.matchAll(/import\s+([\w$]+)\s+from\s+['"](\.[^'"]+)['"]/g)) {
    const target = path.resolve(path.dirname(file), m[2]);
    if (!statSync(target, { throwIfNoEntry: false })) {
      console.log(`MISSING FILE  ${rel} -> ${m[2]}`);
      problems++;
    } else if (m[1] !== 'default' && !exportCache(target).has('default')) {
      console.log(`NO DEFAULT    ${rel}: ${m[2]} has no default export`);
      problems++;
    }
  }
}

// Dead imports (imported but never referenced again in the file body)
console.log('\n--- unused imports ---');
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file);
  for (const m of src.matchAll(/import\s+\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim();
      if (!name) continue;
      const body = src.replace(m[0], '');
      const uses = body.match(new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`, 'g'));
      if (!uses) console.log(`UNUSED        ${rel}: ${name} (from ${m[2]})`);
    }
  }
}

console.log(problems ? `\n${problems} link problem(s)` : '\nlink check: OK');
