// siraAppendPrompt's "Automation method preference" section — the
// model-facing half of the desktop/browser/AT-SPI tool router (there is no
// code-level action classifier; SIRA's own tool-selection reasoning IS the
// router, steered by this text + the tool descriptions). Must only mention
// tool families actually wired into the session (see session.ts's
// desktopPolicy/browserPolicy/atspiPolicy gates) — telling the model to
// prefer a tool it doesn't have would just be confusing.
import { test } from 'node:test';
import assert from 'node:assert';
import { siraAppendPrompt } from '../../src/sira/append-prompt.ts';

const BASE = { orgName: 'Test Org', replyLang: null as 'en' | 'ar' | null };

test('siraAppendPrompt: no automation section when nothing is enabled', () => {
  const prompt = siraAppendPrompt(BASE);
  assert.doesNotMatch(prompt, /Automation method preference/);
});

test('siraAppendPrompt: desktop-only mentions coordinate control with no "fall back" framing (nothing to fall back from)', () => {
  const prompt = siraAppendPrompt({ ...BASE, desktopEnabled: true });
  assert.match(prompt, /Automation method preference/);
  assert.match(prompt, /desktop_screenshot \+ desktop_click give you full screen\/mouse\/keyboard control/);
  assert.doesNotMatch(prompt, /browser_\*/);
  assert.doesNotMatch(prompt, /atspi_\*/);
});

test('siraAppendPrompt: browser-only mentions browser_* but not atspi_*/desktop_*', () => {
  const prompt = siraAppendPrompt({ ...BASE, browserEnabled: true });
  assert.match(prompt, /Website or web app -> browser_\* tools/);
  assert.doesNotMatch(prompt, /atspi_\*/);
  assert.doesNotMatch(prompt, /desktop_screenshot/);
});

test('siraAppendPrompt: all three enabled orders browser -> atspi -> desktop-as-fallback', () => {
  const prompt = siraAppendPrompt({ ...BASE, desktopEnabled: true, browserEnabled: true, atspiEnabled: true });
  const browserIdx = prompt.indexOf('browser_*');
  const atspiIdx = prompt.indexOf('atspi_*');
  const fallbackIdx = prompt.indexOf('Only fall back to desktop_screenshot');
  assert.ok(browserIdx > 0 && atspiIdx > browserIdx && fallbackIdx > atspiIdx, 'expects browser, then atspi, then desktop fallback guidance in that order');
  assert.match(prompt, /Never take a screenshot "just to check" after a successful action/);
});
