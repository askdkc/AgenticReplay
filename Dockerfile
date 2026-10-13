# Ships only the MCP server, not the recorder.
#
# Recording works by wrapping a process on the host — a local proxy, a PATH shim, a shadow git
# index. None of that survives a container boundary, so `agenticreplay record` inside here would watch an
# empty namespace. What does travel is the read side: the six MCP tools serve runs that already
# exist on disk, so a client mounts its `.agenticreplay` directory and reads it.
#
#   docker run -i --rm -v "$PWD/.agenticreplay:/work/.agenticreplay:ro" agenticreplay
#
# Read-only is deliberate. This image is for inspecting traces, not changing them. Keep the mount
# read-only when an agent only needs to review recorded activity.
FROM node:24-alpine AS build
WORKDIR /src
COPY . .
RUN npm ci && npm run build \
    && mkdir /artifacts \
    && npm pack --pack-destination /artifacts

FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /work

# Install the self-contained CLI tarball from this checkout.
COPY --from=build /artifacts /artifacts
RUN npm install -g --omit=dev /artifacts/*.tgz && rm -rf /artifacts

# stdio transport — the client owns stdin/stdout, so no port is exposed.
ENTRYPOINT ["agenticreplay", "mcp"]
