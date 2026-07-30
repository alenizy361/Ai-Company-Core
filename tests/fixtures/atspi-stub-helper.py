#!/usr/bin/env python3
"""Stub AT-SPI helper for tests/unit/atspi-host.test.ts.

Implements the exact same stdin/stdout NDJSON protocol as
../../src/desktop-bridge/atspi/helper.py, with fixed canned responses instead
of touching real AT-SPI — this exercises the real Node<->Python IPC protocol
end-to-end without needing AT-SPI itself installed or working. Deliberately
never imports gi/Atspi so it runs on any machine with a bare python3.
"""
import json
import sys


def handle(request):
    action = request.get('action')
    if action == 'ping':
        return {'ok': True, 'data': {'pong': True}}
    if action == 'fail':
        return {'ok': False, 'error': 'stub failure'}
    # Any other action: deliberately never respond, so it's the CALLER's own
    # request-timeout path that resolves it — exercises AtspiHost.call()'s
    # timeout race without needing a slow/broken real backend to simulate it.
    return None


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            req_id = request.get('id')
        except Exception as exc:
            print(json.dumps({'id': None, 'ok': False, 'error': f'malformed request: {exc}'}), flush=True)
            continue
        result = handle(request)
        if result is None:
            continue
        print(json.dumps({'id': req_id, **result}), flush=True)


if __name__ == '__main__':
    main()
