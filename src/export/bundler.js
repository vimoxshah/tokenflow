/**
 * A ~100-line ES-module bundler.
 *
 * The dev path has no build step at all — the browser imports the same modules
 * the CLI does. This exists only so `tokenflow export --html` can emit ONE
 * self-contained file that works offline, from a file:// URL, or attached to an
 * email, where `import` from a relative path is not available.
 *
 * Rather than rename identifiers (which is where naive concatenating bundlers
 * break), each module keeps its own function scope and exports are wired
 * through a tiny require registry. The module graph here is acyclic and uses
 * only static imports, which is what makes this safe.
 */
import fs from 'node:fs';
import path from 'node:path';

const IMPORT_RE = /^[ \t]*import\s+(?:([\w$]+)\s*,\s*)?(?:\{([^}]*)\}|\*\s*as\s+([\w$]+)|([\w$]+))?\s*(?:from\s*)?['"]([^'"]+)['"]\s*;?[ \t]*$/gm;
// `export { a, b }` — possibly spanning many lines, as re-export barrels do.
const EXPORT_LIST_RE = /^[ \t]*export\s*\{([\s\S]*?)\}[ \t]*;?[ \t]*$/gm;
const EXPORT_DECL_RE = /^[ \t]*export\s+(async\s+function|function\*?|class|const|let|var)\s+([\w$]+)/gm;
const EXPORT_DEFAULT_RE = /^[ \t]*export\s+default\s+/m;

export function bundle(entry, { root = process.cwd() } = {}) {
  const modules = new Map();
  const order = [];

  const load = (file) => {
    const abs = path.resolve(file);
    if (modules.has(abs)) return abs;
    const src = fs.readFileSync(abs, 'utf8');
    const mod = { abs, id: rel(abs, root), src, deps: [], exports: new Set(), hasDefault: false };
    modules.set(abs, mod);

    // ---- collect + rewrite imports
    let body = src.replace(IMPORT_RE, (m, defWithNamed, named, ns, defOnly, spec) => {
      if (!spec.startsWith('.') && !spec.startsWith('/')) {
        throw new Error(`snapshot bundler: bare import "${spec}" in ${mod.id} — only relative imports are supported`);
      }
      const depAbs = resolve(abs, spec);
      mod.deps.push(depAbs);
      const id = rel(depAbs, root);
      const parts = [];
      const defName = defWithNamed || defOnly;
      if (defName && !ns) parts.push(`const ${defName} = __req(${JSON.stringify(id)}).default;`);
      if (ns) parts.push(`const ${ns} = __req(${JSON.stringify(id)});`);
      if (named) {
        const bindings = named.split(',').map((s) => s.trim()).filter(Boolean)
          .map((s) => {
            const mm = s.split(/\s+as\s+/);
            return mm.length === 2 ? `${mm[0].trim()}: ${mm[1].trim()}` : s;
          });
        if (bindings.length) parts.push(`const { ${bindings.join(', ')} } = __req(${JSON.stringify(id)});`);
      }
      return parts.join(' ');
    });

    // ---- collect exports
    for (const m of src.matchAll(EXPORT_DECL_RE)) mod.exports.add(m[2]);
    for (const m of src.matchAll(EXPORT_LIST_RE)) {
      for (const s of m[1].split(',')) {
        const t = s.trim();
        if (!t) continue;
        const parts = t.split(/\s+as\s+/);
        mod.exports.add((parts[1] || parts[0]).trim());
      }
    }
    if (EXPORT_DEFAULT_RE.test(src)) mod.hasDefault = true;

    // ---- strip the `export` keyword / statements
    body = body
      .replace(EXPORT_LIST_RE, '')
      .replace(/^([ \t]*)export\s+default\s+/m, '$1const __default = ')
      .replace(/^([ \t]*)export\s+/gm, '$1');
    mod.body = body;

    for (const d of mod.deps) load(d);
    order.push(abs);
    return abs;
  };

  const entryAbs = load(entry);

  let out = '';
  out += '(function(){\n"use strict";\nvar __registry = {}, __cache = {};\n';
  out += 'function __req(id){ if(__cache[id]) return __cache[id].e; var m=__registry[id]; if(!m) throw new Error("module not found: "+id); var e={}; __cache[id]={e:e}; m(e); return e; }\n';
  for (const abs of order) {
    const m = modules.get(abs);
    const assigns = [...m.exports].map((n) => `  __exports.${n} = ${n};`).join('\n');
    const def = m.hasDefault ? '  __exports.default = __default;\n' : '';
    out += `__registry[${JSON.stringify(m.id)}] = function(__exports){\n${m.body}\n${assigns}\n${def}};\n`;
  }
  out += `__req(${JSON.stringify(modules.get(entryAbs).id)});\n})();\n`;
  return out;
}

function resolve(fromFile, spec) {
  const p = path.resolve(path.dirname(fromFile), spec);
  if (fs.existsSync(p)) return p;
  for (const ext of ['.js', '.mjs', '/index.js']) {
    if (fs.existsSync(p + ext)) return p + ext;
  }
  throw new Error(`snapshot bundler: cannot resolve "${spec}" from ${fromFile}`);
}

function rel(abs, root) {
  return path.relative(root, abs).split(path.sep).join('/');
}
