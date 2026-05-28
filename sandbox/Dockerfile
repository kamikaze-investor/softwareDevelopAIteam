# AI Sandbox — Docker実行環境
#
# ⚠️ CONTROL REPOSITORY — AI編集禁止
#
# 役割: AIがコードを実行する隔離環境
# AIが触れるのはこのコンテナ内の /workspace/project のみ

FROM node:20-slim

# 必要最小限のツールのみインストール
RUN apt-get update && apt-get install -y \
    git \
    curl \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# pnpm
RUN npm install -g pnpm@9

# 作業ディレクトリ
WORKDIR /workspace/project

# セキュリティ: rootで実行しない
RUN useradd -m -u 1001 aiworker
USER aiworker

# エントリポイントはWorkerから注入
CMD ["sh"]
