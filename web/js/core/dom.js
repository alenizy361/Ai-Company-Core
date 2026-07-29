// Safe DOM builders. Strings become TEXT NODES only — backend/model text can
// never inject markup. innerHTML is banned across web/ (static-guard test).
export function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else if (value === true) node.setAttribute(key, '');
      else node.setAttribute(key, String(value));
    }
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(node, child);
    else if (child instanceof Node) node.appendChild(child);
    else node.appendChild(document.createTextNode(String(child)));
  }
}

/** Technical content (ids, paths, URLs, code, metrics): LTR-isolated mono. */
export function tech(text) {
  return el('bdi', { class: 'tech', dir: 'ltr' }, text);
}

/** User/model prose: direction from content, isolated from siblings. */
export function prose(text, cls) {
  return el('bdi', { class: cls ?? null, dir: 'auto' }, text);
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function mount(region, ...children) {
  clear(region);
  append(region, children);
}
