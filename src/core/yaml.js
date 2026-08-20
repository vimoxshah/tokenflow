/**
 * A deliberately small YAML subset — enough for a config file, with zero
 * dependencies and no surprises.
 *
 * Supported: nested mappings by indentation, block sequences (`- x`),
 * sequences of mappings, scalars (string / number / bool / null), single- and
 * double-quoted strings, inline flow arrays (`[a, b]`), `#` comments,
 * `key:` with an empty value (=> {}), and multi-line values via `|` / `>`.
 *
 * NOT supported (and rejected loudly rather than mis-parsed): anchors,
 * aliases, tags, multiple documents, complex keys, flow mappings.
 * `config.json` is always accepted as an alternative.
 */

export function parseYaml(text) {
  const lines = String(text).split(/\r?\n/);
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (/^\s*$/.test(raw)) continue;
    if (/^\s*#/.test(raw)) continue;
    if (/^\s*(---|\.\.\.)\s*$/.test(raw)) continue;
    if (/^\s*[&*!]/.test(raw)) throw new Error(`yaml: anchors/aliases/tags are not supported (line ${i + 1})`);
    const indent = raw.match(/^ */)[0].length;
    rows.push({ indent, text: stripComment(raw.trim()), line: i + 1 });
  }
  const [value] = parseBlock(rows, 0, rows.length > 0 ? rows[0].indent : 0);
  return value ?? {};
}

function stripComment(s) {
  let out = '';
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      out += c;
      if (c === q && s[i - 1] !== '\\') q = null;
      continue;
    }
    if (c === '"' || c === "'") { q = c; out += c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) break;
    out += c;
  }
  return out.trim();
}

function parseBlock(rows, i, indent) {
  if (i >= rows.length) return [null, i];
  if (rows[i].text.startsWith('- ') || rows[i].text === '-') return parseSeq(rows, i, indent);
  return parseMap(rows, i, indent);
}

function parseMap(rows, i, indent) {
  const obj = {};
  while (i < rows.length && rows[i].indent >= indent) {
    if (rows[i].indent > indent) throw new Error(`yaml: unexpected indent (line ${rows[i].line})`);
    const { text, line } = rows[i];
    const m = text.match(/^([^:]+):(?:\s+(.*))?$/);
    if (!m) throw new Error(`yaml: expected "key: value" (line ${line}): ${text}`);
    const key = unquote(m[1].trim());
    const inline = m[2] === undefined ? '' : m[2].trim();
    i++;
    if (inline === '|' || inline === '>' || inline === '|-' || inline === '>-') {
      const childIndent = i < rows.length ? rows[i].indent : indent + 2;
      const parts = [];
      while (i < rows.length && rows[i].indent >= childIndent && childIndent > indent) {
        parts.push(rows[i].text);
        i++;
      }
      obj[key] = inline[0] === '|' ? parts.join('\n') : parts.join(' ');
      continue;
    }
    if (inline !== '') {
      obj[key] = scalar(inline);
      continue;
    }
    // Nested block, if the next row is deeper.
    if (i < rows.length && rows[i].indent > indent) {
      const [v, ni] = parseBlock(rows, i, rows[i].indent);
      obj[key] = v;
      i = ni;
    } else if (i < rows.length && rows[i].indent === indent && rows[i].text.startsWith('- ')) {
      // A sequence at the same indent as its key (valid YAML).
      const [v, ni] = parseSeq(rows, i, indent);
      obj[key] = v;
      i = ni;
    } else {
      obj[key] = {};
    }
  }
  return [obj, i];
}

function parseSeq(rows, i, indent) {
  const arr = [];
  while (i < rows.length && rows[i].indent === indent && (rows[i].text.startsWith('- ') || rows[i].text === '-')) {
    const body = rows[i].text === '-' ? '' : rows[i].text.slice(2).trim();
    i++;
    if (body === '') {
      if (i < rows.length && rows[i].indent > indent) {
        const [v, ni] = parseBlock(rows, i, rows[i].indent);
        arr.push(v);
        i = ni;
      } else arr.push(null);
      continue;
    }
    if (/^[^:\s][^:]*:(\s|$)/.test(body)) {
      // sequence of mappings: "- key: value" plus deeper sibling keys
      const synthetic = [{ indent: indent + 2, text: body, line: rows[i - 1].line }];
      while (i < rows.length && rows[i].indent > indent) {
        synthetic.push({ indent: indent + 2, text: rows[i].text, line: rows[i].line });
        i++;
      }
      const [v] = parseMap(synthetic, 0, indent + 2);
      arr.push(v);
      continue;
    }
    arr.push(scalar(body));
  }
  return [arr, i];
}

function scalar(s) {
  // An anchor, alias or tag in a value position: refuse rather than store the
  // literal text and quietly change the meaning of someone's config.
  if (/^[&*!]/.test(s)) throw new Error(`yaml: anchors/aliases/tags are not supported ("${s}")`);
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return splitFlow(inner).map((x) => scalar(x.trim()));
  }
  if (s === '{}') return {};
  if (s.startsWith('{')) throw new Error('yaml: flow mappings are not supported (use nested keys)');
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return unquote(s);
  if (s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
  if (s === 'true' || s === 'True' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === 'False' || s === 'no' || s === 'off') return false;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d*\.\d+(e[-+]?\d+)?$/i.test(s)) return parseFloat(s);
  return s;
}

function splitFlow(s) {
  const out = [];
  let depth = 0, q = null, cur = '';
  for (const c of s) {
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '[') depth++;
    if (c === ']') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function unquote(s) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    const body = s.slice(1, -1);
    return s[0] === '"' ? body.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\') : body.replace(/''/g, "'");
  }
  return s;
}

// ---------------------------------------------------------------------------

export function stringifyYaml(value, indent = 0) {
  const pad = ' '.repeat(indent);
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return value
      .map((v) => {
        if (v !== null && typeof v === 'object') {
          const body = stringifyYaml(v, indent + 2);
          return `${pad}- ${body.trimStart()}`;
        }
        return `${pad}- ${scalarOut(v)}`;
      })
      .join('\n');
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    return keys
      .map((k) => {
        const v = value[k];
        if (v !== null && typeof v === 'object' && (Array.isArray(v) ? v.length : Object.keys(v).length)) {
          return `${pad}${k}:\n${stringifyYaml(v, indent + 2)}`;
        }
        if (v !== null && typeof v === 'object') return `${pad}${k}: ${Array.isArray(v) ? '[]' : '{}'}`;
        return `${pad}${k}: ${scalarOut(v)}`;
      })
      .join('\n');
  }
  return scalarOut(value);
}

function scalarOut(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  if (s === '' || /^[\s]|[\s]$|[:#\[\]{}&*!|>'"%@`,]|^(true|false|null|yes|no|on|off|~|-?\d)/i.test(s)) {
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
  }
  return s;
}
