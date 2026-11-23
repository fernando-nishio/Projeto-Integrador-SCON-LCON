# Imagem do backend (também usada pelo serviço "setup").
# Alpine: imagem base pequena (~50 MB comprimida) em vez da Debian (~400 MB).
FROM node:22-alpine

WORKDIR /app/backend
ENV NODE_ENV=production

# Dependências primeiro: se só o código mudar, o Docker reaproveita esta camada
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY scripts ./scripts

# Os arquivos chegam com as permissões que têm no seu computador (às vezes 600,
# só o dono lê). Libera leitura para todos e acesso às pastas (X = só diretórios),
# senão o usuário "node" não consegue abrir o código.
RUN chmod -R a+rX /app/backend

# O backend lê "../.env" (como fora do Docker). Aqui esse caminho aponta para o
# arquivo que o setup grava no volume "config".
RUN ln -s /config/app.env /app/.env

# Não roda como root
USER node

EXPOSE 3000
# node direto (sem npm na frente): um processo a menos na memória
CMD ["node", "--env-file=../.env", "src/server.js"]
