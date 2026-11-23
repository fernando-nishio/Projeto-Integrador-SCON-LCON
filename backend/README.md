# Backend — API REST

Node.js (≥ 20.6) + Express 5. Dois bancos:

- **InfluxDB 3 Core**: séries temporais da planta (temperatura, setpoint, erro, sinal de controle).
- **PostgreSQL**: usuários, comandos e logs.

Tudo o que é armazenado (leituras, comandos, descrição e IP dos logs) é criptografado com **AES-256-GCM** antes de gravar e só é descriptografado na hora de exibir.

## Arquitetura

```
Kit LTR701 ⇄ NI-USB-6003 ⇄ MATLAB (PI a 100 Hz)
                              │  HTTP: 1 lote de amostras por segundo
                              ▼
                       Node + Express ──► InfluxDB   (leituras cifradas)
                              │       ──► PostgreSQL (usuários, comandos, logs)
                              ▼
                          Frontend
```

## Como rodar

**No Docker (padrão)**: na raiz do repositório, rode o comando abaixo. A configuração, os bancos e as tabelas são criados automaticamente (veja o README principal).
```bash
docker compose up -d --build
```

**Fora do Docker (para desenvolver)**: o backend reinicia sozinho a cada alteração.
```bash
docker compose up -d db influxdb   # na raiz: só os bancos
docker compose stop backend        # libera a porta 3000
cd backend
npm install
npm run dev
```

Nos dois modos, a configuração vem do **`.env` da raiz do repositório**, que é gerado pelo `scripts/setup.mjs`. Ao iniciar, o backend aplica o `src/db/schema.sql`, que só tem `CREATE ... IF NOT EXISTS` e por isso pode rodar quantas vezes for preciso.

Para enviar um comando pelo terminal (antes de existir o formulário do site):

```bash
docker compose exec backend npm run comando -- enabled 1    # backend no Docker
npm run comando -- setpoint 40                              # backend fora do Docker (em backend/)
```

## Rotas

| Método | Rota | Autenticação | Descrição |
|---|---|---|---|
| GET | `/api/health` | — | Estado do servidor e dos dois bancos |
| POST | `/api/data` | Header `X-Device-Key` | Recebe um lote de amostras; responde com os comandos atuais |
| GET | `/api/commands` | Header `X-Device-Key` | Comandos atuais `{ enabled, setpoint }` |
| GET | `/api/data/latest?limit=20` | *(provisório: aberta)* | Últimas amostras, descriptografadas |

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
- Até 1000 amostras por lote.

| Status | Quando | Corpo |
|---|---|---|
| 201 | Lote gravado | `{ "status": "ok", "received": 2, "server_time": "...", "commands": { "enabled": 1, "setpoint": 35 } }` |
| 400 | Lote fora do formato | `{ "status": "error", "message": "..." }` |
| 401 | Chave do dispositivo ausente/errada | `{ "status": "error", "message": "..." }` |
| 503 | InfluxDB indisponível | `{ "status": "error", "message": "..." }` |

No InfluxDB, cada amostra vira um ponto da medição `planta`, com tag `device` e cada variável como campo de texto cifrado (`iv:tag:cifrado` em base64).

### Comandos (`enabled`, `setpoint`)

Conforme o PDF de LCON-I, o MATLAB recebe apenas:

- `enabled`: 1 liga o controle; 0 desliga e zera a parcela integral.
- `setpoint`: temperatura desejada em °C (entre 0 e 100).

Os ganhos Kp e Ki **não** são enviados ao MATLAB. O estado completo é enviado a cada resposta, então um pacote perdido é corrigido no seguinte.

## Logs

Toda requisição é registrada na tabela `logs` com timestamp, IP (cifrado), descrição (cifrada) e status.
Tipos de evento: `http_request`, `http_error`, `data_received`, `data_invalid`, `influx_error`, `command_sent`.

## Estrutura

```
backend/
├── Dockerfile                # imagem node:22-alpine (backend e setup)
├── scripts/
│   ├── setup.mjs             # gera/completa o .env e a config dos containers
│   └── comando.js            # envia comando pelo terminal
└── src/
    ├── server.js             # ponto de entrada, monta as rotas
    ├── db/
    │   ├── pool.js           # conexão com o PostgreSQL
    │   ├── migrate.js        # aplica o schema ao iniciar
    │   └── schema.sql        # tabelas users, commands, logs
    ├── middleware/
    │   ├── deviceKey.js      # valida X-Device-Key
    │   └── requestLogger.js  # loga toda requisição
    ├── routes/
    │   ├── data.js           # /api/data
    │   └── commands.js       # /api/commands
    └── services/
        ├── crypto.js         # AES-256-GCM
        ├── influx.js         # API HTTP do InfluxDB 3
        ├── samples.js        # validação dos lotes + line protocol
        ├── commands.js       # estado dos comandos
        └── logger.js         # grava na tabela logs
```
