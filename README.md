# Autoxhs

小红书自动化工具 —— **当前为空白脚手架**,已搭好 Python 项目骨架,具体功能待补充。

> 仓库:https://github.com/11andyxz/Autoxhs

## 环境要求

- Python 3.9+

## 快速开始

```bash
# 1. 创建并激活虚拟环境
python3 -m venv .venv
source .venv/bin/activate

# 2. 安装项目(含开发依赖)
pip install -e ".[dev]"

# 3. 运行
autoxhs --version
autoxhs info
```

未安装包时,也可直接运行:

```bash
PYTHONPATH=src python3 -m autoxhs info
```

## 配置

复制 `.env.example` 为 `.env` 并按需修改:

```bash
cp .env.example .env
```

## 项目结构

```
Autoxhs/
├── pyproject.toml        # 打包与依赖配置
├── README.md
├── .env.example          # 环境变量示例
├── .gitignore
├── src/
│   └── autoxhs/
│       ├── __init__.py
│       ├── __about__.py  # 版本号
│       ├── __main__.py   # python -m autoxhs 入口
│       ├── cli.py        # 命令行入口
│       ├── config.py     # 配置加载
│       └── core/         # 核心业务逻辑(待填充)
└── tests/
    └── test_cli.py       # 冒烟测试
```

## 测试

```bash
# 使用 pytest
pytest

# 或使用标准库 unittest(无需额外安装)
PYTHONPATH=src python3 -m unittest discover -s tests
```

## 开发约定

- 代码风格检查:`ruff`
- 测试框架:`pytest` / `unittest`

## 路线图(待定)

- [ ] 确定具体功能方向(自动发布 / 数据采集 / AI 文案)
- [ ] 接入小红书登录与凭据管理
- [ ] 实现核心业务逻辑(`src/autoxhs/core/`)
