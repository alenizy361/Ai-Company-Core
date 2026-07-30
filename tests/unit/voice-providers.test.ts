import { test } from 'node:test';
import assert from 'node:assert';
import { fishConfigured, chatterboxState } from '../../src/server/routes/voice-providers.ts';

test('fishConfigured: FISH_API_KEY is canonical, FISH_AUDIO_API_KEY still accepted', () => {
  assert.equal(fishConfigured({}), false);
  assert.equal(fishConfigured({ FISH_API_KEY: 'k1' }), true);
  assert.equal(fishConfigured({ FISH_AUDIO_API_KEY: 'k2' }), true);
  assert.equal(fishConfigured({ FISH_API_KEY: 'k1', FISH_AUDIO_API_KEY: 'k2' }), true);
});

test('chatterboxState: url/enabled/only gating', () => {
  assert.deepEqual(chatterboxState({}), { url: '', enabled: false, only: false });

  assert.deepEqual(
    chatterboxState({ CHATTERBOX_URL: 'http://127.0.0.1:8765' }),
    { url: 'http://127.0.0.1:8765', enabled: true, only: false },
  );

  assert.deepEqual(
    chatterboxState({ CHATTERBOX_URL: 'http://127.0.0.1:8765', CHATTERBOX_ENABLED: 'off' }),
    { url: 'http://127.0.0.1:8765', enabled: false, only: false },
  );

  // CHATTERBOX_ONLY without a URL configured must not report enabled/only.
  assert.deepEqual(
    chatterboxState({ CHATTERBOX_ONLY: '1' }),
    { url: '', enabled: false, only: false },
  );

  for (const onlyVal of ['1', 'on']) {
    assert.deepEqual(
      chatterboxState({ CHATTERBOX_URL: 'http://127.0.0.1:8765', CHATTERBOX_ONLY: onlyVal }),
      { url: 'http://127.0.0.1:8765', enabled: true, only: true },
    );
  }

  // CHATTERBOX_ENABLED=off must gate CHATTERBOX_ONLY too — a service that is
  // never used because it's disabled cannot also be the "only" voice.
  assert.deepEqual(
    chatterboxState({ CHATTERBOX_URL: 'http://127.0.0.1:8765', CHATTERBOX_ENABLED: 'off', CHATTERBOX_ONLY: '1' }),
    { url: 'http://127.0.0.1:8765', enabled: false, only: false },
  );
});
