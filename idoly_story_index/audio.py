"""Encode decoded game audio as verified lossless FLAC level 8."""
import os
from pathlib import Path
import subprocess
import tempfile


def encode_flac(wav, target):
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='flac-', suffix='.tmp', dir=target.parent)
    os.close(fd)
    try:
        source = ['-'] if isinstance(wav, bytes) else [str(wav)]
        result = subprocess.run(['flac', '-8', '--verify', '--silent', '--no-padding',
                                 '--force', '--output-name=' + name, *source],
                                input=wav if isinstance(wav, bytes) else None,
                                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        if result.returncode or Path(name).read_bytes()[:4] != b'fLaC':
            raise RuntimeError('FLAC level-8 encoding/verification failed: ' + target.name)
        os.chmod(name, 0o644)
        os.replace(name, target)
    finally:
        Path(name).unlink(missing_ok=True)
    return target
