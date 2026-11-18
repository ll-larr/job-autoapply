#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "$0")"

if [ "$(uname -s)" != Darwin ]; then
    echo "Этот лаунчер предназначен для macOS." >&2
    exit 1
fi

if ! command -v node >/dev/null || ! command -v npm >/dev/null ||
    ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) < 24 ? 1 : 0)' 2>/dev/null; then
    version=v24.22.3
    if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then
        arch=arm64
        hash=ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd
    elif [ "$(uname -m)" = x86_64 ]; then
        arch=x64
        hash=977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7
    else
        echo "Поддерживаются Mac с Apple Silicon и Intel x64." >&2
        exit 1
    fi

    dist="node-$version-darwin-$arch"
    runtime="$PWD/.runtime"
    node_dir="$runtime/$dist/bin"
    if [ ! -x "$node_dir/node" ] || [ ! -x "$node_dir/npm" ]; then
        echo "Скачиваю Node.js $version ($arch)"
        mkdir -p "$runtime"
        stage="$(mktemp -d "$runtime/node-download.XXXXXXXX")"
        trap 'rm -rf -- "$stage"' EXIT
        archive="$dist.tar.gz"
        curl --fail --location --retry 2 --connect-timeout 30 \
            "https://nodejs.org/dist/$version/$archive" -o "$stage/$archive"
        (cd "$stage" && printf '%s  %s\n' "$hash" "$archive" | shasum -a 256 -c -)
        tar -xzf "$stage/$archive" -C "$stage"
        mv -n "$stage/$dist" "$runtime/"
    fi
    if [ ! -x "$node_dir/node" ] || [ ! -x "$node_dir/npm" ]; then
        echo "Node.js не распакован. Удали каталог .runtime/$dist и повтори запуск." >&2
        exit 1
    fi
    export PATH="$node_dir:$PATH"
fi

npm run setup:panel
echo "Панель: http://127.0.0.1:4321"
exec npm run panel
