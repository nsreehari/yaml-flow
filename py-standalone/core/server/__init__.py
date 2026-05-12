"""
py-server-runtime — Python port of src/server-runtime/

Platform-free board server runtime.

NOTE: The types file is named runtime_types.py (not types.py) to avoid
      conflict with Python's stdlib types module.
      This mirrors types.ts → runtime_types.py.
"""

from .index import create_single_board_server_runtime, create_multi_board_server_runtime

__all__ = ["create_single_board_server_runtime", "create_multi_board_server_runtime"]
