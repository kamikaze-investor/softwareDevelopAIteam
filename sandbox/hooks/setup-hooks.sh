#!/bin/sh
# git フックをインストールするスクリプト
#
# VPS上で一度だけ実行する:
#   cd /srv/ai-team/softwareDevelopAIteam
#   sh sandbox/hooks/setup-hooks.sh

set -e

HOOKS_DIR=".git/hooks"
SOURCE_DIR="sandbox/hooks"

echo "git フックをインストールします..."

# pre-push フック
cp "$SOURCE_DIR/pre-push" "$HOOKS_DIR/pre-push"
chmod +x "$HOOKS_DIR/pre-push"
echo "  ✅ pre-push フック インストール完了"

echo ""
echo "インストール済みフック:"
ls -la "$HOOKS_DIR/" | grep -v "^total" | grep -v "\.sample"
