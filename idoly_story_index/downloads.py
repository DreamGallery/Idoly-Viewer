"""Bounded retries for transient resource transfers; never log URLs or headers."""
import hashlib
import os
from pathlib import Path
import tempfile
import time

import requests

RETRY_DELAYS = (2, 4, 8)
RETRY_STATUSES = {408, 429, 500, 502, 503, 504}


class TransientTransferError(RuntimeError):
    def __init__(self, reason, retry_after=0):
        super().__init__(reason)
        self.retry_after = retry_after


def retry_transfer(operation, label):
    for attempt in range(len(RETRY_DELAYS) + 1):
        delay_hint = 0
        try:
            return operation()
        except requests.exceptions.SSLError:
            raise RuntimeError(f'Download failed: {label} (TLS validation error)') from None
        except (requests.Timeout, requests.ConnectionError,
                requests.exceptions.ChunkedEncodingError,
                requests.exceptions.ContentDecodingError):
            reason = 'network timeout or interrupted transfer'
        except TransientTransferError as error:
            reason = str(error)
            delay_hint = error.retry_after
        except requests.RequestException:
            raise RuntimeError(f'Download failed: {label} (request error)') from None
        if attempt == len(RETRY_DELAYS):
            raise RuntimeError(f'Download failed after 4 attempts (3 retries): {label} ({reason})') from None
        delay = max(RETRY_DELAYS[attempt], delay_hint)
        print(f'Download retry {attempt + 1}/3 in {delay}s: {label} ({reason})', flush=True)
        time.sleep(delay)


def check_status(response, label):
    status = response.status_code
    if status in RETRY_STATUSES:
        try:
            delay = min(60, max(0, int(response.headers.get('Retry-After', '0'))))
        except (ValueError, TypeError):
            delay = 0
        raise TransientTransferError(f'HTTP {status}', delay)
    if status != 200:
        raise RuntimeError(f'Download failed: {label} (HTTP {status})')


def download_bytes(url, label, *, headers=None):
    def transfer():
        with requests.get(url, headers=headers, timeout=(15, 90)) as response:
            check_status(response, label)
            return response.content
    return retry_transfer(transfer, label)


def download_file(url, destination, label, *, size, md5, on_download=None):
    """Retry the whole transfer, committing only a size/hash-verified file."""
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)

    def transfer():
        fd, temporary = tempfile.mkstemp(prefix='download-', suffix='.tmp', dir=destination.parent)
        try:
            checksum = hashlib.md5()
            length = 0
            with os.fdopen(fd, 'wb') as output:
                with requests.get(url, stream=True, timeout=(15, 90)) as response:
                    check_status(response, label)
                    for chunk in response.iter_content(1024 * 1024):
                        if on_download is not None:
                            on_download(len(chunk))
                        length += len(chunk)
                        if length > size:
                            raise TransientTransferError('resource size mismatch')
                        checksum.update(chunk)
                        output.write(chunk)
            if length != size or checksum.hexdigest() != md5:
                raise TransientTransferError('resource size/checksum mismatch')
            os.chmod(temporary, 0o644)
            os.replace(temporary, destination)
        finally:
            Path(temporary).unlink(missing_ok=True)
        return destination

    return retry_transfer(transfer, label)
