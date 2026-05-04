from __future__ import annotations

import hashlib
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import quote, unquote
from urllib.request import Request, urlopen


def serialize_ref(kind: str, value: str) -> str:
    return f"::{kind}::{value}"


def parse_ref(ref: str) -> Tuple[str, str]:
    if not ref.startswith("::"):
        raise ValueError(f"Invalid ref format: {ref}")
    inner = ref[2:]
    idx = inner.find("::")
    if idx < 0:
        raise ValueError(f"Invalid ref format: {ref}")
    return inner[:idx], inner[idx + 2 :]


def compute_stable_json_hash(value: Any) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _write_text_atomic(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f"{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
        os.replace(tmp_name, path)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


class FsKvStorage:
    def __init__(self, root_dir: str) -> None:
        self._root = Path(root_dir)
        self._root.mkdir(parents=True, exist_ok=True)

    def _path_for_key(self, key: str) -> Path:
        if not key:
            raise ValueError("KV key must be non-empty")
        parts = [part for part in key.split("/") if part]
        return self._root.joinpath(*parts).with_suffix(".json")

    def read(self, key: str) -> Any | None:
        path = self._path_for_key(key)
        if not path.exists():
            return None
        with path.open("r", encoding="utf-8") as f:
            return json.load(f)

    def write(self, key: str, value: Any) -> None:
        path = self._path_for_key(key)
        _write_text_atomic(path, json.dumps(value, indent=2, ensure_ascii=True))

    def delete(self, key: str) -> None:
        path = self._path_for_key(key)
        if path.exists():
            path.unlink()

    def list_keys(self, prefix: str | None = None) -> List[str]:
        if not self._root.exists():
            return []

        keys: List[str] = []
        for p in sorted(self._root.rglob("*.json")):
            rel = p.relative_to(self._root).as_posix()
            key = rel[:-5] if rel.endswith(".json") else rel
            if prefix and not key.startswith(prefix):
                continue
            keys.append(key)
        return keys


class FsBlobStorage:
    def __init__(self, root_dir: str) -> None:
        self._root = Path(root_dir).resolve()
        self._root.mkdir(parents=True, exist_ok=True)

    def _safe_path(self, key: str) -> Path:
        if not key:
            raise ValueError("Blob key must be non-empty")
        candidate = (self._root / key).resolve()
        if os.path.commonpath([str(candidate), str(self._root)]) != str(self._root):
            raise ValueError(f"Blob key escapes root: {key}")
        return candidate

    def read(self, key: str) -> str | None:
        path = self._safe_path(key)
        if not path.exists():
            return None
        return path.read_text(encoding="utf-8")

    def write(self, key: str, content: str) -> None:
        path = self._safe_path(key)
        _write_text_atomic(path, content)

    def exists(self, key: str) -> bool:
        return self._safe_path(key).exists()

    def remove(self, key: str) -> None:
        path = self._safe_path(key)
        if path.exists():
            path.unlink()


class FsJournalStorageAdapter:
    def __init__(self, board_dir: str) -> None:
        self._path = Path(board_dir) / "board-journal.jsonl"
        self._path.parent.mkdir(parents=True, exist_ok=True)

    def read_all_entries(self) -> List[Dict[str, Any]]:
        if not self._path.exists():
            return []
        entries: List[Dict[str, Any]] = []
        with self._path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                entries.append(json.loads(line))
        return entries

    def append_entry(self, entry: Dict[str, Any]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(entry, ensure_ascii=True, separators=(",", ":")) + "\n"
        with self._path.open("a", encoding="utf-8") as f:
            f.write(line)

    def generate_id(self) -> str:
        return uuid.uuid4().hex


class FileAtomicRelayLock:
    def __init__(self, lock_file_path: str) -> None:
        self._path = Path(lock_file_path)
        self._path.parent.mkdir(parents=True, exist_ok=True)

    def try_acquire(self) -> Callable[[], None] | None:
        try:
            fd = os.open(str(self._path), os.O_CREAT | os.O_EXCL | os.O_RDWR)
        except FileExistsError:
            return None

        released = False

        def release() -> None:
            nonlocal released
            if released:
                return
            released = True
            try:
                os.close(fd)
            finally:
                try:
                    self._path.unlink()
                except OSError:
                    pass

        return release


@dataclass
class ExecutionRef:
    howToRun: str
    whatToRun: str
    meta: Optional[str] = None
    argsMassaging: Optional[Dict[str, Any]] = None
    extra: Optional[Dict[str, Any]] = None


def execution_ref_from_script_path(script_path: str, extra: Optional[Dict[str, Any]] = None) -> ExecutionRef:
    if script_path.lower().endswith((".js", ".mjs")):
        how = "local-node"
    elif script_path.lower().endswith(".py"):
        how = "local-python"
    else:
        how = "local-process"
    return ExecutionRef(
        meta="task-executor",
        howToRun=how,
        whatToRun=serialize_ref("fs-path", script_path),
        extra=extra,
    )


def serialize_execution_ref(ref: ExecutionRef) -> str:
    return json.dumps(ref.__dict__, ensure_ascii=True)


def parse_execution_ref(s: str) -> ExecutionRef:
    data = json.loads(s)
    if not isinstance(data, dict):
        raise ValueError("ExecutionRef JSON must be an object")
    if not isinstance(data.get("howToRun"), str) or not isinstance(data.get("whatToRun"), str):
        raise ValueError("ExecutionRef missing howToRun/whatToRun")
    return ExecutionRef(
        meta=data.get("meta"),
        howToRun=data["howToRun"],
        whatToRun=data["whatToRun"],
        argsMassaging=data.get("argsMassaging"),
        extra=data.get("extra"),
    )


class PythonCommandExecutor:
    def execute_sync(
        self,
        cmd: str,
        args: List[str],
        timeout: Optional[int] = None,
        cwd: Optional[str] = None,
        env: Optional[Dict[str, str]] = None,
        shell: bool = False,
    ) -> str:
        proc = subprocess.run(
            [cmd, *args],
            cwd=cwd,
            env=env,
            shell=shell,
            capture_output=True,
            text=True,
            timeout=timeout / 1000 if timeout else None,
            check=False,
        )
        if proc.returncode != 0:
            raise RuntimeError(proc.stderr.strip() or f"Command failed with exit code {proc.returncode}")
        return proc.stdout

    def spawn_detached(self, cmd: str, args: List[str], cwd: Optional[str] = None) -> None:
        kwargs: Dict[str, Any] = {
            "cwd": cwd,
            "stdin": subprocess.DEVNULL,
            "stdout": subprocess.DEVNULL,
            "stderr": subprocess.DEVNULL,
        }
        if os.name == "nt":
            kwargs["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            kwargs["start_new_session"] = True
        subprocess.Popen([cmd, *args], **kwargs)


def _dispatch_execution_impl(ref: ExecutionRef, args: Dict[str, Any], cwd: Optional[str], detached: bool) -> Dict[str, Any]:
    try:
        executor = PythonCommandExecutor()

        def _target_from_ref(ref_value: str) -> str:
            kind, value = parse_ref(ref_value) if ref_value.startswith("::") else ("raw", ref_value)
            if kind in ("fs-path", "raw"):
                return value
            return ref_value

        def _task_executor_argv(payload: Dict[str, Any], extra: Optional[Dict[str, Any]]) -> List[str]:
            subcommand = payload.get("subcommand")
            if not isinstance(subcommand, str) or not subcommand:
                raise ValueError("dispatch_execution: missing args.subcommand")
            argv: List[str] = [subcommand]
            in_ref = payload.get("inRef")
            out_ref = payload.get("outRef")
            err_ref = payload.get("errRef")
            if isinstance(in_ref, str) and in_ref:
                argv.extend(["--in-ref", in_ref])
            if isinstance(out_ref, str) and out_ref:
                argv.extend(["--out-ref", out_ref])
            if isinstance(err_ref, str) and err_ref:
                argv.extend(["--err-ref", err_ref])
            if extra:
                encoded = base64.b64encode(json.dumps(extra, ensure_ascii=True).encode("utf-8")).decode("ascii")
                argv.extend(["--extra", encoded])
            return argv

        if ref.howToRun == "local-node":
            node_cmd = shutil.which("node")
            if not node_cmd:
                return {"dispatched": False, "error": "local-node requested but node executable is unavailable"}
            target = _target_from_ref(ref.whatToRun)
            call_argv = _task_executor_argv(args, ref.extra)
            if detached:
                executor.spawn_detached(node_cmd, [target, *call_argv], cwd=cwd)
            else:
                executor.execute_sync(node_cmd, [target, *call_argv], cwd=cwd)
            return {"dispatched": True}

        if ref.howToRun in ("local-python", "local-process"):
            target = _target_from_ref(ref.whatToRun)
            call_argv = _task_executor_argv(args, ref.extra)
            if ref.howToRun == "local-python":
                cmd = sys.executable
                cmd_args = [target, *call_argv]
            else:
                cmd = target
                cmd_args = call_argv
            if detached:
                executor.spawn_detached(cmd, cmd_args, cwd=cwd)
            else:
                executor.execute_sync(cmd, cmd_args, cwd=cwd)
            return {"dispatched": True}

        if ref.howToRun in ("http:post", "http:get"):
            url = parse_ref(ref.whatToRun)[1] if ref.whatToRun.startswith("::") else ref.whatToRun
            if ref.howToRun == "http:get":
                req = Request(url=url, method="GET")
            else:
                payload_obj: Dict[str, Any] = {
                    "subcommand": args.get("subcommand"),
                }
                for key in ("inRef", "outRef", "errRef"):
                    value = args.get(key)
                    if isinstance(value, str) and value:
                        payload_obj[key] = value
                if ref.extra:
                    payload_obj["extra"] = ref.extra
                payload = json.dumps(payload_obj, ensure_ascii=True).encode("utf-8")
                req = Request(url=url, data=payload, method="POST", headers={"Content-Type": "application/json"})
            with urlopen(req, timeout=20) as resp:
                if resp.status < 200 or resp.status >= 300:
                    return {"dispatched": False, "error": f"HTTP {resp.status}"}
            return {"dispatched": True}

        return {"dispatched": False, "error": f"Unsupported howToRun: {ref.howToRun}"}
    except Exception as e:
        return {"dispatched": False, "error": str(e)}


def dispatch_execution(ref: ExecutionRef, args: Dict[str, Any], cwd: Optional[str] = None, detached: bool = False) -> Dict[str, Any]:
    return _dispatch_execution_impl(ref, args, cwd=cwd, detached=detached)
