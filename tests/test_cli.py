"""冒烟测试:确认脚手架可导入、CLI 可运行。

同时兼容 pytest 与标准库 unittest:
    pytest
    PYTHONPATH=src python3 -m unittest discover -s tests
"""

import unittest

from autoxhs import __version__
from autoxhs.cli import build_parser, main
from autoxhs.config import Config


class TestScaffold(unittest.TestCase):
    def test_version_is_set(self):
        self.assertTrue(__version__)

    def test_parser_builds_info_command(self):
        parser = build_parser()
        args = parser.parse_args(["info"])
        self.assertEqual(args.command, "info")

    def test_main_without_args_returns_zero(self):
        self.assertEqual(main([]), 0)

    def test_info_command_runs(self):
        self.assertEqual(main(["info"]), 0)

    def test_config_defaults(self):
        config = Config.from_env()
        self.assertEqual(config.data_dir, "data")


if __name__ == "__main__":
    unittest.main()
