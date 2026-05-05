from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any, Callable, Dict


class QuickJsUnavailableError(RuntimeError):
    pass


class QuickJsStepMachineHost:
    def __init__(self, inline_handlers: Dict[str, Callable[..., Any]] | None = None) -> None:
        self._inline_handlers = inline_handlers or {}

    def _ok(self, data: Any = None) -> str:
        return json.dumps({"ok": True, "data": data}, ensure_ascii=True)

    def _err(self, message: str) -> str:
        return json.dumps({"ok": False, "error": message}, ensure_ascii=True)

    @staticmethod
    def _run_path(directory: str, run_id: str) -> Path:
        return Path(directory) / f"{run_id}.run.json"

    @staticmethod
    def _data_path(directory: str, run_id: str) -> Path:
        return Path(directory) / f"{run_id}.data.json"

    @staticmethod
    def _ensure_store_dir(directory: str) -> None:
        Path(directory).mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _read_json(path: Path, default: Any) -> Any:
        if not path.exists():
            return default
        return json.loads(path.read_text(encoding="utf-8"))

    def host_call(self, req_json: str) -> str:
        try:
            req = json.loads(req_json)
            op = req.get("op")
            if not isinstance(op, str):
                return self._err("Invalid request: missing op")

            if op == "step.runCli":
                command = req.get("command")
                cwd = req.get("cwd")
                payload_json = req.get("payloadJson", "")
                if not isinstance(command, str) or not command.strip():
                    return self._err("step.runCli requires non-empty command")
                if not isinstance(cwd, str) or not cwd:
                    return self._err("step.runCli requires cwd")
                if not isinstance(payload_json, str):
                    return self._err("step.runCli payloadJson must be a string")

                try:
                    run_kwargs: Dict[str, Any] = {
                        "cwd": cwd,
                        "shell": True,
                        "input": payload_json,
                        "capture_output": True,
                        "text": True,
                        "check": False,
                    }
                    if os.name == "nt":
                        startupinfo = subprocess.STARTUPINFO()
                        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                        run_kwargs["startupinfo"] = startupinfo
                        run_kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW

                    proc = subprocess.run(
                        command,
                        **run_kwargs,
                    )
                    return self._ok(
                        {
                            "status": proc.returncode,
                            "stdout": proc.stdout or "",
                            "stderr": proc.stderr or "",
                        }
                    )
                except Exception as ex:
                    return self._ok({"status": None, "stdout": "", "stderr": "", "error": str(ex)})

            if op == "step.invokePythonInline":
                handler_name = req.get("handlerName")
                step_name = req.get("stepName")
                run_id = req.get("runId")
                input_obj = req.get("input")

                if not isinstance(handler_name, str) or not handler_name:
                    return self._err("step.invokePythonInline requires handlerName")
                if handler_name not in self._inline_handlers:
                    return self._err(f'Inline Python handler "{handler_name}" not found')

                handler = self._inline_handlers[handler_name]
                try:
                    result = handler(input_obj, {"stepName": step_name, "runId": run_id})
                except TypeError:
                    result = handler(input_obj)

                return self._ok(result)

            if op.startswith("step.store."):
                directory = req.get("directory")
                run_id = req.get("runId")
                if not isinstance(directory, str) or not directory:
                    return self._err("step.store.* requires directory")
                self._ensure_store_dir(directory)

                if op == "step.store.saveRunState":
                    if not isinstance(run_id, str) or not run_id:
                        return self._err("saveRunState requires runId")
                    state = req.get("state")
                    self._run_path(directory, run_id).write_text(json.dumps(state, indent=2, ensure_ascii=True), encoding="utf-8")
                    return self._ok(True)

                if op == "step.store.loadRunState":
                    if not isinstance(run_id, str) or not run_id:
                        return self._err("loadRunState requires runId")
                    state = self._read_json(self._run_path(directory, run_id), None)
                    return self._ok(state)

                if op == "step.store.deleteRunState":
                    if not isinstance(run_id, str) or not run_id:
                        return self._err("deleteRunState requires runId")
                    for p in (self._run_path(directory, run_id), self._data_path(directory, run_id)):
                        if p.exists():
                            p.unlink()
                    return self._ok(True)

                if op == "step.store.setData":
                    if not isinstance(run_id, str) or not run_id:
                        return self._err("setData requires runId")
                    key = req.get("key")
                    if not isinstance(key, str) or not key:
                        return self._err("setData requires key")
                    value = req.get("value")
                    data_path = self._data_path(directory, run_id)
                    all_data = self._read_json(data_path, {})
                    if not isinstance(all_data, dict):
                        all_data = {}
                    all_data[key] = value
                    data_path.write_text(json.dumps(all_data, indent=2, ensure_ascii=True), encoding="utf-8")
                    return self._ok(True)

                if op == "step.store.getData":
                    if not isinstance(run_id, str) or not run_id:
                        return self._err("getData requires runId")
                    key = req.get("key")
                    if not isinstance(key, str) or not key:
                        return self._err("getData requires key")
                    all_data = self._read_json(self._data_path(directory, run_id), {})
                    return self._ok(all_data.get(key) if isinstance(all_data, dict) else None)

                if op == "step.store.getAllData":
                    if not isinstance(run_id, str) or not run_id:
                        return self._err("getAllData requires runId")
                    all_data = self._read_json(self._data_path(directory, run_id), {})
                    if not isinstance(all_data, dict):
                        all_data = {}
                    return self._ok(all_data)

                if op == "step.store.clearData":
                    if not isinstance(run_id, str) or not run_id:
                        return self._err("clearData requires runId")
                    p = self._data_path(directory, run_id)
                    if p.exists():
                        p.unlink()
                    return self._ok(True)

                if op == "step.store.listRuns":
                    run_ids: list[str] = []
                    for p in Path(directory).glob("*.run.json"):
                        name = p.name
                        run_ids.append(name[: -len(".run.json")])
                    return self._ok(run_ids)

                return self._err(f"Unsupported store op: {op}")

            if op == "step.pause.requested":
                pause_file_path = req.get("pauseFilePath")
                if not isinstance(pause_file_path, str) or not pause_file_path:
                    return self._err("step.pause.requested requires pauseFilePath")
                return self._ok(Path(pause_file_path).exists())

            if op == "step.pause.clear":
                pause_file_path = req.get("pauseFilePath")
                if not isinstance(pause_file_path, str) or not pause_file_path:
                    return self._err("step.pause.clear requires pauseFilePath")
                p = Path(pause_file_path)
                if p.exists():
                    p.unlink()
                return self._ok(True)

            if op == "warn":
                msg = req.get("msg")
                if isinstance(msg, str):
                    print(f"[step-machine-pycli warn] {msg}")
                return self._ok(True)

            return self._err(f"Unsupported op: {op}")
        except Exception as ex:
            return self._err(str(ex))


def _load_quickjs_module():
    try:
        import quickjs  # type: ignore

        return quickjs
    except Exception as e:
        raise QuickJsUnavailableError(
            "quickjs package is unavailable in this environment. Use Python 3.12 and run: python -m pip install -r pycli/requirements.txt"
        ) from e


def invoke_step_machine_bundle(
    *,
    bundle_path: str,
    function_name: str,
    function_arg: Dict[str, Any],
    inline_handlers: Dict[str, Callable[..., Any]] | None = None,
) -> Any:
    quickjs = _load_quickjs_module()
    host = QuickJsStepMachineHost(inline_handlers=inline_handlers)
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
"""
    )

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
