# pi-workspace 工作容器（pi-afk 执行环境）
# 用途：afk 无人值守循环里每个阶段的干净容器；交互模式（后续）的工具路由后端。
#
# 构建：docker build -t pi-workspace --build-arg AGENT_UID=$(id -u) --build-arg AGENT_GID=$(id -g) .
#
# 运行时约定（由 afk 编排器负责）：
#   -v <worktree>:/workspace            项目写穿（node_modules 用匿名卷遮蔽，勿挂宿主 node_modules）
#   -v /workspace/node_modules          匿名卷：容器内 Linux 依赖，与宿主 macOS node_modules 隔离
#   -v <repo>/.git:<repo>/.git          宿主 .git 同路径可写（A' 接缝：容器内 commit 可行，issue #37）
#   -v <repo>/.git/hooks:<repo>/.git/hooks:ro   嵌套挂载覆盖为只读（宿主代码执行风险封死）
#   -v <repo>/.git/config:<repo>/.git/config:ro 嵌套挂载覆盖为只读（remote/凭据面封死）
#   -v <pi-home>:/home/agent/.pi        pi 配置/会话写穿宿主（可观测性）
#   -e DEEPSEEK_API_KEY / GH_TOKEN      凭据注入（不挂宿主 auth 文件）
#   -e GIT_AUTHOR_* / GIT_COMMITTER_*   容器内 git 提交身份
# 依赖安装：编排层容器就绪时 docker exec 主动装（lockfile 检测，AFK_INSTALL_CMD 可覆盖），agent 不自装

# 版本参数化：目标项目依赖升级时重建镜像（默认值 = 当前目标项目环境）
ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-bookworm

# 基础工具 + GitHub CLI（拉取 issue、push 分支）
RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

# pnpm（corepack 固定版本，杜绝版本漂移）
ARG PNPM_VERSION=11.21.0
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# Playwright chromium + 系统库：e2e 需要。
# 版本必须与目标项目 @playwright/test 匹配——项目升级 playwright 后需重建镜像。
# 浏览器装到全局 /ms-playwright（root 构建时下载，agent 只读使用）；--with-deps 自动 apt 装系统库
ARG PLAYWRIGHT_VERSION=1.62.1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN pnpm dlx playwright@${PLAYWRIGHT_VERSION} install chromium --with-deps \
  && rm -rf /var/lib/apt/lists/*

# pi（与宿主版本一致）
ARG PI_VERSION=0.84.1
RUN npm install -g @earendil-works/pi-coding-agent@${PI_VERSION}

# UID/GID 对齐宿主（macOS 上为 501:20），容器内文件权限与宿主一致
ARG AGENT_UID=1000
ARG AGENT_GID=1000
RUN groupmod -o -g $AGENT_GID node \
  && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node

# /workspace/node_modules 是匿名卷遮蔽点（容器内 Linux 依赖，与宿主隔离）；
# 匿名卷初始化时从镜像拷贝属主/权限——必须 agent 可写（/workspace 属主 root，故在切换前以 root 建）
RUN mkdir -p /workspace/node_modules && chown ${AGENT_UID}:${AGENT_GID} /workspace/node_modules
USER ${AGENT_UID}:${AGENT_GID}

# 以 agent 用户预热 corepack pnpm 缓存（root 预热只写 /root/.cache；此处消除 agent 首启下载失败点）
ARG PNPM_VERSION=11.21.0
RUN corepack prepare pnpm@${PNPM_VERSION} --activate

# CI=true：pnpm 在无 TTY 下（docker exec）purge node_modules 时自动重装，不 abort
ENV CI=true

# envcheck：开工前环境自检（node/pnpm/playwright/挂载），不过立即失败并给出原因
COPY --chown=${AGENT_UID}:${AGENT_GID} envcheck.sh /home/agent/bin/envcheck
ENV PATH="/home/agent/bin:${PATH}"

WORKDIR /workspace
ENTRYPOINT ["sleep", "infinity"]
