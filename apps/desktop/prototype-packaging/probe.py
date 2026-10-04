"""Relocate artifact; remove developer environment; probe native paths and real persistence."""
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

HERE = Path(__file__).resolve().parent
OUT = HERE / '.output'


def audit_native(artifact):
    records = []
    forbidden = []
    magic_numbers = {b'\xcf\xfa\xed\xfe', b'\xfe\xed\xfa\xcf', b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca'}
    for path in artifact.rglob('*'):
        if path.is_symlink():
            if not path.resolve().is_relative_to(artifact.resolve()):
                forbidden.append(f'External symlink: {path.relative_to(artifact)}')
            continue
        if not path.is_file():
            continue
        with path.open('rb') as stream:
            magic = stream.read(4)
        if magic not in magic_numbers:
            continue
        arches = subprocess.check_output(['/usr/bin/lipo', '-archs', str(path)], text=True).strip()
        linkage = subprocess.check_output(['/usr/bin/otool', '-L', str(path)], text=True)
        records.append({'file': str(path.relative_to(artifact)), 'architectures': arches, 'linkage': linkage})
        if 'arm64' not in arches.split():
            forbidden.append(f'No arm64 slice: {path.relative_to(artifact)}')
        for line in linkage.splitlines()[1:]:
            target = line.strip().split(' (')[0]
            if target.startswith('/') and not target.startswith(('/usr/lib/', '/System/Library/')):
                forbidden.append(f'External absolute load path: {target}')
    (OUT / 'native-linkage.json').write_text(json.dumps({'files': records, 'failures': forbidden}, indent=2))
    if forbidden:
        raise RuntimeError('Native closure audit failed: ' + '; '.join(forbidden[:5]))
    return {'mach_o_files_checked': len(records), 'all_have_arm64': True, 'external_absolute_load_paths': []}


def main():
    artifact = OUT / 'dist/outloud-backend-spike'
    if not artifact.is_dir():
        raise SystemExit('No artifact: build.py must succeed first; see .output/*.log')
    OUT.mkdir(exist_ok=True)
    report = {'status': 'failed', 'unvalidated': ['microphone permission/capture', 'real inference',
                'clean-machine isolation', 'signing/notarization', 'model readiness', 'Ollama integration']}
    process = None
    token = secrets.token_hex(32)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with tempfile.TemporaryDirectory(prefix='outloud-packaging-spike-') as temporary:
        scratch = Path(temporary)
        moved = scratch / 'relocated'
        shutil.copytree(artifact, moved, symlinks=True)
        data = scratch / 'user-data'
        data.mkdir()
        home = scratch / 'home'
        home.mkdir()
        env = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': str(home),
               'TMPDIR': str(scratch), 'XDG_CACHE_HOME': str(home / '.cache'),
               'OUTLOUD_DESKTOP_TOKEN': token}
        executable = moved / 'outloud-backend-spike'
        try:
            report['native_linkage_audit'] = audit_native(moved)
            native = subprocess.run([str(executable), '--native-probe'], env=env, cwd=data,
                                    capture_output=True, text=True, timeout=90)
            (OUT / 'native-probe.log').write_text((native.stdout + native.stderr).replace(token, '[REDACTED]')[-20000:])
            if native.returncode:
                raise RuntimeError('Native artifact probe failed; see .output/native-probe.log')
            report['native'] = json.loads(native.stdout)
            # Select a free port, then authenticate readiness to cover a bind race.
            with socket.socket() as reservation:
                reservation.bind(('127.0.0.1', 0))
                port = reservation.getsockname()[1]
            report.update({'port': port, 'cwd_outside_repo': True, 'clean_environment': True})
            base = f'http://127.0.0.1:{port}'

            def request(path, method='GET', body=None, owner=False):
                headers = {'Content-Type': 'application/json'}
                if owner:
                    headers['X-OutLoud-Desktop-Token'] = token
                payload = None if body is None else json.dumps(body).encode()
                with opener.open(urllib.request.Request(base + path, data=payload, method=method,
                                                       headers=headers), timeout=2) as response:
                    return json.load(response)

            def start(log):
                nonlocal process
                process = subprocess.Popen([str(executable), '--port', str(port)], env=env, cwd=data,
                                           stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
                deadline = time.monotonic() + 90
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        raise RuntimeError(f'Backend exited ({process.returncode}) before readiness')
                    try:
                        if request('/desktop/status', owner=True)['status'] == 'ready':
                            return
                    except (OSError, urllib.error.URLError):
                        time.sleep(.2)
                raise RuntimeError('Authenticated backend readiness timed out')

            def stop():
                assert request('/desktop/shutdown', 'POST', owner=True)['accepted']
                process.wait(timeout=20)
                assert process.returncode == 0

            with (OUT / 'backend-probe.log').open('w') as log:
                start(log)
                report['health'] = request('/health')
                report['readiness'] = request('/ready')
                assert report['readiness']['ready']
                conversation = request('/conversations', 'POST', {'title': 'THROWAWAY packaging probe'})
                identifier = conversation['id']
                request('/conversations/' + identifier, 'PATCH',
                        {'draft': 'Persisted outside repository', 'draft_version': conversation['draft_version']})
                stop()
                start(log)
                restored = request('/conversations/' + identifier)
                assert restored['title'] == 'THROWAWAY packaging probe'
                assert restored['draft'] == 'Persisted outside repository'
                assert any(c['id'] == identifier for c in request('/conversations'))
                report['conversation_persistence_across_restart'] = True
                report['scratch_databases'] = [str(p.relative_to(data)) for p in data.rglob('*.sqlite3')]
                stop()
            report['status'] = 'passed'
        except Exception as error:
            report['error'] = str(error).replace(token, '[REDACTED]')
            raise
        finally:
            if process is not None and process.poll() is None:
                # Only our scratch child. Never enumerate or stop other servers.
                process.terminate()
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            for name in ('backend-probe.log',):
                path = OUT / name
                if path.exists():
                    path.write_text(path.read_text().replace(token, '[REDACTED]')[-20000:])
            (OUT / 'probe-result.json').write_text(json.dumps(report, indent=2))
            print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
