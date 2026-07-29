// Focus management: trap inside open dialogs/drawers, restore on close,
// Escape closes the topmost layer.
const FOCUSABLE = 'a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])';

const layers = []; // {container, restoreTo, onClose}

export function openLayer(container, onClose) {
  const restoreTo = document.activeElement;
  layers.push({ container, restoreTo, onClose });
  const first = container.querySelector(FOCUSABLE);
  (first ?? container).focus?.();
}

export function closeLayer(container) {
  const idx = layers.findIndex((l) => l.container === container);
  if (idx === -1) return;
  const [layer] = layers.splice(idx, 1);
  layer.restoreTo?.focus?.();
}

export function closeTopLayer() {
  const top = layers[layers.length - 1];
  if (!top) return false;
  top.onClose?.();
  return true;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (closeTopLayer()) e.preventDefault();
    return;
  }
  if (e.key !== 'Tab' || layers.length === 0) return;
  const { container } = layers[layers.length - 1];
  const focusables = [...container.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null || n === document.activeElement);
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    last.focus();
    e.preventDefault();
  } else if (!e.shiftKey && document.activeElement === last) {
    first.focus();
    e.preventDefault();
  }
});
