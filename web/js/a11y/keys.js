// Global keyboard shortcuts. Registered handlers receive the event and
// return true when they consumed it.
const bindings = []; // {match: (e)=>bool, run: (e)=>void}

export function bindKey(match, run) {
  bindings.push({ match, run });
}

document.addEventListener('keydown', (e) => {
  for (const b of bindings) {
    if (b.match(e)) {
      e.preventDefault();
      b.run(e);
      return;
    }
  }
});

export const isPaletteKey = (e) => (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k';
