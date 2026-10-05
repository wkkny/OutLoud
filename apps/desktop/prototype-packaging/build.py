"""THROWAWAY build: isolated Python + source-built minimal LGPL FFmpeg + PyInstaller."""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
import urllib.request

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
OUT = HERE / '.output'
URL = 'https://ffmpeg.org/releases/ffmpeg-8.0.tar.xz'
# Set from the official HTTPS archive; this is an integrity pin, not GPG verification.
FFMPEG_SHA256 = 'b2751fccb6cc4c77708113cd78b561059b6fa904b24162fa0be2d60273d27b8e'
CONFIGURE = ['./configure', '--disable-autodetect', '--disable-everything', '--disable-doc',
             '--disable-debug', '--disable-network', '--disable-shared', '--enable-static',
             '--disable-gpl', '--disable-nonfree', '--disable-version3', '--enable-ffmpeg',
             '--enable-avcodec', '--enable-avformat', '--enable-avfilter', '--enable-swresample',
             '--enable-protocol=file,pipe', '--enable-demuxer=wav', '--enable-decoder=pcm_s16le',
             '--enable-encoder=pcm_s16le,pcm_f32le', '--enable-muxer=pcm_s16le,pcm_f32le',
             '--enable-filter=aresample,aformat,anull', '--cc=/usr/bin/clang']


def run(command, name, cwd=ROOT, env=None, timeout=300):
    print(name, flush=True)
    log = OUT / f'{name}.log'
    with log.open('w') as output:
        process = subprocess.Popen([str(x) for x in command], cwd=cwd, env=env,
                                   stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            # Only terminate the process group this build owns.
            import signal
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            raise RuntimeError(f'{name} exceeded {timeout}s; see {log}')
    if code:
        print(log.read_text()[-6000:])
        raise RuntimeError(f'{name} failed ({code}); see {log}')
    # Keep bounded diagnostic output on disk.
    contents = log.read_text()
    if len(contents) > 200000:
        log.write_text(contents[:20000] + '\n[bounded log: middle omitted]\n' + contents[-180000:])


def main():
    if sys.platform != 'darwin' or platform.machine() != 'arm64':
        raise RuntimeError('This experiment requires macOS arm64')
    OUT.mkdir(exist_ok=True)
    uv = shutil.which('uv')
    if not uv:
        raise RuntimeError('Build prerequisite: uv (runtime artifact does not need it)')
    python = OUT / 'venv/bin/python'
    if not python.exists():
        run([uv, 'venv', '--python', '3.11', OUT / 'venv'], 'venv')
    # Read the existing lockfile without updating it; keep generated exports ignored.
    requirements = OUT / 'backend-requirements.txt'
    run([uv, 'export', '--frozen', '--no-dev', '--no-emit-project', '--output-file', requirements], 'lock-export')
    run([uv, 'pip', 'install', '--python', python, '-r', requirements,
         'pyinstaller==6.22.3', 'pyinstaller-hooks-contrib==2026.8'], 'dependencies')
    # Install the real backend as a wheel, not an editable source/cwd dependency.
    run([uv, 'pip', 'install', '--python', python, '--no-deps', ROOT], 'backend-wheel')
    run([uv, 'pip', 'freeze', '--python', python], 'installed-versions')
    archive = OUT / 'ffmpeg-8.0.tar.xz'
    if not archive.exists():
        with urllib.request.urlopen(URL, timeout=60) as response, archive.open('wb') as target:
            shutil.copyfileobj(response, target)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    if digest != FFMPEG_SHA256:
        raise RuntimeError(f'FFmpeg source SHA256 mismatch: {digest}')
    source = OUT / 'ffmpeg-source'
    if not source.exists():
        with tarfile.open(archive) as tar:
            tar.extractall(OUT, filter='data')
        (OUT / 'ffmpeg-8.0').rename(source)
    clean_env = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': str(OUT), 'TMPDIR': '/tmp'}
    run(CONFIGURE, 'ffmpeg-configure', cwd=source, env=clean_env)
    run(['/usr/bin/make', '-j4', 'ffmpeg'], 'ffmpeg-compile', cwd=source, env=clean_env)
    run(['/usr/bin/otool', '-L', source / 'ffmpeg'], 'ffmpeg-linkage')
    linkage = (OUT / 'ffmpeg-linkage.log').read_text()
    if '/opt/homebrew/' in linkage or '/usr/local/' in linkage:
        raise RuntimeError('FFmpeg has an unaudited external dylib dependency')
    run([python, '-m', 'PyInstaller', '--noconfirm', '--clean', '--distpath', OUT / 'dist',
         '--workpath', OUT / 'build', HERE / 'backend.spec'], 'pyinstaller', timeout=360)
    artifact = OUT / 'dist/outloud-backend-spike'
    notices = artifact / 'THIRD-PARTY-FFMPEG'
    notices.mkdir(exist_ok=True)
    shutil.copy2(archive, notices / archive.name)
    shutil.copy2(source / 'COPYING.LGPLv2.1', notices / 'COPYING.LGPLv2.1')
    (notices / 'BUILD.json').write_text(json.dumps({'source_url': URL, 'sha256': digest,
        'configure': CONFIGURE, 'modified_source': False,
        'notice': 'Uses FFmpeg under LGPL v2.1 or later; matching source is included. '
                  'Standalone executable; no external third-party libraries enabled. '
                  'No restrictions on replacing FFmpeg. Release compliance review remains required.'}, indent=2))
    run(['/usr/bin/file', artifact / 'outloud-backend-spike', artifact / '_internal/bin/ffmpeg'], 'architectures')
    size = sum(p.stat().st_size for p in artifact.rglob('*') if p.is_file() and not p.is_symlink())
    (OUT / 'build-result.json').write_text(json.dumps({'artifact': str(artifact), 'bytes': size,
        'source_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()}, indent=2))
    print(f'Built {artifact}; {size / 1024**2:.1f} MiB. Run probe.py next.')


if __name__ == '__main__':
    main()
