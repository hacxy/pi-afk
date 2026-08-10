# pi-afk 沙箱镜像（保守派：零凭据，基础工具 + pi）
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git curl ripgrep \
  && rm -rf /var/lib/apt/lists/*

# pi coding agent（与宿主 pi 版本保持一致）
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent

# pnpm（与宿主版本一致：afk CLI 构建镜像时自动传入宿主 pnpm --version 作为 PNPM_VERSION）
ARG PNPM_VERSION
RUN npm install -g --ignore-scripts pnpm@${PNPM_VERSION}

# UID/GID 对齐宿主（sandcastle 预检要求，避免运行时权限问题）
# 提前声明：浏览器预装目录的 chown 需要对齐最终 UID/GID
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# ── Playwright / Chromium 预装 ──────────────────────────────────────────────
# 事故教训（hacxy.cn #24）：精简 Debian 沙箱缺 Chromium 系统库且 agent 无 root，
#   曾现场下载 .deb 解压 + LD_LIBRARY_PATH 硬凑，浏览器软件渲染极慢、e2e 挂死。
# 1) 系统依赖：playwright 官方 install-deps 安装与 Debian 版本匹配的库清单
#    （不手写硬编码 apt 列表，随 playwright 演进自动对齐）
# 2) 浏览器二进制：预下载 chromium + chrome-headless-shell 到镜像内共享目录
#    /opt/ms-playwright（run 时免下载；项目 playwright 版本不同时 agent 仍可
#    `npx playwright install` 增量补齐——系统库已就绪，仅需下载二进制）
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN npx --yes playwright@1.62.1 install-deps chromium \
  && npx --yes playwright@1.62.1 install chromium \
  && chown -R ${AGENT_UID}:${AGENT_GID} /opt/ms-playwright \
  && rm -rf /root/.npm /tmp/* /var/lib/apt/lists/*

RUN groupmod -o -g $AGENT_GID node \
  && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node

USER ${AGENT_UID}:${AGENT_GID}
WORKDIR /home/agent

# sandcastle 以 worktree 挂载 /home/agent/workspace
ENTRYPOINT ["sleep", "infinity"]
