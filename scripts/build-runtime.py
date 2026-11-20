"""Build only the client files declared in the release manifest."""
import hashlib
import io
import json
import re
import sys
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


ROOT = Path(__file__).resolve().parents[1]
CLIENT = ROOT / 'client'
PREFIX = 'mubai-media-mcp/'
FILES = json.loads((ROOT / 'release/files.json').read_text(encoding='utf-8'))
OUTPUT = ROOT / 'dist/runtime'
VERSION = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']


def build():
    package = json.loads((CLIENT / 'package.json').read_text(encoding='utf-8'))
    lock = json.loads((CLIENT / 'package-lock.json').read_text(encoding='utf-8'))
    if not re.fullmatch(r'(?:0|[1-9]\d{0,5})(?:\.(?:0|[1-9]\d{0,5})){2}', VERSION):
        raise ValueError('Invalid release version')
    if {package['version'], lock['version'], lock['packages']['']['version']} != {VERSION}:
        raise ValueError('Wrapper, client and lockfile versions differ')
    if FILES != sorted(set(FILES)):
        raise ValueError('Release files must be unique and sorted')
    buffer = io.BytesIO()
    with ZipFile(buffer, 'w', compression=ZIP_DEFLATED, compresslevel=9) as archive:
        for relative in FILES:
            source = CLIENT / relative
            if not source.is_relative_to(CLIENT) or not source.is_file() or source.resolve() != source:
                raise ValueError(f'Invalid release file: {relative}')
            name = PREFIX + relative
            entry = ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            entry.compress_type = ZIP_DEFLATED
            archive.writestr(entry, source.read_bytes(), compresslevel=9)
    content = buffer.getvalue()
    manifest = {
        'version': VERSION,
        'filename': f'mubai-media-mcp-{VERSION}.zip',
        'sha256': hashlib.sha256(content).hexdigest(),
        'bytes': len(content),
        'requires_node': package['engines']['node'],
        'transport': 'stdio',
        'files': [PREFIX + relative for relative in FILES],
    }
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / 'runtime.zip').write_bytes(content)
    (OUTPUT / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    print(manifest['sha256'], manifest['filename'], file=sys.stderr)


if __name__ == '__main__':
    build()
