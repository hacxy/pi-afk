# pi-afk 沙箱镜像（保守派：零凭据，基础工具 + pi）
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git curl ripgrep \
  && rm -rf /var/lib/apt/lists/*

# pi coding agent（与宿主 pi 版本保持一致）
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent

# pnpm（与宿主版本一致，用于沙箱内增量安装/修复平台二进制）
RUN npm install -g --ignore-scripts pnpm@11.21.0

# UID/GID 对齐宿主（sandcastle 预检要求，避免运行时权限问题）
ARG AGENT_UID=1000
ARG AGENT_GID=1000
RUN groupmod -o -g $AGENT_GID node \
  && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node

USER ${AGENT_UID}:${AGENT_GID}
WORKDIR /home/agent

# sandcastle 以 worktree 挂载 /home/agent/workspace
ENTRYPOINT ["sleep", "infinity"]
