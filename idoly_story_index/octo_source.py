"""Fetch the full Octo resource manifest; never calls the game MasterDB API."""
import hashlib
import json
import os
from pathlib import Path
import sys

from .build import ROOT, save
from .downloads import download_bytes


def aes_key(env):
    """Validate the two explicit key formats without logging their values."""
    key_hex = env.get('IDOLY_OCTO_AES_KEY_HEX', '').strip()
    passphrase = env.get('IDOLY_OCTO_AES_PASSPHRASE', '')
    if key_hex and passphrase:
        raise ValueError('Set only one of IDOLY_OCTO_AES_PASSPHRASE and IDOLY_OCTO_AES_KEY_HEX; leave the other empty')
    if not key_hex:
        if not passphrase:
            raise ValueError('Missing IDOLY_OCTO_AES_PASSPHRASE or IDOLY_OCTO_AES_KEY_HEX')
        return hashlib.sha256(passphrase.encode()).digest()
    try:
        key = bytes.fromhex(key_hex)
    except ValueError:
        raise ValueError('IDOLY_OCTO_AES_KEY_HEX must contain hexadecimal bytes; for an original text passphrase, use IDOLY_OCTO_AES_PASSPHRASE and leave IDOLY_OCTO_AES_KEY_HEX empty') from None
    if len(key) not in (16, 24, 32):
        raise ValueError('IDOLY_OCTO_AES_KEY_HEX must decode to 16, 24 or 32 bytes (32, 48 or 64 hex digits)')
    return key


def update_manifest(path, env=os.environ):
    from Crypto.Cipher import AES
    from Crypto.Util.Padding import unpad
    from google.protobuf.json_format import MessageToDict
    sys.path.insert(0, str(ROOT/'vendor/hoshimi/proto'))
    import octodb_pb2
    required = ['URL', 'APP_ID', 'VERSION', 'CLIENT_SECRET_KEY']
    values = {key: env.get('IDOLY_OCTO_'+key, '').strip() for key in required}
    missing = [key for key, value in values.items() if not value]
    if missing:
        raise ValueError('Missing Octo settings: '+', '.join(missing))
    if not values['URL'].startswith('https://') or not values['APP_ID'].isdigit() or not values['VERSION'].isdigit():
        raise ValueError('Invalid Octo API origin, app ID or version')
    key = aes_key(env)
    old = json.loads(path.read_text()) if path.exists() else None

    def fetch(revision):
        url = values['URL'].rstrip('/') + f'/v2/pub/a/{values["APP_ID"]}/v/{values["VERSION"]}/list/{revision}'
        raw = download_bytes(url,'Octo resource manifest',headers={'X-OCTO-KEY': values['CLIENT_SECRET_KEY'],
            'Accept': f'application/x-protobuf,x-octo-app/{values["APP_ID"]}'})
        if len(raw)<32 or (len(raw)-16)%16:
            raise ValueError('Invalid Octo API encrypted response')
        decoded = unpad(AES.new(key,AES.MODE_CBC,raw[:16]).decrypt(raw[16:]),16)
        data = MessageToDict(octodb_pb2.Database.FromString(decoded), use_integers_for_enums=True,
                             always_print_fields_with_no_presence=True)
        if data['revision']<=0 or not data['urlFormat'].startswith('https://'):
            raise ValueError('Invalid Octo manifest')
        return data

    changed = fetch(old['revision'] if old else 0)
    if old and changed['revision'] < old['revision']:
        raise ValueError('Octo revision moved backwards')
    if old and changed['revision'] == old['revision']:
        return old
    full = fetch(0) if old else changed
    if full['revision'] != changed['revision']:
        raise ValueError('Octo changed during update; retry')
    save(path, full)
    return full


def decrypt_bundle(raw, name):
    """IDOLY's resource-name XOR header, adapted from HoshimiToolkit decrypt.py."""
    if raw.startswith(b'UnityFS'):
        return raw
    mask = bytearray(len(name)*2)
    for i, character in enumerate(name.encode('ascii')):
        mask[i*2] = character
        mask[len(mask)-1-i*2] = (~character)&255
    value = 0x9b
    for byte in mask:
        value = (((value&1)<<7)|(value>>1)) ^ byte
    mask = bytes(byte ^ value for byte in mask)
    output = bytearray(raw)
    for i in range(min(256,len(raw))):
        output[i] ^= mask[i%len(mask)]
    return bytes(output)
