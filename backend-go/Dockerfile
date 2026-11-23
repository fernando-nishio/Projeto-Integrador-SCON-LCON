# Imagem do sistema: frontend (React) + backend (Go) num único binário.
# Construída em três etapas ("multi-stage build"). Você NÃO precisa ter Node nem Go
# instalados: tudo é compilado dentro do Docker.
#
# O contexto do build é a RAIZ do repositório (veja "build:" no docker-compose.yml),
# porque esta imagem precisa das pastas frontend/ e backend-go/.

# ---------- Etapa 1: compilar o frontend ----------
# Imagem com o Node (~150 MB). Só existe durante o build.
FROM node:22-alpine AS frontend
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json* ./
# Com package-lock.json usa as versões exatas travadas (npm ci); sem ele, resolve na hora
RUN if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
COPY frontend/ ./
RUN npm run build
# resultado: /app/dist (index.html + assets/*.js e *.css minificados)

# ---------- Etapa 2: compilar o backend ----------
# Imagem com o Go (~250 MB). Só existe durante o build.
FROM golang:1.25-alpine AS build
WORKDIR /src

# Dependências primeiro: se só o código mudar, o Docker reaproveita esta camada
COPY backend-go/go.mod backend-go/go.sum* ./
RUN go mod download

COPY backend-go/*.go backend-go/schema.sql ./
# O site compilado entra na pasta web/, que o //go:embed coloca dentro do binário
COPY --from=frontend /app/dist ./web
# go mod tidy completa o go.sum se ele ainda não estiver no repositório.
# CGO_ENABLED=0  -> binário 100% estático (não depende de nenhuma biblioteca do sistema)
# -trimpath -ldflags="-s -w" -> tira caminhos locais e símbolos de depuração (binário menor)
RUN go mod tidy && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/backend .

# ---------- Etapa 3: imagem final ----------
# "scratch" é uma imagem VAZIA: sem sistema operacional, sem shell, sem nada.
# Só o nosso binário (com o site dentro). Menos espaço e quase nada para um atacante explorar.
FROM scratch
COPY --from=build /out/backend /backend

# O backend lê a configuração que o setup grava no volume "config"
ENV ENV_FILE=/config/app.env

# Roda como o usuário "nobody" (UID 65534), sem privilégios de root
USER 65534:65534

EXPOSE 3000
ENTRYPOINT ["/backend"]
