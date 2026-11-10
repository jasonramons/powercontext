# Study Buddy — 单镜像：Node 应用 + PowerContext 记忆桥
# 用可访问的镜像源，国内网络直接可构建
FROM docker.m.daocloud.io/library/node:22-bookworm-slim

ARG NPM_REGISTRY=https://registry.npmmirror.com
ARG PIP_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple

RUN set -eux; \
    if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
      sed -i 's|http://deb.debian.org|http://mirrors.tuna.tsinghua.edu.cn|g; s|http://security.debian.org|http://mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources; \
    fi; \
    if [ -f /etc/apt/sources.list ]; then \
      sed -i 's|http://deb.debian.org|http://mirrors.tuna.tsinghua.edu.cn|g; s|http://security.debian.org|http://mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends python3 python3-venv python3-pip ca-certificates curl; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 依赖先装，代码后拷，改代码不会重装 node_modules
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund --registry=$NPM_REGISTRY

COPY server ./server
COPY web ./web
COPY bridge ./bridge
COPY data ./data
COPY scripts ./scripts

# PowerContext：记忆桥需要它的 Python 运行时
RUN python3 -m venv /opt/pc \
 && /opt/pc/bin/pip install --no-cache-dir --upgrade pip -i $PIP_INDEX \
 && /opt/pc/bin/pip install --no-cache-dir "powercontext[cli,server]" -i $PIP_INDEX

ENV PATH="/opt/pc/bin:$PATH" \
    PORT=8788 \
    PC_BRIDGE_HOST=0.0.0.0 \
    PC_BRIDGE_PORT=8766 \
    POWERCONTEXT_URL=http://127.0.0.1:8766 \
    PC_DB=/data/powercontext.db \
    SEEPDB_PATH=/data/seekdb.db \
    STUDY_DATA_DIR=/data \
    NODE_ENV=production

VOLUME ["/data"]
EXPOSE 8788

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8788/api/health || exit 1

# 先起记忆桥，等它就绪，再起应用
CMD ["bash", "-lc", "python3 bridge/app.py & for i in $(seq 1 40); do curl -fsS http://127.0.0.1:8766/health >/dev/null 2>&1 && break; sleep 1; done; node server/index.mjs"]
