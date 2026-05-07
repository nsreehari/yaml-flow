"""Vendored third-party packages for offline/standalone deployment."""
from __future__ import annotations

import os
import sys

# Add vendor directory to sys.path so vendored packages can be imported
_vendor_dir = os.path.dirname(os.path.abspath(__file__))
if _vendor_dir not in sys.path:
    sys.path.insert(0, _vendor_dir)
