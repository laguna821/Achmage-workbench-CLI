#!/usr/bin/env python3
"""Materialize pinned upstream sources plus reviewed Windows source patches."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

REPO = Path(__file__).resolve().parents[1]
INPUTS = REPO / 'third_party/lightpanda-windows'


def run(*args, cwd=None):
    subprocess.run(args, cwd=cwd, check=True, env={**os.environ, 'GIT_TERMINAL_PROMPT': '0'})


def prepare(destination):
    spec = json.loads((INPUTS / 'source.json').read_text())
    destination.mkdir(parents=True, exist_ok=True)
    for name, source in spec['sources'].items():
        patch = INPUTS / source['patch']
        assert hashlib.sha256(patch.read_bytes()).hexdigest() == source['patchSha256'], name
        target = destination / name
        if target.exists():
            raise RuntimeError(f'Refusing to overwrite an existing source checkout: {target}')
        run('git', 'init', str(target))
        run('git', 'config', 'core.autocrlf', 'false', cwd=target)
        run('git', 'remote', 'add', 'origin', source['repository'], cwd=target)
        run('git', 'fetch', '--depth', '1', 'origin', source['commit'], cwd=target)
        run('git', 'checkout', '--detach', 'FETCH_HEAD', cwd=target)
        actual = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=target, text=True).strip()
        assert actual == source['commit'], (name, actual)
        run('git', 'apply', '--check', str(patch), cwd=target)
        run('git', 'apply', '--whitespace=error', str(patch), cwd=target)

    # Keep dependencies local and explicit; never patch the global Zig cache.
    zon = destination / 'browser/build.zig.zon'
    text = zon.read_text()
    for dependency in ('v8',):
        # Upstream dependency entries are indented eight spaces.
        pattern = rf'(?ms)^        \.{dependency} = \.\{{.*?^        \}},'
        text, count = re.subn(pattern, f'        .{dependency} = .{{ .path = "../{dependency}" }},', text)
        assert count == 1, (dependency, count)
    zon.write_text(text, newline='\n')

    # Do not import the contributor's prebuilt modified MSVC library.
    assert not (destination / 'browser/win-port/filtered-libs/msvcrt.lib').exists()
    proof = {**spec, 'recipeSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    (destination / 'source-provenance.json').write_text(json.dumps(proof, indent=2) + '\n')
    print(f'Prepared pinned Windows source in {destination}')


if __name__ == '__main__':
    prepare(Path(sys.argv[1]).resolve())
