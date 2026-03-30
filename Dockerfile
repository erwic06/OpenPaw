FROM oven/bun@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7 AS builder

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --ignore-scripts --frozen-lockfile --production

FROM oven/bun@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7

RUN useradd --create-home --uid 10001 --shell /bin/sh nanoclaw

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY src/ ./src/
COPY package.json ./

# Claude Code CLI (from @anthropic-ai/claude-code) must be in PATH
# for the Agent SDK to spawn headless sessions.
ENV PATH="/app/node_modules/.bin:${PATH}"

USER nanoclaw

HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD bun -e "fetch('http://localhost:9999').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["bun", "run", "src/index.ts"]
