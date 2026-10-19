FROM node:22-bookworm-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		bash \
		ca-certificates \
		fd-find \
		file \
		git \
		ripgrep \
	&& ln -s /usr/bin/fdfind /usr/local/bin/fd \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY scripts ./scripts

RUN npm ci --ignore-scripts \
	&& npm run build \
	&& npm pack --workspace @greppleai/grip --pack-destination /tmp/grip-pack \
	&& npm install -g --ignore-scripts /tmp/grip-pack/greppleai-grip-*.tgz \
	&& rm -rf /tmp/grip-pack

RUN mkdir -p /workspace/src /workspace/.grip/skills /workspace/.grip/skills/remote-container \
	&& printf '# Remote grip daemon test project\n\nThis project is inside the grip --daemon Docker container.\n' > /workspace/README.md \
	&& printf '# Project Instructions\n\nYou are working inside the grip --daemon Docker test container. Use tools normally; file and shell operations run in /workspace.\n' > /workspace/AGENTS.md \
	&& printf 'export function hello(name: string): string {\n\treturn `hello ${name}`;\n}\n' > /workspace/src/hello.ts \
	&& printf '%s\n' '---' 'description: This intentionally malformed skill is missing name frontmatter.' '---' '' '# Malformed container skill' '' 'This file should appear as a skill loading diagnostic, not as a loaded skill.' > /workspace/.grip/skills/container.md \
	&& printf '%s\n' '---' 'name: remote-container' 'description: Mention that the skill came from the remote container.' '---' '' '# Remote container skill' '' 'When this skill is loaded, mention that it came from the remote container.' > /workspace/.grip/skills/remote-container/SKILL.md

ENV GRIP_DAEMON_HOST=0.0.0.0
ENV GRIP_DAEMON_PORT=8787
ENV GRIP_DAEMON_CWD=/workspace
ENV GRIP_DAEMON_TOKEN=dev-token-dev-token-dev-token-dev-token
ENV GRIP_DAEMON_ALLOW_INSECURE_TRANSPORT=1
ENV GRIP_DAEMON_ALLOW_PROCESS_EXEC=1

WORKDIR /workspace
EXPOSE 8787

CMD ["grip", "--daemon"]
