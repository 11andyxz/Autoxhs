"""配置加载(脚手架)。

从环境变量读取配置;若安装了 python-dotenv 且存在 .env 文件,会自动加载。
真正的小红书凭据 / 运行参数后续往这里补充即可。
"""

from __future__ import annotations

import os
from dataclasses import dataclass

# 可选:安装了 python-dotenv 时自动加载 .env,没装也不影响运行。
try:  # pragma: no cover - 取决于是否安装可选依赖
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:  # pragma: no cover
    pass


@dataclass(frozen=True)
class Config:
    """运行时配置。目前只是占位,后续按需扩展字段。"""

    log_level: str = "INFO"
    data_dir: str = "data"

    @classmethod
    def from_env(cls) -> "Config":
        return cls(
            log_level=os.environ.get("AUTOXHS_LOG_LEVEL", "INFO"),
            data_dir=os.environ.get("AUTOXHS_DATA_DIR", "data"),
        )

    def describe(self) -> str:
        return f"log_level={self.log_level} data_dir={self.data_dir}"
