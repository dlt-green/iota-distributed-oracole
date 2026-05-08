# syntax=docker/dockerfile:1
FROM node:20-alpine

RUN apk add --no-cache libc6-compat python3 make g++

WORKDIR /workspace

COPY webview/package*.json ./webview/
COPY webview/.env ./webview/.env
COPY client/package*.json ./client/

RUN npm config set registry https://registry.npmjs.org/

RUN --mount=type=cache,target=/root/.npm \
    cd /workspace/webview && \
    npm install --no-audit --fund=false --loglevel=info && \
    cd /workspace/client && \
    npm install --no-audit --fund=false --loglevel=info

COPY webview ./webview
COPY client ./client

WORKDIR /workspace/webview

RUN rm -rf dist && \
    npm run build && \
    node -e "const fs=require('fs'); const path=require('path'); const html=fs.readFileSync('dist/index.html','utf8'); const refs=[...html.matchAll(/(?:src|href)=\"\/([^\"?#]+)\"/g)].map(m=>m[1]).filter(p=>p.startsWith('assets/')); for (const ref of refs) { if (!fs.existsSync(path.join('dist', ref))) { console.error('Missing built asset:', ref); process.exit(1); } } console.log('Verified built assets:', refs.join(', '));"

ENV ORACLE_CLIENT_DIR=/workspace/client
ENV ORACLE_EXAMPLES_DIR=/workspace/webview/examples

EXPOSE 3000

CMD ["npm", "run", "start"]
