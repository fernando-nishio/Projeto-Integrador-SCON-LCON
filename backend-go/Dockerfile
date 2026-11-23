# Imagem do backend em Go, construída em duas etapas ("multi-stage build").
# Você NÃO precisa ter Go instalado: a compilação acontece dentro do Docker.

# ---------- Etapa 1: compilar ----------
# Imagem com o Go (~250 MB). Só existe durante o build e é descartada no fim.
FROM golang:1.25-alpine AS build
WORKDIR /src

# Dependências primeiro: se só o código mudar, o Docker reaproveita esta camada
COPY go.mod go.sum* ./
RUN go mod download

COPY *.go schema.sql ./
# go mod tidy completa o go.sum se ele ainda não estiver no repositório.
# CGO_ENABLED=0  -> binário 100% estático (não depende de nenhuma biblioteca do sistema)
# -trimpath -ldflags="-s -w" -> tira caminhos locais e símbolos de depuração (binário menor)
RUN go mod tidy && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/backend .

# ---------- Etapa 2: imagem final ----------
# "scratch" é uma imagem VAZIA: sem sistema operacional, sem shell, sem nada.
# Só o nosso binário (~10 MB). Menos espaço em disco e quase nada para um atacante explorar.
FROM scratch
COPY --from=build /out/backend /backend

# O backend lê a configuração que o setup grava no volume "config"
ENV ENV_FILE=/config/app.env

# Roda como o usuário "nobody" (UID 65534), sem privilégios de root
USER 65534:65534

EXPOSE 3000
ENTRYPOINT ["/backend"]
