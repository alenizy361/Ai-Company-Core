#!/usr/bin/env python3
"""Persistent AT-SPI worker process for src/desktop-bridge/atspi/host.ts.

Protocol: one JSON object per line on stdin ({"id", "action", "args"}), one
JSON object per line on stdout ({"id", "ok", "data"} or {"id", "ok", "error"}).
Never exits on its own — only on stdin EOF or a truly fatal, unhandled error —
so the Node host can keep one long-lived process around instead of paying
gi/Atspi's import cost on every single action.
"""
import json
import sys
import time

# Imported once, lazily, at module load — NOT inside every request, since
# gi.require_version() is a global, one-shot registration. If this fails
# (no AT-SPI GObject-Introspection bindings on this machine), the helper
# must still start and accept requests rather than crash at startup, so every
# handler below re-checks _ATSPI_IMPORT_ERROR and fails just that one request.
Atspi = None
_ATSPI_IMPORT_ERROR = None
try:
    import gi
    gi.require_version('Atspi', '2.0')
    from gi.repository import Atspi
except Exception as exc:
    _ATSPI_IMPORT_ERROR = str(exc)

# Bounds tree walks against cyclic/malformed accessible trees — some AT-SPI
# implementations have been known to report a widget as its own descendant.
MAX_WALK_DEPTH = 25
WAIT_FOR_POLL_INTERVAL_S = 0.15


def _require_atspi():
    if Atspi is None:
        raise RuntimeError(f'AT-SPI GObject-Introspection bindings not available: {_ATSPI_IMPORT_ERROR}')


def _safe_name(accessible):
    try:
        return accessible.get_name()
    except Exception:
        return None


def _safe_role_name(accessible):
    try:
        return accessible.get_role_name()
    except Exception:
        return None


def _safe_children(accessible):
    try:
        count = accessible.get_child_count()
    except Exception:
        return []
    children = []
    for i in range(count):
        try:
            child = accessible.get_child_at_index(i)
        except Exception:
            continue
        if child is not None:
            children.append(child)
    return children


def _top_level_apps():
    _require_atspi()
    return _safe_children(Atspi.get_desktop(0))


def _walk(accessible, app_name, depth, out):
    if depth > MAX_WALK_DEPTH:
        return
    out.append({
        'app': app_name,
        'role': _safe_role_name(accessible),
        'name': _safe_name(accessible),
        'node': accessible,
    })
    for child in _safe_children(accessible):
        _walk(child, app_name, depth + 1, out)


def _collect_nodes(app):
    """Every accessible node in scope, each tagged with its owning app name."""
    _require_atspi()
    apps = _top_level_apps()
    if app is not None:
        apps = [a for a in apps if _safe_name(a) == app]
    nodes = []
    for top in apps:
        _walk(top, _safe_name(top), 0, nodes)
    return nodes


def _matches_role(node, role):
    if role is None:
        return True
    node_role = node['role']
    return node_role is not None and node_role.lower() == role.lower()


def _find_nodes(app, role, name_pattern):
    """Core find logic — every action that locates a widget calls this, so
    "find" and e.g. "click" can never drift apart on what counts as a match."""
    nodes = [n for n in _collect_nodes(app) if _matches_role(n, role)]
    if name_pattern is None:
        return nodes

    # Cascade, stopping at the first strategy that yields >=1 match: exact
    # name -> case-insensitive substring -> (if role narrowed to exactly one
    # node) that lone node regardless of its name. This lets a caller say
    # "the only button in the Save dialog" without knowing its exact label.
    exact = [n for n in nodes if n['name'] == name_pattern]
    if exact:
        return exact
    needle = name_pattern.lower()
    substring = [n for n in nodes if n['name'] is not None and needle in n['name'].lower()]
    if substring:
        return substring
    if role is not None and len(nodes) == 1:
        return nodes
    return []


def _match_summary(node):
    return {'app': node['app'], 'role': node['role'], 'name': node['name']}


def _find_exactly_one(args):
    nodes = _find_nodes(args.get('app'), args.get('role'), args.get('name_pattern'))
    if len(nodes) == 0:
        raise RuntimeError('no accessible element matched')
    if len(nodes) > 1:
        raise RuntimeError(f'{len(nodes)} accessible elements matched — ambiguous, narrow app/role/name_pattern')
    return nodes[0]


def _supports_interface(accessible, iface_name):
    # libatspi's interface names come back as e.g. "Action" or the full
    # "org.a11y.atspi.Action" depending on binding version — substring match
    # so this doesn't silently break across libatspi releases.
    try:
        interfaces = accessible.get_interfaces()
    except Exception:
        return False
    return any(iface_name.lower() in str(i).lower() for i in interfaces)


def list_apps(args):
    apps = []
    for app in _top_level_apps():
        name = _safe_name(app)
        if name is None:
            continue
        apps.append({'name': name})
    return {'apps': apps}


def find(args):
    nodes = _find_nodes(args.get('app'), args.get('role'), args.get('name_pattern'))
    return {'matches': [_match_summary(n) for n in nodes]}


def click(args):
    node = _find_exactly_one(args)
    accessible = node['node']
    if not _supports_interface(accessible, 'Action'):
        raise RuntimeError('element does not support the accessible Action interface')
    accessible.do_action(0)
    return {}


def set_text(args):
    node = _find_exactly_one(args)
    accessible = node['node']
    if not _supports_interface(accessible, 'EditableText') or not hasattr(accessible, 'set_text_contents'):
        raise RuntimeError('element does not support editable text')
    accessible.set_text_contents(args['text'])
    return {}


def get_text(args):
    node = _find_exactly_one(args)
    accessible = node['node']
    if _supports_interface(accessible, 'Text') and hasattr(accessible, 'get_text'):
        text = accessible.get_text(0, -1)
    else:
        text = _safe_name(accessible) or ''
    return {'text': text}


def wait_for(args):
    timeout_ms = args.get('timeout_ms', 5000)
    deadline = time.monotonic() + (timeout_ms / 1000.0)
    while True:
        nodes = _find_nodes(args.get('app'), args.get('role'), args.get('name_pattern'))
        if nodes:
            return {'found': True}
        if time.monotonic() >= deadline:
            return {'found': False}
        time.sleep(WAIT_FOR_POLL_INTERVAL_S)


HANDLERS = {
    'list_apps': list_apps,
    'find': find,
    'click': click,
    'set_text': set_text,
    'get_text': get_text,
    'wait_for': wait_for,
}


def handle_request(request):
    action = request.get('action')
    args = request.get('args') or {}
    handler = HANDLERS.get(action)
    if handler is None:
        return {'ok': False, 'error': f'unknown AT-SPI action "{action}"'}
    # A bug in one request (or AT-SPI itself misbehaving on one widget) must
    # never crash the persistent process or drop other queued requests.
    try:
        return {'ok': True, 'data': handler(args)}
    except Exception as exc:
        return {'ok': False, 'error': str(exc)}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            req_id = request.get('id')
        except Exception as exc:
            # Malformed line — no id to key a response to, so id is null
            # rather than guessing; the process itself must keep running.
            print(json.dumps({'id': None, 'ok': False, 'error': f'malformed request: {exc}'}), flush=True)
            continue
        result = handle_request(request)
        # flush=True is load-bearing: a Node reader consuming stdout
        # line-by-line hangs forever on the first request if this buffers.
        print(json.dumps({'id': req_id, **result}), flush=True)


if __name__ == '__main__':
    main()
