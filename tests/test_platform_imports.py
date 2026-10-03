import subprocess
import sys
import unittest


class PlatformImportTests(unittest.TestCase):
    def test_backend_imports_without_macos_frameworks(self):
        script = r'''
import importlib.abc
import sys

class BlockMacFrameworks(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname == "Quartz" or fullname == "CoreFoundation":
            raise ImportError(f"blocked platform-only module: {fullname}")

sys.meta_path.insert(0, BlockMacFrameworks())
import outloud.server
import outloud.shortcuts as shortcuts
assert not shortcuts.FnListener.is_supported()
original_platform = sys.platform
try:
    sys.platform = "darwin"
    assert shortcuts.FnListener.availability_error() == shortcuts.FN_FRAMEWORKS_UNAVAILABLE
    sys.platform = "linux"
    assert shortcuts.FnListener.availability_error() == shortcuts.FN_UNSUPPORTED_PLATFORM
finally:
    sys.platform = original_platform
'''
        result = subprocess.run(
            [sys.executable, "-c", script],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
