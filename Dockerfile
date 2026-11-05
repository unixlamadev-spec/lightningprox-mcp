FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY bin ./bin
COPY src ./src
ENTRYPOINT ["node", "bin/lightningprox-mcp.js"]
