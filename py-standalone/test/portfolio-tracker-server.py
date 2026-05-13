#!/usr/bin/env python3
"""portfolio-tracker-server.py

Python port of portfolio-tracker-server.js.

Minimal single-board HTTP server for the portfolio-tracker example.
Uses create_single_board_server_runtime from py-server-runtime.

Cards are seeded inline on first start (if the card store is empty).
Task executor: portfolio-tracker-fetch-prices.py (mock-quotes source kind).

Usage:
    python portfolio-tracker-server.py [--port 7801] [--reset]

Endpoints (all under /api/board):
    GET  /api/board/init-board
    GET  /api/board/sse
    GET  /api/board/board-status
    PATCH /api/board/cards/:id
    POST  /api/board/cards/:id/actions
"""
from __future__ import annotations

import argparse
import http.server
import json
import os
import select
import shutil
import sys
import tempfile
import threading
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse, parse_qs, unquote

# ── Path resolution ────────────────────────────────────────────────────────────

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.normpath(os.path.join(_HERE, '..', 'core'))
_PYCLI_ROOT = _REPO_ROOT
if _PYCLI_ROOT not in sys.path:
    sys.path.insert(0, _PYCLI_ROOT)

_PY_SERVER_RUNTIME_DIR = os.path.join(_PYCLI_ROOT, 'server')
if _PY_SERVER_RUNTIME_DIR not in sys.path:
    sys.path.insert(0, _PY_SERVER_RUNTIME_DIR)

from index import create_single_board_server_runtime  # noqa: E402

_PYCLI_SUB = os.path.join(_PYCLI_ROOT, 'sub')
if _PYCLI_SUB not in sys.path:
    sys.path.insert(0, _PYCLI_SUB)

from board_live_cards_adapters import (  # noqa: E402
    ExecutionRef,
    FsKvStorage,
    FsBlobStorage,
    FsJournalStorageAdapter,
    FileAtomicRelayLock,
    compute_stable_json_hash,
    dispatch_execution as _dispatch_execution_impl,
)
from pylib.cli.storage_interface import parse_ref, serialize_ref  # noqa: E402

# ── CLI args ───────────────────────────────────────────────────────────────────

_parser = argparse.ArgumentParser()
_parser.add_argument('--port', type=int, default=7801)
_parser.add_argument('--run-id', type=str, default='')
_parser.add_argument('--reset', action='store_true')
_args = _parser.parse_args()

PORT = _args.port
RUN_ID = _args.run_id
RESET = _args.reset

# ── Paths ──────────────────────────────────────────────────────────────────────

_setup_suffix = RUN_ID or str(PORT)
SETUP_DIR = os.path.join(tempfile.gettempdir(), f'portfolio-tracker-py-server-{_setup_suffix}')
RUNTIME_DIR = os.path.join(SETUP_DIR, 'runtime')
CARDS_DIR = os.path.join(SETUP_DIR, 'cards')
OUTPUTS_DIR = os.path.join(SETUP_DIR, 'outputs')
FETCH_PRICES_PY = os.path.join(_HERE, 'portfolio-tracker-fetch-prices.py')

if RESET and os.path.exists(SETUP_DIR):
    shutil.rmtree(SETUP_DIR, ignore_errors=True)
    print(f'[portfolio-tracker-server.py] reset: wiped {SETUP_DIR}')

for _d in [RUNTIME_DIR, CARDS_DIR, OUTPUTS_DIR]:
    os.makedirs(_d, exist_ok=True)

# ── Inline card definitions ────────────────────────────────────────────────────

INLINE_CARDS: List[Dict[str, Any]] = [
    {
        'id': 'portfolio-form',
        'meta': {'title': 'Portfolio Holdings Form'},
        'provides': [{'bindTo': 'holdings', 'ref': 'card_data.holdings'}],
        'card_data': {'holdings': [{'symbol': 'AAPL', 'qty': 50}, {'symbol': 'MSFT', 'qty': 30}]},
        'view': {
            'elements': [
                {'kind': 'table', 'label': 'Holdings',
                 'data': {'bind': 'card_data.holdings', 'columns': ['symbol', 'qty']}},
            ],
        },
    },
    {
        'id': 'price-fetch',
        'meta': {'title': 'Fetch Market Prices'},
        'requires': ['holdings'],
        'provides': [{'bindTo': 'prices', 'ref': 'computed_values.prices'}],
        'card_data': {},
        'compute': [{
            'bindTo': 'prices',
            'expr': '$merge($map(requires.holdings, function($h){ { $h.symbol: 100 } }))',
        }],
        'view': {
            'elements': [
                {'kind': 'table', 'label': 'Market Prices', 'data': {'bind': 'computed_values.prices'}},
            ],
        },
    },
    {
        'id': 'holdings-table',
        'meta': {'title': 'Holdings Table'},
        'requires': ['holdings', 'prices'],
        'provides': [{'bindTo': 'table', 'ref': 'computed_values.table'}],
        'card_data': {},
        'compute': [{
            'bindTo': 'table',
            'expr': ('{ "rows": $map(requires.holdings, function($h) {'
                     ' { "symbol": $h.symbol, "qty": $h.qty,'
                     ' "price": $lookup(requires.prices, $h.symbol),'
                     ' "value": $h.qty * $lookup(requires.prices, $h.symbol) } }) }'),
        }],
        'view': {
            'elements': [
                {'kind': 'table', 'label': 'Portfolio Positions',
                 'data': {'bind': 'computed_values.table.rows', 'columns': ['symbol', 'qty', 'price', 'value']}},
            ],
        },
    },
    {
        'id': 'portfolio-value',
        'meta': {'title': 'Portfolio Total Value'},
        'requires': ['table'],
        'provides': [{'bindTo': 'totalValue', 'ref': 'computed_values.totalValue'}],
        'card_data': {},
        'compute': [{'bindTo': 'totalValue', 'expr': '$sum(requires.table.rows.value)'}],
        'view': {
            'elements': [
                {'kind': 'metric', 'label': 'Total Portfolio Value',
                 'data': {'bind': 'computed_values.totalValue'}},
            ],
        },
    },
]

# ── FS adapter helpers ─────────────────────────────────────────────────────────

def _make_kv(root: str):
    kv = FsKvStorage(root)
    class _KV:
        def read(self, key): return kv.read(key)
        def write(self, key, value): kv.write(key, value)
        def delete(self, key): kv.delete(key)
        def list_keys(self, prefix=None): return kv.list_keys(prefix)
    return _KV()


def _make_blob(root: str):
    blob = FsBlobStorage(root)
    class _Blob:
        def read(self, key): return blob.read(key)
        def write(self, key, content): blob.write(key, content)
        def exists(self, key): return blob.exists(key)
        def remove(self, key): blob.remove(key)
        def list_keys(self, prefix: str = '') -> List[str]:
            root_path = Path(root)
            if not root_path.is_dir():
                return []
            results = []
            for p in root_path.rglob('*'):
                if p.is_file():
                    rel = p.relative_to(root_path).as_posix()
                    if not prefix or rel.startswith(prefix):
                        results.append(rel)
            return sorted(results)
    return _Blob()


def _make_journal(scope: str):
    j = FsJournalStorageAdapter(scope)
    class _Journal:
        def read_all_entries(self): return j.read_all_entries()
        def append_entry(self, entry): j.append_entry(entry)
        def generate_id(self): return j.generate_id()
    return _Journal()


def _make_lock(lock_path: str):
    lk = FileAtomicRelayLock(lock_path)
    class _Lock:
        def try_acquire(self): return lk.try_acquire()
    return _Lock()


def create_fs_board_platform_adapter(base_ref: Dict[str, str]):
    """FS-backed board platform adapter for the server context."""
    scope = base_ref['value']

    class _Adapter:
        def kv_storage(self, namespace: str):
            root = os.path.join(scope, f'.{namespace}') if namespace else scope
            return _make_kv(root)

        def kv_storage_for_ref(self, ref: str):
            return _make_kv(parse_ref(ref)['value'])

        def blob_storage(self, namespace: str):
            root = os.path.join(scope, namespace) if namespace else scope
            return _make_blob(root)

        def journal_adapter(self):
            return _make_journal(scope)

        @property
        def lock(self):
            return _make_lock(os.path.join(scope, '.board.lock'))

        @property
        def self_ref(self) -> Dict[str, Any]:
            return {
                'meta': 'board-live-cards',
                'howToRun': 'local-python',
                'whatToRun': serialize_ref({'kind': 'fs-path', 'value': os.path.join(_PYCLI_ROOT, 'cli', 'board_live_cards_pycli.py')}),
            }

        def dispatch_execution(self, ref: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
            """Dispatch a source-fetch task executor subprocess."""
            exec_ref = ExecutionRef(
                meta=ref.get('meta'),
                howToRun=ref.get('howToRun', ''),
                whatToRun=ref.get('whatToRun', ''),
            )
            label = (args.get('source_def') or {}).get('bindTo') or uuid.uuid4().hex[:8]
            tmp_dir = os.path.join(scope, '.tmp')
            os.makedirs(tmp_dir, exist_ok=True)
            in_file = os.path.join(tmp_dir, f'exec-in-{label}.json')
            out_file = os.path.join(tmp_dir, f'exec-out-{label}.json')
            err_file = os.path.join(tmp_dir, f'exec-err-{label}.txt')
            with open(in_file, 'w', encoding='utf-8') as f:
                json.dump(args, f, indent=2)
            return _dispatch_execution_impl(exec_ref, {
                'subcommand': 'run-source-fetch',
                'inRef': serialize_ref({'kind': 'fs-path', 'value': in_file}),
                'outRef': serialize_ref({'kind': 'fs-path', 'value': out_file}),
                'errRef': serialize_ref({'kind': 'fs-path', 'value': err_file}),
            }, cwd=scope, detached=True)

        def resolve_blob(self, ref: Dict[str, str]) -> str:
            if ref.get('kind') == 'fs-path':
                with open(ref['value'], 'r', encoding='utf-8') as f:
                    return f.read()
            raise ValueError(f'resolveBlob: unsupported kind: {ref.get("kind")}')

        def hash_fn(self, value: Any) -> str:
            return compute_stable_json_hash(value)

        def gen_id(self) -> str:
            return uuid.uuid4().hex[:32]

        def request_process_accumulated(self) -> None:
            # No-op: the polling thread below drives drain in the server process
            # every 2 seconds using this same adapter (with the runtime-hooked publish).
            pass

        def publish_board_change_notifications(self, notifications) -> None:
            pass  # Overridden by the runtime to broadcast to SSE clients

    return _Adapter()


def create_invocation_adapter():
    """Generic invocation adapter (for chat handlers etc — not used by portfolio-tracker)."""
    class _Adapter:
        def invoke(self, ref: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
            how = ref.get('howToRun', '')
            what = str(ref.get('whatToRun') or '')
            if what.startswith('b64:'):
                try:
                    parsed = parse_ref(what)
                    script_path = parsed.get('value') if parsed.get('kind') == 'fs-path' else ''
                except Exception:
                    script_path = ''
            else:
                script_path = what
            if not script_path:
                return {'dispatched': False, 'error': f'no script path: {what}'}
            if how == 'local-python':
                interpreter = sys.executable
            elif how == 'local-node':
                interpreter = shutil.which('node') or 'node'
            else:
                return {'dispatched': False, 'error': f'unsupported howToRun: {how}'}
            import base64
            import subprocess
            extra = base64.b64encode(json.dumps(args).encode('utf-8')).decode('ascii')
            cmd = [interpreter, script_path,
                   '--boardId', str(args.get('boardId') or ''),
                   '--cardId', str(args.get('cardId') or ''),
                   '--extraEncJson', extra]
            try:
                if sys.platform == 'win32':
                    subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                     creationflags=0x08000000)
                else:
                    subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                     start_new_session=True)
                return {'dispatched': True}
            except Exception as e:
                return {'dispatched': False, 'error': str(e)}
    return _Adapter()


# ── Board adapter & runtime ────────────────────────────────────────────────────

base_ref = parse_ref(serialize_ref({'kind': 'fs-path', 'value': RUNTIME_DIR}))
board_adapter = create_fs_board_platform_adapter(base_ref)
card_store_ref = serialize_ref({'kind': 'fs-path', 'value': os.path.join(CARDS_DIR, 'cards')})
outputs_store_ref = serialize_ref({'kind': 'fs-path', 'value': os.path.join(OUTPUTS_DIR, '.outputs')})
task_executor_ref = {
    'howToRun': 'local-python',
    'whatToRun': serialize_ref({'kind': 'fs-path', 'value': FETCH_PRICES_PY}),
    'meta': 'task-executor',
}

_logger = type('L', (), {
    'info': staticmethod(lambda msg, *a: print(f'[portfolio-tracker-server.py] {msg}', *a)),
    'warn': staticmethod(lambda msg, *a: print(f'[portfolio-tracker-server.py][WARN] {msg}', *a)),
    'error': staticmethod(lambda msg, *a: print(f'[portfolio-tracker-server.py][ERROR] {msg}', *a)),
})()

runtime = create_single_board_server_runtime({
    'api_base_path': '/api/board',
    'board_id': 'portfolio-tracker',
    'boards': [{
        'label': 'portfolio-tracker',
        'board_adapter': board_adapter,
        'base_ref': base_ref,
        'card_store_ref': card_store_ref,
        'outputs_store_ref': outputs_store_ref,
        'task_executor_ref': task_executor_ref,
    }],
    'invocation_adapter': create_invocation_adapter(),
    'logger': _logger,
    'server_url': f'http://127.0.0.1:{PORT}',
})

# ── Card store seeding ─────────────────────────────────────────────────────────

_existing = runtime.card_store.get({})
_is_empty = _existing.get('status') != 'success' or not _existing.get('data', {}).get('cards')
if _is_empty:
    runtime.card_store.set({'body': INLINE_CARDS})
    print(f'[portfolio-tracker-server.py] seeded {len(INLINE_CARDS)} cards')
else:
    print(f'[portfolio-tracker-server.py] card store already populated '
          f'({len(_existing["data"]["cards"])} cards)')

# ── HTTP server ────────────────────────────────────────────────────────────────

CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type,x-file-name',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
}


class ParsedUrl:
    def __init__(self, url_str: str):
        parsed = urlparse(url_str)
        self.path = parsed.path
        qs = parse_qs(parsed.query, keep_blank_values=True)
        self.query_params = {k: v[0] for k, v in qs.items()}


class RequestAdapter:
    def __init__(self, handler: http.server.BaseHTTPRequestHandler, body: bytes):
        self._handler = handler
        self._body = body

    @property
    def method(self) -> str:
        return self._handler.command

    @property
    def path(self) -> str:
        return urlparse(self._handler.path).path

    @property
    def headers(self) -> Dict[str, str]:
        return {k.lower(): v for k, v in self._handler.headers.items()}

    @property
    def query_params(self) -> Dict[str, str]:
        qs = parse_qs(urlparse(self._handler.path).query, keep_blank_values=True)
        return {k: v[0] for k, v in qs.items()}

    def read_body(self) -> bytes:
        return self._body


class ResponseAdapter:
    """Adapts http.server to the py-server-runtime response protocol.

    For SSE connections the caller must invoke wait_for_close() after
    handle_runtime_api returns so that the thread stays alive (and the
    TCP connection stays open) until the client disconnects.
    Writes from other threads (notification broadcasts) are protected by
    a per-connection lock.
    """

    def __init__(self, handler: http.server.BaseHTTPRequestHandler):
        self._handler = handler
        self._headers_sent = False
        self._status = 200
        self._headers: Dict[str, str] = {}
        self._is_sse = False
        self._write_lock = threading.Lock()

    def write_head(self, status_code: int, headers: Optional[Dict[str, str]] = None) -> None:
        self._status = status_code
        if headers:
            self._headers.update(headers)
        ct = (headers or {}).get('Content-Type', '')
        if ct.startswith('text/event-stream'):
            self._is_sse = True

    def _send_headers_locked(self) -> None:
        if self._headers_sent:
            return
        self._headers_sent = True
        self._handler.send_response(self._status)
        for k, v in self._headers.items():
            self._handler.send_header(k, str(v))
        self._handler.end_headers()

    def write(self, data) -> None:
        with self._write_lock:
            self._send_headers_locked()
            raw = data.encode('utf-8') if isinstance(data, str) else data
            try:
                self._handler.wfile.write(raw)
                self._handler.wfile.flush()
            except Exception:
                pass  # Client disconnected; broadcast will remove us from sse_clients

    def end(self, data=None) -> None:
        with self._write_lock:
            self._send_headers_locked()
            if data:
                raw = data.encode('utf-8') if isinstance(data, str) else data
                try:
                    self._handler.wfile.write(raw)
                    self._handler.wfile.flush()
                except Exception:
                    pass

    def wait_for_close(self) -> None:
        """Block the SSE-connection thread until the client disconnects."""
        conn = self._handler.connection
        try:
            while True:
                try:
                    r, _, e = select.select([conn], [], [conn], 1.0)
                except Exception:
                    break
                if e:
                    break
                if r:
                    try:
                        data = conn.recv(16)
                        if not data:
                            break
                    except Exception:
                        break
        except Exception:
            pass


class _ThreadedServer(http.server.ThreadingHTTPServer):
    daemon_threads = True


class _Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # type: ignore[override]
        pass  # suppress per-request access log

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        for k, v in CORS_HEADERS.items():
            self.send_header(k, v)
        self.end_headers()

    def do_GET(self) -> None:
        self._handle()

    def do_POST(self) -> None:
        self._handle()

    def do_PATCH(self) -> None:
        self._handle()

    def _handle(self) -> None:
        content_length = int(self.headers.get('content-length') or 0)
        body = self.rfile.read(content_length) if content_length > 0 else b''

        req = RequestAdapter(self, body)
        res = ResponseAdapter(self)
        parsed = ParsedUrl(self.path)

        try:
            handled = runtime.handle_runtime_api(req, res, parsed)
        except Exception as exc:
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(exc)}).encode('utf-8'))
            return

        if not handled:
            self.send_response(404)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"error":"Not found"}')
            return

        if res._is_sse:
            # Keep the thread alive (and the TCP connection open) until the client
            # disconnects.  Other threads write SSE frames via res.write() under the
            # per-connection lock above.
            res.wait_for_close()


def main() -> None:
    server = _ThreadedServer(('127.0.0.1', PORT), _Handler)
    print(f'[portfolio-tracker-server.py] listening on http://127.0.0.1:{PORT}')
    print(f'[portfolio-tracker-server.py] runtime dir: {RUNTIME_DIR}')
    print('[portfolio-tracker-server.py] endpoints:')
    print('  GET  /api/board/init-board')
    print('  GET  /api/board/sse')
    print('  GET  /api/board/board-status')
    print('  PATCH /api/board/cards/:id')
    print('  POST  /api/board/cards/:id/actions')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n[portfolio-tracker-server.py] shutting down')
        server.shutdown()


if __name__ == '__main__':
    main()
