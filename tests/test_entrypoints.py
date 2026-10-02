import runpy
import unittest
from importlib.metadata import distribution
from unittest.mock import patch

from outloud import server


class EntryPointTests(unittest.TestCase):
    def test_console_command_starts_only_the_browser_backend(self):
        commands = {
            entry.name: entry for entry in distribution("outloud").entry_points
            if entry.group == "console_scripts"
        }
        self.assertEqual(set(commands), {"outloud"})
        with patch.object(server.uvicorn, "run") as run:
            commands["outloud"].load()()
        run.assert_called_once_with(server.app, host="127.0.0.1", port=8765)

    def test_module_command_starts_the_same_backend(self):
        with patch.object(server.uvicorn, "run") as run:
            runpy.run_module("outloud", run_name="__main__")
        run.assert_called_once_with(server.app, host="127.0.0.1", port=8765)


if __name__ == "__main__":
    unittest.main()
