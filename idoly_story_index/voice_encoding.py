"""First-start dialogue encoding settings, persisted in the NAS runtime volume."""
from dataclasses import asdict, dataclass
import json
import os
from pathlib import Path
import tempfile


@dataclass(frozen=True)
class VoiceEncoding:
    codec: str = 'flac'
    bitrate_kbps: int | None = None

    def __post_init__(self):
        if self.codec not in ('flac', 'mp3', 'aac'):
            raise ValueError('IDOLY_VOICE_CODEC must be flac, mp3 or aac')
        if self.codec == 'flac':
            if self.bitrate_kbps is not None:
                raise ValueError('FLAC does not use a bitrate setting')
        elif type(self.bitrate_kbps) is not int or self.bitrate_kbps not in (48, 64, 80, 96, 128, 192):
            raise ValueError('IDOLY_VOICE_BITRATE must be 48, 64, 80, 96, 128 or 192 (kbps)')

    @property
    def extension(self):
        return {'flac': '.flac', 'mp3': '.mp3', 'aac': '.m4a'}[self.codec]

    @property
    def label(self):
        return 'FLAC 8' if self.codec == 'flac' else f'{self.codec.upper()} {self.bitrate_kbps} kbps'

    def cache_directory(self, bank_directory):
        # Preserve the existing FLAC cache; lossy outputs never share cache keys.
        return bank_directory if self.codec == 'flac' else bank_directory / f'voice-{self.codec}-{self.bitrate_kbps}'

    def to_dict(self):
        return asdict(self)


def encoding_for_bank(bank, dialogue=VoiceEncoding()):
    return VoiceEncoding() if bank.startswith('sud_music_') else dialogue


def load_voice_encoding(root, env):
    """Called under runtime.update.lock; persist once, then reject accidental changes."""
    path = Path(root) / 'voice-encoding.json'
    codec = env.get('IDOLY_VOICE_CODEC', '').strip().lower()
    bitrate = env.get('IDOLY_VOICE_BITRATE', '').strip()
    saved = None
    if path.exists():
        try:
            data = json.loads(path.read_text())
            if data['schema_version'] != 1 or set(data) != {'schema_version', 'codec', 'bitrate_kbps'}:
                raise ValueError('Unsupported settings')
            saved = VoiceEncoding(data['codec'], data['bitrate_kbps'])
        except (ValueError, KeyError, TypeError) as error:
            raise ValueError('Invalid /runtime/voice-encoding.json; restore the saved encoding settings') from error
    selected_codec = codec or (saved.codec if saved else 'flac')
    selected_bitrate = None
    if selected_codec != 'flac':
        if bitrate and (not bitrate.isascii() or not bitrate.isdecimal()):
            raise ValueError('IDOLY_VOICE_BITRATE must be an integer in kbps, e.g. 96')
        selected_bitrate = int(bitrate) if bitrate else (saved.bitrate_kbps if saved and saved.codec == selected_codec else 96)
    selected = VoiceEncoding(selected_codec, selected_bitrate)
    if saved:
        if selected != saved:
            raise ValueError(f'Voice encoding is locked to {saved.label} in /runtime/voice-encoding.json; '
                             'restore the Compose settings or remove the voice encoding environment overrides')
        return saved
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix='voice-encoding-', suffix='.tmp', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump({'schema_version': 1, **selected.to_dict()}, stream, indent=2)
            stream.write('\n')
        os.chmod(temp, 0o644)
        os.replace(temp, path)
    finally:
        Path(temp).unlink(missing_ok=True)
    print(f'NAS: saved first-start dialogue encoding: {selected.label}', flush=True)
    return selected
