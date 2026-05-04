from __future__ import annotations

import base64
import json
import os
import random
import shutil
import sys
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

from .board_live_cards_adapters import (
    ExecutionRef,
    FileAtomicRelayLock,
    FsBlobStorage,
    FsJournalStorageAdapter,
    FsKvStorage,
    PythonCommandExecutor,
    compute_stable_json_hash,
    dispatch_execution,
)


class QuickJsUnavailableError(RuntimeError):
    pass


class QuickJsBoardHost:
    """
    Minimal JS host bridge for Python adapters.

    JS side contract:
      globalThis.__pyHostCall(jsonString) -> jsonString

    Request shape:
      {"op": "kv.read", "scope": "...", "namespace": "...", ...}
    Response shape:
      {"ok": true, "data": ...} | {"ok": false, "error": "..."}
    """

    def __init__(self, bundle_path: str) -> None:
        self._locks: Dict[str, Any] = {}
        self._bundle_path = bundle_path
        self._repo_root = Path(__file__).resolve().parent.parent.parent

    def _node_board_cli_path(self) -> Path:
        return self._repo_root / "board-live-cards-cli.js"

    def _make_board_temp_file_path(self, board_dir: str, label: str, ext: str = ".json") -> str:
        tmp_dir = Path(board_dir) / ".tmp"
        tmp_dir.mkdir(parents=True, exist_ok=True)
        suffix = f"{int(uuid.uuid1().time_low)}-{random.randint(0, 0xFFFFFF):06x}"
        return str(tmp_dir / f"{label}-{suffix}{ext}")

    def _ok(self, data: Any = None) -> str:
        return json.dumps({"ok": True, "data": data}, ensure_ascii=True)

    def _err(self, message: str) -> str:
        return json.dumps({"ok": False, "error": message}, ensure_ascii=True)

    def _kv(self, scope: str, namespace: str) -> FsKvStorage:
        if namespace:
            return FsKvStorage(f"{scope}/.{namespace}")
        return FsKvStorage(scope)

    def _blob(self, scope: str, namespace: str) -> FsBlobStorage:
        return FsBlobStorage(f"{scope}/{namespace}" if namespace else scope)

    def host_call(self, req_json: str) -> str:
        try:
            req = json.loads(req_json)
            op = req.get("op")
            if not isinstance(op, str):
                return self._err("Invalid request: missing op")

            if op == "kv.read":
                kv = self._kv(str(req["scope"]), str(req["namespace"]))
                return self._ok(kv.read(str(req["key"])))

            if op == "kv.write":
                kv = self._kv(str(req["scope"]), str(req["namespace"]))
                kv.write(str(req["key"]), req.get("value"))
                return self._ok(True)

            if op == "kv.delete":
                kv = self._kv(str(req["scope"]), str(req["namespace"]))
                kv.delete(str(req["key"]))
                return self._ok(True)

            if op == "kv.list":
                kv = self._kv(str(req["scope"]), str(req["namespace"]))
                return self._ok(kv.list_keys(req.get("prefix")))

            if op == "blob.read":
                blob = self._blob(str(req["scope"]), str(req.get("namespace", "")))
                return self._ok(blob.read(str(req["key"])))

            if op == "blob.write":
                blob = self._blob(str(req["scope"]), str(req.get("namespace", "")))
                blob.write(str(req["key"]), str(req.get("content", "")))
                return self._ok(True)

            if op == "blob.exists":
                blob = self._blob(str(req["scope"]), str(req.get("namespace", "")))
                return self._ok(blob.exists(str(req["key"])))

            if op == "blob.remove":
                blob = self._blob(str(req["scope"]), str(req.get("namespace", "")))
                blob.remove(str(req["key"]))
                return self._ok(True)

            if op == "blob.resolveRef":
                ref = req.get("ref")
                if not isinstance(ref, dict):
                    return self._err("blob.resolveRef requires ref object")
                kind = ref.get("kind")
                value = ref.get("value")
                if not isinstance(kind, str) or not isinstance(value, str):
                    return self._err("blob.resolveRef requires ref.kind/ref.value strings")
                if kind == "fs-path":
                    path = Path(value)
                    if not path.exists():
                        return self._ok(None)
                    return self._ok(path.read_text(encoding="utf-8"))
                blob = self._blob(str(req["scope"]), "")
                return self._ok(blob.read(value))

            if op == "journal.readAllEntries":
                journal = FsJournalStorageAdapter(str(req["scope"]))
                return self._ok(journal.read_all_entries())

            if op == "journal.appendEntry":
                journal = FsJournalStorageAdapter(str(req["scope"]))
                entry = req.get("entry")
                if not isinstance(entry, dict):
                    return self._err("journal.appendEntry requires object entry")
                journal.append_entry(entry)
                return self._ok(True)

            if op == "journal.generateId":
                journal = FsJournalStorageAdapter(str(req["scope"]))
                return self._ok(journal.generate_id())

            if op == "lock.tryAcquire":
                lock = FileAtomicRelayLock(f"{req['scope']}/.board.lock")
                release = lock.try_acquire()
                if not release:
                    return self._ok(None)
                token = uuid.uuid4().hex
                self._locks[token] = release
                return self._ok(token)

            if op == "lock.release":
                token = req.get("token")
                if not isinstance(token, str):
                    return self._err("lock.release requires token")
                releaser = self._locks.pop(token, None)
                if releaser:
                    releaser()
                return self._ok(True)

            if op == "execution.dispatch":
                ref_raw = req.get("ref")
                args = req.get("args")
                scope = req.get("scope")
                if not isinstance(ref_raw, dict):
                    return self._err("execution.dispatch requires ref object")
                if not isinstance(args, dict):
                    return self._err("execution.dispatch requires args object")
                if not isinstance(scope, str) or not scope:
                    return self._err("execution.dispatch requires scope")
                ref = ExecutionRef(
                    meta=ref_raw.get("meta"),
                    howToRun=str(ref_raw["howToRun"]),
                    whatToRun=str(ref_raw["whatToRun"]),
                    argsMassaging=ref_raw.get("argsMassaging"),
                    extra=ref_raw.get("extra"),
                )
                label = "source"
                source_def = args.get("source_def")
                if isinstance(source_def, dict):
                    bind_to = source_def.get("bindTo")
                    if isinstance(bind_to, str) and bind_to:
                        label = bind_to
                in_file = self._make_board_temp_file_path(scope, f"exec-in-{label}")
                out_file = self._make_board_temp_file_path(scope, f"exec-out-{label}")
                err_file = self._make_board_temp_file_path(scope, f"exec-err-{label}", ".txt")
                Path(in_file).write_text(json.dumps(args, indent=2, ensure_ascii=True), encoding="utf-8")
                dispatch_args = {
                    "subcommand": "run-source-fetch",
                    "inRef": f"::fs-path::{in_file}",
                    "outRef": f"::fs-path::{out_file}",
                    "errRef": f"::fs-path::{err_file}",
                }
                return self._ok(dispatch_execution(ref, dispatch_args, cwd=req.get("cwd"), detached=True))

            if op == "hash.computeStableJson":
                return self._ok(compute_stable_json_hash(req.get("value")))

            if op == "id.gen":
                return self._ok(uuid.uuid4().hex)

            if op == "warn":
                msg = req.get("msg")
                if isinstance(msg, str):
                    print(f"[pycli-warn] {msg}")
                return self._ok(True)

            if op == "base64.encode":
                value = req.get("value")
                if not isinstance(value, str):
                    return self._err("base64.encode requires string value")
                raw = value.encode("latin-1")
                return self._ok(base64.b64encode(raw).decode("ascii"))

            if op == "base64.decode":
                value = req.get("value")
                if not isinstance(value, str):
                    return self._err("base64.decode requires string value")
                pad = "=" * ((4 - (len(value) % 4)) % 4)
                raw = base64.b64decode(value + pad)
                return self._ok(raw.decode("latin-1"))

            if op == "board.requestProcessAccumulated":
                scope = req.get("scope")
                if not isinstance(scope, str) or not scope:
                    return self._err("board.requestProcessAccumulated requires scope")
                node = shutil.which("node")
                if not node:
                    return self._err("node not found on PATH")
                board_cli = self._node_board_cli_path()
                if not board_cli.exists():
                    return self._err(f"board CLI not found: {board_cli}")
                base_ref = f"::fs-path::{scope}"
                executor = PythonCommandExecutor()
                executor.spawn_detached(
                    node,
                    [
                        str(board_cli),
                        "process-accumulated-events",
                        "--base-ref",
                        base_ref,
                    ],
                    cwd=str(self._repo_root),
                )
                return self._ok(True)

            if op == "self.ref":
                board_cli = self._node_board_cli_path()
                if board_cli.exists():
                    return self._ok(
                        {
                            "meta": "board-live-cards",
                            "howToRun": "local-node",
                            "whatToRun": f"::fs-path::{str(board_cli)}",
                        }
                    )
                return self._ok(
                    {
                        "meta": "board-live-cards",
                        "howToRun": "built-in",
                        "whatToRun": "::built-in::board-live-cards",
                    }
                )

            return self._err(f"Unsupported op: {op}")
        except Exception as e:
            return self._err(str(e))


def _load_quickjs_module():
    try:
        import quickjs  # type: ignore

        return quickjs
    except Exception as e:
        raise QuickJsUnavailableError(
            "quickjs package is unavailable in this environment. Use Python 3.12 and run: python -m pip install -r pycli/requirements.txt"
        ) from e


def invoke_js_bundle_function(
    bundle_path: str,
    function_name: str,
    function_arg: Dict[str, Any],
    bootstrap_js: Optional[str] = None,
) -> Any:
    quickjs = _load_quickjs_module()
    host = QuickJsBoardHost(bundle_path)
    ctx = quickjs.Context()

    ctx.add_callable("__pyHostCall", host.host_call)

    ctx.eval(
        """
globalThis.__hostCall = function(payload) {
  const raw = __pyHostCall(JSON.stringify(payload));
  const res = JSON.parse(raw);
  if (!res.ok) {
    throw new Error(res.error || 'Unknown host error');
  }
  return res.data;
};

if (typeof globalThis.btoa !== 'function') {
    globalThis.btoa = function(input) {
        return globalThis.__hostCall({ op: 'base64.encode', value: String(input) });
    };
}

if (typeof globalThis.atob !== 'function') {
    globalThis.atob = function(input) {
        return globalThis.__hostCall({ op: 'base64.decode', value: String(input) });
    };
}

if (typeof globalThis.TextEncoder !== 'function') {
    globalThis.TextEncoder = class TextEncoder {
        encode(input) {
            const s = String(input);
            const encoded = encodeURIComponent(s);
            const bytes = [];
            for (let i = 0; i < encoded.length; i++) {
                const ch = encoded.charAt(i);
                if (ch === '%') {
                    bytes.push(parseInt(encoded.slice(i + 1, i + 3), 16));
                    i += 2;
                } else {
                    bytes.push(ch.charCodeAt(0));
                }
            }
            return Uint8Array.from(bytes);
        }
    };
}

if (typeof globalThis.TextDecoder !== 'function') {
    globalThis.TextDecoder = class TextDecoder {
        decode(input) {
            const bytes = input instanceof Uint8Array ? input : Uint8Array.from(input || []);
            let encoded = '';
            for (let i = 0; i < bytes.length; i++) {
                const b = bytes[i];
                if (b >= 0x20 && b <= 0x7e && b !== 0x25) {
                    encoded += String.fromCharCode(b);
                } else {
                    encoded += '%' + b.toString(16).toUpperCase().padStart(2, '0');
                }
            }
            return decodeURIComponent(encoded);
        }
    };
}
"""
    )

    if bootstrap_js:
        ctx.eval(bootstrap_js)

    bundle_code = Path(bundle_path).read_text(encoding="utf-8")
    ctx.eval(bundle_code)

    arg_json = json.dumps(function_arg, ensure_ascii=True)
    fn_name_json = json.dumps(function_name)
    wrapped_arg_json = json.dumps(arg_json)

    ctx.eval(
        f"""
globalThis.__pyInvokeDone = false;
globalThis.__pyInvokeValue = null;
globalThis.__pyInvokeError = null;
(function() {{
    try {{
        const _fn = globalThis[{fn_name_json}];
        const _arg = JSON.parse({wrapped_arg_json});
        const _ret = _fn(_arg);
        if (_ret && typeof _ret.then === 'function') {{
            _ret.then((v) => {{
                globalThis.__pyInvokeValue = JSON.stringify(v);
                globalThis.__pyInvokeDone = true;
            }}).catch((e) => {{
                globalThis.__pyInvokeError = String(e && e.message ? e.message : e);
                globalThis.__pyInvokeDone = true;
            }});
        }} else {{
            globalThis.__pyInvokeValue = JSON.stringify(_ret);
            globalThis.__pyInvokeDone = true;
        }}
    }} catch (e) {{
        globalThis.__pyInvokeError = String(e && e.message ? e.message : e);
        globalThis.__pyInvokeDone = true;
    }}
}})();
"""
    )

    # Always pump pending jobs, even if the top-level function returned synchronously.
    # Commands like upsertCard trigger background async work via `void drain()`.
    # In QuickJS, those promise jobs run only when execute_pending_job() is pumped.
    idle_spins = 0
    for _ in range(50000):
        ran = ctx.execute_pending_job()
        idle_spins = 0 if ran else idle_spins + 1
        done = ctx.eval("globalThis.__pyInvokeDone")
        if done and idle_spins >= 200:
            break

    done = ctx.eval("globalThis.__pyInvokeDone")
    if not done:
        raise RuntimeError("QuickJS invocation timed out waiting for async completion")

    err = ctx.eval("globalThis.__pyInvokeError")
    if err:
        raise RuntimeError(str(err))

    return ctx.eval("globalThis.__pyInvokeValue")
