"""Encode game-decoded audio atomically as FLAC 8, MP3 or AAC-LC."""
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


def encode_audio(wav, target, encoding):
    """Encode game-decoded PCM, validate the result, then atomically publish it."""
    if encoding.codec == 'flac':
        return encode_flac(wav, target)
    import io
    import json
    import wave
    target = Path(target)
    with wave.open(io.BytesIO(wav) if isinstance(wav, bytes) else str(wav)) as source:
        channels, rate = source.getnchannels(), source.getframerate()
        duration = source.getnframes() / rate
    if duration <= 0:
        raise ValueError('Decoded audio has no samples')
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=encoding.codec + '-', suffix='.tmp', dir=target.parent)
    os.close(fd)
    try:
        options = ['-c:a', 'libmp3lame', '-f', 'mp3'] if encoding.codec == 'mp3' else [
            '-c:a', 'aac', '-profile:a', 'aac_low', '-movflags', '+faststart',
            '-movie_timescale', str(rate), '-f', 'ipod']
        command = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
                   '-i', 'pipe:0' if isinstance(wav, bytes) else str(wav),
                   '-map', '0:a:0', '-map_metadata', '-1', '-vn',
                   '-ar', str(rate), '-ac', str(channels),
                   *options, '-b:a', str(encoding.bitrate_kbps) + 'k', name]
        result = subprocess.run(command, input=wav if isinstance(wav, bytes) else None,
                                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        if result.returncode:
            raise RuntimeError('Audio encoding failed: ' + target.name)
        probe = subprocess.run(['ffprobe', '-v', 'error', '-show_streams', '-of', 'json', name],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if probe.returncode:
            raise RuntimeError('Audio verification failed: ' + target.name)
        streams = json.loads(probe.stdout).get('streams', [])
        if len(streams) != 1 or streams[0].get('codec_name') != encoding.codec or \
                streams[0].get('channels') != channels or int(streams[0].get('sample_rate', 0)) != rate or \
                abs(float(streams[0].get('duration', 0)) - duration) > max(.15, 2304 / rate):
            raise RuntimeError('Encoded audio format/duration mismatch: ' + target.name)
        check = subprocess.run(['ffmpeg', '-v', 'error', '-xerror', '-nostdin', '-i', name, '-f', 'null', '-'],
                               stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        if check.returncode:
            raise RuntimeError('Encoded audio cannot be decoded: ' + target.name)
        os.chmod(name, 0o644)
        os.replace(name, target)
    finally:
        Path(name).unlink(missing_ok=True)
    return target
