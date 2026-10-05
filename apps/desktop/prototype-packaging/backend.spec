# THROWAWAY macOS arm64 onedir experiment, not release configuration.
from pathlib import Path
from PyInstaller.utils.hooks import collect_data_files, collect_submodules, copy_metadata

here = Path(SPECPATH)
out = here / '.output'
datas = collect_data_files('whisper') + collect_data_files('tiktoken')
for package in ('outloud', 'openai-whisper', 'torch', 'numpy', 'sounddevice', 'pypdfium2', 'Pillow'):
    datas += copy_metadata(package)
a = Analysis([str(here / 'entrypoint.py')], pathex=[],
             binaries=[(str(out / 'ffmpeg-source/ffmpeg'), 'bin')], datas=datas,
             hiddenimports=collect_submodules('tiktoken_ext') + ['uvicorn.logging', 'uvicorn.loops.auto',
             'uvicorn.protocols.http.auto', 'uvicorn.protocols.websockets.auto', 'uvicorn.lifespan.on'],
             hookspath=[], runtime_hooks=[], excludes=[], noarchive=False)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='outloud-backend-spike',
          debug=False, strip=False, upx=False, console=True, target_arch='arm64')
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name='outloud-backend-spike')
