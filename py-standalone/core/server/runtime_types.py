"""
py-server-runtime/types.py

Platform-free adapter interfaces for the board server runtime.

Port of src/server-runtime/types.ts

The runtime (index.py) imports ONLY this file and board-live-cards-public
for its dependencies — no os, subprocess, socket, etc.

Hosts (py-demo-server, Azure Function, Firebase Function) provide implementations
of these interfaces when constructing the runtime.
"""
from __future__ import annotations

from typing import (
    Any,
    Awaitable,
    Callable,
    Dict,
    List,
    Optional,
    Protocol,
    Sequence,
    runtime_checkable,
)


# ============================================================================
# KindValueRef — backend-neutral typed reference
# ============================================================================

class KindValueRef:
    """Typed reference dict: {"kind": str, "value": str}"""
    pass  # duck-typed dict in practice


# ============================================================================
# ExecutionRef — portable descriptor for invoking any executable target
# ============================================================================

class ExecutionRef:
    """Dict: {"howToRun": str, "whatToRun": str, "meta": str|None, ...}"""
    pass  # duck-typed dict in practice


# ============================================================================
# Storage protocols (duck-typed)
# ============================================================================

@runtime_checkable
class KVStorage(Protocol):
    def read(self, key: str) -> Any: ...
    def write(self, key: str, value: Any) -> None: ...
    def delete(self, key: str) -> None: ...
    def list_keys(self, prefix: str = "") -> List[str]: ...


@runtime_checkable
class BlobStorage(Protocol):
    def read(self, key: str) -> Optional[str]: ...
    def write(self, key: str, content: str) -> None: ...
    def exists(self, key: str) -> bool: ...
    def remove(self, key: str) -> None: ...


# ============================================================================
# CardSourceAdapter — enumerates card JSON files for bootstrap
# ============================================================================

@runtime_checkable
class CardSourceAdapter(Protocol):
    """
    List all card definitions from the card source.
    Returns parsed card objects (each must have an `id: str` field).
    """
    def list_cards(self) -> List[Dict[str, Any]]: ...


# ============================================================================
# InvocationAdapter — dispatches execution requests
# ============================================================================

@runtime_checkable
class InvocationAdapter(Protocol):
    """
    Fire-and-forget invocation of an ExecutionRef with args.
    """
    def invoke(self, ref: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """Returns {"dispatched": bool, "error"?: str}"""
        ...

    def describe(self, ref: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Optional synchronous describe — asks target to identify itself."""
        ...


# ============================================================================
# NotificationTransport — cross-process event channel
# ============================================================================

@runtime_checkable
class NotificationTransport(Protocol):
    """
    Start listening for events on a notification endpoint identified by a kind-ref.
    """
    def subscribe(self, ref: Dict[str, str], on_event: Callable[[Any], None]) -> Callable[[], None]:
        """Returns a teardown function."""
        ...


# ============================================================================
# DescribeEnvelope — returned by executors in response to 'describe'
# ============================================================================

class DescribeEnvelope:
    """
    name: str
    kind: 'task-executor' | 'chat-handler' | 'inference-adapter'
    protocolVersion: str
    supports: list[str] | None
    """
    pass  # duck-typed dict in practice


# ============================================================================
# Logger — minimal structured logging interface
# ============================================================================

@runtime_checkable
class RuntimeLogger(Protocol):
    def info(self, msg: str, *args: Any) -> None: ...
    def warn(self, msg: str, *args: Any) -> None: ...
    def error(self, msg: str, *args: Any) -> None: ...


# ============================================================================
# BoardPlatformAdapter — injected platform services
# ============================================================================

@runtime_checkable
class BoardPlatformAdapter(Protocol):
    def kv_storage(self, namespace: str) -> Any: ...
    def kv_storage_for_ref(self, ref: str) -> Any: ...
    def blob_storage(self, namespace: str) -> Any: ...
    def journal_adapter(self) -> Any: ...
    @property
    def lock(self) -> Any: ...
    @property
    def self_ref(self) -> Dict[str, Any]: ...
    def dispatch_execution(self, ref: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]: ...
    def resolve_blob(self, ref: Dict[str, str]) -> str: ...
    def hash_fn(self, value: Any) -> str: ...
    def gen_id(self) -> str: ...
    def request_process_accumulated(self) -> None: ...
    def publish_board_change_notifications(self, notifications: List[Any]) -> None: ...


# ============================================================================
# BoardContextConfig — per-board-layer configuration
# ============================================================================

class BoardContextConfig:
    """
    Dict with keys:
      label: str
      board_adapter: BoardPlatformAdapter
      artifacts_adapter: Optional[BoardPlatformAdapter]
      base_ref: dict  # {"kind": str, "value": str}
      card_store_ref: str
      outputs_store_ref: str
      card_source: CardSourceAdapter
      notify_ref: Optional[dict]  # {"kind": str, "value": str}
      task_executor_ref: Optional[dict]  # ExecutionRef
      chat_handler_ref: Optional[dict]  # ExecutionRef
      inference_adapter_ref: Optional[dict]  # ExecutionRef
    """
    pass  # duck-typed dict in practice


# ============================================================================
# SingleBoardRuntimeOptions — options for create_single_board_server_runtime
# ============================================================================

class SingleBoardRuntimeOptions:
    """
    Dict with keys:
      api_base_path: str (default "/api/board")
      cors_headers: Optional[dict]
      board_id: str
      boards: List[BoardContextConfig dict]
      invocation_adapter: InvocationAdapter
      notification_transport: Optional[NotificationTransport]
      logger: Optional[RuntimeLogger]
      server_url: Optional[str]
      execution_extra: Optional[dict]
    """
    pass  # duck-typed dict in practice


# ============================================================================
# MultiBoardRuntimeOptions — options for create_multi_board_server_runtime
# ============================================================================

class MultiBoardRuntimeOptions:
    """
    Dict with keys:
      api_base_path: str (default "/api/boards")
      cors_headers: Optional[dict]
      server_meta_store: object with get_text(key)/put_text(key, text)
      board_runtime_factory: Callable[[str, dict], SingleBoardRuntime]
      logger: Optional[RuntimeLogger]
    """
    pass  # duck-typed dict in practice


# ============================================================================
# RuntimeRequest / RuntimeResponse — minimal HTTP-shaped interfaces
# ============================================================================

@runtime_checkable
class RuntimeRequest(Protocol):
    @property
    def method(self) -> str: ...
    @property
    def path(self) -> str: ...
    @property
    def headers(self) -> Dict[str, str]: ...
    @property
    def query_params(self) -> Dict[str, str]: ...
    def read_body(self) -> bytes: ...


@runtime_checkable
class RuntimeResponse(Protocol):
    def write_head(self, status_code: int, headers: Optional[Dict[str, str]] = None) -> None: ...
    def write(self, data: str | bytes) -> None: ...
    def end(self, data: Optional[str | bytes] = None) -> None: ...


# ============================================================================
# SingleBoardRuntime — returned by create_single_board_server_runtime
# ============================================================================

@runtime_checkable
class SingleBoardRuntime(Protocol):
    @property
    def api_base_path(self) -> str: ...
    @property
    def cors_headers(self) -> Dict[str, str]: ...
    def handle_runtime_api(self, req: RuntimeRequest, res: RuntimeResponse, parsed_url: Any) -> bool: ...
    def build_published_runtime_payload(self) -> Any: ...
    def clear_chat_records(self, card_id: str) -> None: ...


# ============================================================================
# MultiBoardRuntime — returned by create_multi_board_server_runtime
# ============================================================================

@runtime_checkable
class MultiBoardRuntime(Protocol):
    @property
    def api_base_path(self) -> str: ...
    @property
    def cors_headers(self) -> Dict[str, str]: ...
    def handle_api(self, req: RuntimeRequest, res: RuntimeResponse, parsed_url: Any) -> bool: ...
    def require_board_service(self, board_id: str) -> Dict[str, Any]: ...
