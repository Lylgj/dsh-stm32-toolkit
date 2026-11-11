/**
 * A tiny XML reader for Keil `.uvprojx` and CMSIS-SVD files.
 *
 * It builds a plain tree `{ name, attrs, children, text }`. It is deliberately
 * forgiving: unknown declarations are skipped, and a stray `<` never throws.
 * Both formats are machine-generated and well-formed in practice; the goal is
 * "never crash the IDE on a weird pack file", not spec compliance.
 */

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

export function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body] ?? match;
  });
}

/**
 * @param {string} text
 * @returns {{name:string, attrs:Record<string,string>, children:Array, text:string}|null}
 */
export function parseXml(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  let i = 0;
  const stack = [];
  let root = null;

  const top = () => (stack.length > 0 ? stack[stack.length - 1] : null);

  const appendText = (value) => {
    const node = top();
    if (node) node.text += value;
  };

  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt === -1) {
      appendText(decodeEntities(source.slice(i)));
      break;
    }
    if (lt > i) appendText(decodeEntities(source.slice(i, lt)));
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9);
      const body = end === -1 ? source.slice(lt + 9) : source.slice(lt + 9, end);
      appendText(body);
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<?', lt) || source.startsWith('<!', lt)) {
      const end = source.indexOf('>', lt);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    const gt = findTagEnd(source, lt + 1);
    if (gt === -1) {
      appendText(decodeEntities(source.slice(lt)));
      break;
    }
    const inner = source.slice(lt + 1, gt);
    i = gt + 1;
    if (inner.startsWith('/')) {
      const name = inner.slice(1).trim();
      // Pop to the matching open tag; tolerate mismatched nesting.
      for (let k = stack.length - 1; k >= 0; k -= 1) {
        if (stack[k].name === name) {
          stack.length = k;
          break;
        }
      }
      continue;
    }
    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const space = body.search(/[\s/]/);
    const name = (space === -1 ? body : body.slice(0, space)).trim();
    if (!name) continue;
    const attrs = {};
    if (space !== -1) {
      const attrText = body.slice(space);
      const re = /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
      let m;
      while ((m = re.exec(attrText)) !== null) {
        attrs[m[1]] = decodeEntities(m[3] ?? m[4] ?? '');
      }
    }
    const node = { name, attrs, children: [], text: '' };
    const parent = top();
    if (parent) parent.children.push(node);
    else if (!root) root = node;
    if (!selfClosing) stack.push(node);
  }
  return root;
}

/** Find the closing `>` of a tag, skipping over quoted attribute values. */
function findTagEnd(source, start) {
  let quote = null;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '>') return i;
  }
  return -1;
}

export function child(node, name) {
  if (!node) return null;
  return node.children.find((c) => c.name === name) ?? null;
}

export function children(node, name) {
  if (!node) return [];
  return node.children.filter((c) => c.name === name);
}

/** Depth-first search for descendants by tag name. */
export function findAll(node, name, out = []) {
  if (!node) return out;
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
}

export function textOf(node) {
  return node ? node.text.trim() : '';
}

export function childText(node, name, fallback = '') {
  const c = child(node, name);
  return c ? textOf(c) : fallback;
}

/** Find a descendant by path of tag names, e.g. findPath(root, ['A','B','C']). */
export function findPath(node, path) {
  let current = node;
  for (const name of path) {
    current = child(current, name);
    if (!current) return null;
  }
  return current;
}
