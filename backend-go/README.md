# Backend — API REST em Go

Go 1.24+, só com a biblioteca padrão e uma dependência externa: [`pgx`](https://github.com/jackc/pgx), o driver do PostgreSQL.

O programa compila para **um único binário estático**. No Docker, ele roda numa imagem `FROM scratch` (vazia: sem sistema operacional, sem shell), com ~10 MB.

Usa dois bancos:
- **InfluxDB 3 Core**: séries temporais da planta (temperatura, setpoint, erro, sinal de controle).
- **PostgreSQL**: usuários, comandos e logs.

Tudo o que é armazenado é criptografado com **AES-256-GCM** antes de gravar. O formato `iv:tag:cifrado` é o mesmo da versão anterior em Node, então os dados são compatíveis entre as duas.

---

## Não tenho Go instalado. Preciso?

**Não.** O `docker compose up -d --build` compila o código dentro de uma imagem que já tem o Go. Instalar o Go só é útil para desenvolver com mais conforto: erros apontados no editor, `go run`, `go test`.

Para instalar no Ubuntu: baixe o `.tar.gz` em https://go.dev/dl/ e siga as instruções da página. Ou use `sudo snap install go --classic`.

---

## Como o código está organizado

Todos os arquivos `.go` desta pasta pertencem ao mesmo **pacote `main`**. O Go os compila juntos, então uma função de `crypto.go` pode ser usada em `handlers.go` sem `import`.

| Arquivo | O que faz |
|---|---|
| `main.go` | Ponto de entrada. Decide o modo (`servidor`, `setup` ou `comando`), carrega o `.env`, cria as tabelas e sobe o servidor HTTP. |
| `config.go` | Lê o `.env` e valida a configuração. Falha logo no início se a `ENCRYPTION_KEY` estiver errada. |
| `app.go` | A struct `App` com as "peças" compartilhadas (conexão com o Postgres, cliente do InfluxDB, criptografia) e a criação das tabelas a partir do `schema.sql`. |
| `crypto.go` | AES-256-GCM: `Encrypt` e `Decrypt`. |
| `influx.go` | Chamadas HTTP ao InfluxDB: escrita em line protocol, consulta SQL e verificação de saúde. |
| `samples.go` | Validação dos lotes do MATLAB e conversão de cada amostra em uma linha cifrada para o InfluxDB. |
| `commands.go` | Comandos `enabled`/`setpoint`: validar, gravar, ler o estado atual e o modo `comando` do terminal. |
| `logger.go` | Grava eventos na tabela `logs`, com descrição e IP cifrados. |
| `middleware.go` | Funções que "embrulham" as rotas: log de toda requisição e checagem da `X-Device-Key`. |
| `handlers.go` | As rotas da API (dados, comandos, status). |
| `auth.go` | Senhas com hash PBKDF2, sessões com JWT em cookie HttpOnly e `requireAuth`, que protege rotas por papel. |
| `users.go` | Login, logout, cadastro e lista de usuários e leitura dos logs (admin). |
| `stream.go` | Tempo real: o `Hub` distribui cada lote para os painéis abertos via Server-Sent Events (`/api/stream`). |
| `web.go` | Serve o site React, que é **embutido no binário** (`//go:embed all:web`). Rotas desconhecidas fora de `/api/` devolvem o `index.html`. |
| `web/index.html` | Página provisória para quando se compila sem o frontend. No Docker, é substituída pelo build do React. |
| `setup.go` | Modo `setup`: gera/completa o `.env` e os arquivos de configuração dos containers. |
| `chown_unix.go` / `chown_other.go` | Devolve o `.env` ao seu usuário quando o setup roda como root (só em Linux/macOS). |
| `schema.sql` | Tabelas do Postgres. É **embutido no binário** na compilação (`//go:embed`). |
| `backend_test.go` | Testes automáticos. |
| `Dockerfile` | Build em três etapas: compila o React (`node:22-alpine`), compila o Go com o site embutido (`golang:1.25-alpine`) e copia só o binário para `scratch`. O contexto do build é a raiz do repositório. |

### Cinco ideias de Go que aparecem no código

1. **Erros são valores.** Funções que podem falhar devolvem `(resultado, err)`, e quem chama verifica com `if err != nil { ... }`. Não existe `try/catch`.
2. **`struct` e métodos.** `type App struct { ... }` agrupa dados. `func (a *App) handleHealth(...)` é um método de `App`, e o `a` funciona como o `this`.
3. **`defer`** agenda algo para o fim da função. Por exemplo, `defer rows.Close()` garante que o resultado da consulta seja fechado.
4. **Goroutines.** `go a.logEvent(...)` roda a função em paralelo. É assim que o log da requisição é gravado sem atrasar a resposta.
5. **`context.Context`** carrega prazo e cancelamento. Se o MATLAB desistir da requisição, as consultas ao banco ligadas a ela são canceladas.

---

## Os três modos do binário

| Comando | O que faz |
|---|---|
| `backend` | Sobe a API na porta 3000. |
| `backend setup` | Gera/completa o `.env` (roda sozinho no `docker compose up`). |
| `backend comando <nome> <valor>` | Grava um comando para o MATLAB, por exemplo `comando setpoint 40`. |

No Docker:
```bash
docker compose exec backend /backend comando setpoint 40
docker compose exec backend /backend comando enabled 1
```

---

## Rodar e testar

**No Docker (padrão)**: na raiz do repositório:
```bash
docker compose up -d --build
```

**Testes automáticos, sem Go instalado**: na raiz do repositório. Este comando também cria/atualiza o `go.sum`, que deve ser commitado.
```bash
docker run --rm -u "$(id -u):$(id -g)" -e GOCACHE=/tmp/gocache -e GOMODCACHE=/tmp/gomod \
  -v "$PWD/backend-go":/src -w /src golang:1.25-alpine sh -c "go mod tidy && go test -v ./..."
```

**Com Go instalado (para desenvolver)**:
```bash
docker compose up -d db influxdb   # na raiz: só os bancos
docker compose stop backend        # libera a porta 3000
cd backend-go
go test ./...                      # testes
go run .                           # sobe a API (lê ../.env)
go run . comando setpoint 40       # envia comando
```

---

## Rotas

| Método | Rota | Autenticação | Descrição |
|---|---|---|---|
| GET | `/api/health` | — | Estado do servidor e dos dois bancos |
| POST | `/api/data` | Header `X-Device-Key` | Recebe um lote de amostras; responde com os comandos atuais |
| GET | `/api/commands` | Header `X-Device-Key` | Comandos atuais `{ enabled, setpoint }` |
| GET | `/api/auth/setup` | — | `{ needs_admin }`: true enquanto não existir nenhum usuário |
| POST | `/api/auth/login` | — | `{ username, password }`; grava o cookie de sessão (8 h) |
| POST | `/api/auth/logout` | — | Apaga o cookie |
| GET | `/api/auth/me` | sessão | Usuário logado |
| GET | `/api/users` | admin | Lista usuários |
| POST | `/api/users` | admin (o **primeiro** usuário pode ser criado sem login e vira admin) | `{ username, password, role }` |
| GET | `/api/logs?limit=100` | admin | Logs com descrição e IP decifrados |
| POST | `/api/send` | sessão | `{ name: "setpoint" \| "enabled", value }`; avisa os painéis abertos |
| GET | `/api/status` | sessão | Comandos atuais (só leitura) |
| GET | `/api/data/latest?limit=20` | sessão | Últimas amostras, decifradas (até 2000) |
| GET | `/api/stream` | sessão | Tempo real (Server-Sent Events): `{type:"samples", samples, commands}` e `{type:"commands", commands, by}` |

### POST /api/data

```http
POST /api/data
Content-Type: application/json
X-Device-Key: <DEVICE_KEY do .env>

{
  "device_id": "LTR701_MATLAB",
  "samples": [
    { "t": 1763740000123.4, "temp": 31.42, "setpoint": 35, "erro": 3.58, "u": 4.1, "enabled": 1 },
    { "t": 1763740000223.4, "temp": 31.50, "setpoint": 35, "erro": 3.50, "u": 4.1, "enabled": 1 }
  ]
}
```

- `t`: instante da amostra em **milissegundos desde 1970 (UTC)**. Obrigatório em cada amostra.
- Demais campos: qualquer variável numérica (nome com letras, números e `_`).
- Até 1000 amostras por lote, e corpo de até 200 KB.

| Status | Quando | Corpo |
|---|---|---|
| 201 | Lote gravado | `{ "status": "ok", "received": 2, "server_time": "...", "commands": { "enabled": 1, "setpoint": 35 } }` |
| 400 | JSON inválido ou lote fora do formato | `{ "status": "error", "message": "..." }` |
| 401 | Chave do dispositivo ausente/errada | `{ "status": "error", "message": "..." }` |
| 503 | InfluxDB indisponível | `{ "status": "error", "message": "..." }` |

No InfluxDB, cada amostra vira um ponto da medição `planta`, com tag `device` e cada variável como campo de texto cifrado.

### Comandos (`enabled`, `setpoint`)

Conforme o PDF de LCON-I, o MATLAB recebe apenas:
- `enabled`: 1 liga o controle; 0 desliga e zera a parcela integral;
- `setpoint`: temperatura desejada em °C, entre 0 e 100.

Os ganhos Kp e Ki **não** são enviados ao MATLAB. O estado completo é enviado a cada resposta, então um pacote perdido é corrigido no seguinte.

## Logs

Toda requisição é registrada na tabela `logs` com timestamp, IP (cifrado), descrição (cifrada) e status. A gravação acontece numa goroutine, sem atrasar a resposta.

Tipos de evento: `http_request`, `http_error`, `data_received`, `data_invalid`, `influx_error`, `command_sent`, `login_ok`, `login_failed`, `logout`, `user_created`. Os eventos de requisições feitas com login também registram **qual usuário** fez.
