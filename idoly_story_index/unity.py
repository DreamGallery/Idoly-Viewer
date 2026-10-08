"""Shared UnityPy setup for game bundles with stripped version metadata."""
import os
import re
import threading
import warnings


DEFAULT_VERSION = '2022.3.57f1'
_lock = threading.Lock()
_configured_version = None


def load_bundle(data):
    import UnityPy
    from UnityPy.exceptions import UnityVersionFallbackWarning

    version = os.environ.get('IDOLY_UNITY_VERSION', DEFAULT_VERSION).strip()
    if not re.fullmatch(r'[1-9][0-9]*\.[0-9]+\.[0-9]+[abcfpx][0-9]+', version):
        raise ValueError('IDOLY_UNITY_VERSION must be a Unity version such as 2022.3.57f1')
    global _configured_version
    with _lock:
        if _configured_version != version:
            UnityPy.config.FALLBACK_UNITY_VERSION = version
            # These game bundles use 0.0.0. Keep all unrelated warnings/errors;
            # configure once before concurrent loads, including lazy obj.read().
            warnings.filterwarnings('ignore', category=UnityVersionFallbackWarning, module=r'^UnityPy(?:\.|$)')
            print(f'Assets: bundles without Unity version metadata use {version}', flush=True)
            _configured_version = version
    return UnityPy.load(data)
