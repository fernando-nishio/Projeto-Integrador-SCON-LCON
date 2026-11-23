# Projeto Integrador SCOM / LCON-I

Sistema web para **monitorar e controlar remotamente o soprador térmico (kit LTR701)** da UNESP Sorocaba.

O MATLAB roda o controle PI da temperatura a 100 Hz e troca dados com um backend Node.js por HTTP. O backend guarda tudo **criptografado** e vai servir o dashboard do site.

---

## Sumário
- [Situação atual](#situação-atual)
- [Arquitetura](#arquitetura)
- [Estrutura do repositório](#estrutura-do-repositório)
- [Pré-requisitos](#pré-requisitos)
- [Primeira instalação](#primeira-instalação-uma-vez-por-computador)
- [Como rodar no dia a dia](#como-rodar-no-dia-a-dia)
- [Testar sem o kit](#testar-sem-o-kit)
- [Usar com o kit LTR701](#usar-com-o-kit-ltr701)
- [API](#api)
- [Segurança](#segurança)
- [Problemas comuns](#problemas-comuns)
- [Regras do repositório](#regras-do-repositório)

---

## Situação atual

| Parte | Estado |
|---|---|
| Bancos (PostgreSQL + InfluxDB) via Docker | ✅ funcionando |
| Backend: receber dados da planta (`POST /api/data`) | ✅ funcionando |
| Backend: comandos para o MATLAB (`enabled`, `setpoint`) | ✅ funcionando (enviados pelo terminal) |
| Criptografia AES-256-GCM de leituras, comandos e logs | ✅ funcionando |
| Log de toda requisição (timestamp, IP, status) | ✅ funcionando |
| Simulador da planta em Python | ✅ funcionando |
| Script MATLAB (`cliente_planta.m`) em modo simulação | ⚠️ escrito, falta testar no MATLAB |
| Script MATLAB com o kit real (NI-USB-6003) | ⏳ falta o código de hardware de LCON-I |
| Login, níveis de acesso admin/usuário, `POST /api/send` | ⏳ próximo passo |
| Frontend: formulário + dashboard em tempo real | ⏳ a fazer |
| Simulação no site ("sombra digital") | ⏳ a fazer |
| Backup diário e restauração | ⏳ a fazer |
| Estatística descritiva (média, variância, curtose, outliers) | ⏳ a fazer |

Medições de desempenho já feitas (simulador → backend → InfluxDB, mesmo computador):

| Configuração | RTT médio | Observação |
|---|---|---|
| WAL do InfluxDB a cada 1 s (padrão) | ~825 ms | a escrita esperava a próxima gravação do WAL |
| WAL a cada 100 ms (atual) | ~81 ms | ajuste em `docker-compose.yml` |
| Escrita direta sem esperar WAL (`no_sync`) | ~9 ms | só para comparação, não usado |

---

## Arquitetura

```
 Kit LTR701 ⇄ NI-USB-6003 ⇄ MATLAB  (PI a 100 Hz, filtro, saturação 0–10 V)
                              │
                              │  HTTP, 1 lote por segundo (amostras a 10 Hz)
                              │  POST /api/data  →  resposta traz { enabled, setpoint }
                              ▼
                     Node.js + Express (porta 3000)
                       │                     │
                       ▼                     ▼
          InfluxDB 3 Core (8181)      PostgreSQL 16 (5433)
          séries temporais:           usuários, comandos, logs
          temp, setpoint, erro, u     (cifrados)
          (cifrados)
                       │
                       ▼
               Frontend (a fazer): login, formulário, dashboard
```

**Por que dois bancos:**
- O **InfluxDB** é feito para séries temporais: consultas por intervalo de tempo e retenção de dados antigos.
- O **PostgreSQL** é melhor para dados relacionais: usuários, papéis, comandos e auditoria.

**Por que lotes:** uma requisição HTTP leva alguns milissegundos. Se o MATLAB enviasse a cada amostra, o laço de 100 Hz atrasaria. Ele acumula as amostras e envia uma vez por segundo, e na mesma resposta recebe os comandos do site.

**Comandos:** conforme o PDF de LCON-I, o MATLAB recebe só `enabled` e `setpoint`.
- `enabled` = 1 liga o controle; 0 desliga e zera a integral.
- `setpoint` é a temperatura desejada em °C.

Os ganhos Kp e Ki ficam no próprio script MATLAB e **não** vêm do site.

---

## Estrutura do repositório

```
.
├── docker-compose.yml          # PostgreSQL + InfluxDB
├── .env                        # (não versionado) credenciais lidas pelo docker compose
├── backend/                    # API Node.js + Express — ver backend/README.md
│   ├── .env.example            # modelo de configuração (copiar para .env)
│   ├── scripts/comando.js      # envia comando pelo terminal (até existir o site)
│   └── src/
│       ├── server.js
│       ├── db/                 # conexão e schema do PostgreSQL
│       ├── middleware/         # chave do dispositivo, log de requisições
│       ├── routes/             # /api/data, /api/commands
│       └── services/           # criptografia, InfluxDB, comandos, logs
├── firmware/matlab/
│   └── cliente_planta.m        # controle PI + comunicação com o backend
├── simulacao/
│   └── planta_simulada.py      # imita o MATLAB + planta, para testar sem o kit
├── frontend/                   # (a fazer)
└── docs/                       # diagramas e material do relatório
```

---

## Pré-requisitos

| Ferramenta | Versão | Para quê |
|---|---|---|
| Docker + Docker Compose v2 | qualquer recente | rodar os bancos |
| Node.js | ≥ 20.6 | backend |
| Python 3 | ≥ 3.8 | simulador (só biblioteca padrão) |
| MATLAB | com `webwrite` (R2015a+) | cliente da planta |

Funciona em Linux, Windows e macOS. Os comandos abaixo são para **Ubuntu**.

Instalar o Docker no Ubuntu 22.04:
```bash
sudo apt update
sudo apt install docker.io docker-compose-v2
sudo usermod -aG docker $USER     # depois: sair da sessão e entrar de novo
docker run hello-world            # teste
```

---

## Primeira instalação (uma vez por computador)

Todos os comandos partem da raiz do repositório.

**1. Arquivos de configuração**
```bash
cp backend/.env.example .env
cp backend/.env.example backend/.env
```
- Arquivos que começam com `.` ficam ocultos. Use `ls -a` para vê-los.
- Edite os dois arquivos (`nano .env` e `nano backend/.env`) e troque `DB_PASSWORD`, usando **a mesma senha nos dois**.
- Não rode os `cp` de novo depois de editar, senão as senhas são sobrescritas.

**2. Subir os bancos**
```bash
docker compose up -d
docker exec -it pi_postgres psql -U pi_user -d projeto_integrador -c "\dt"
```
O segundo comando deve listar `commands`, `logs` e `users`. Se sair "Did not find any relations", crie as tabelas manualmente:
```bash
docker exec -i pi_postgres psql -U pi_user -d projeto_integrador < backend/src/db/schema.sql
```

**3. Token do InfluxDB** (o token é mostrado **uma única vez**; guarde)
```bash
docker exec -it pi_influxdb influxdb3 create token --admin
```
Cole o token em `INFLUX_TOKEN=` no `backend/.env`.

**4. Chaves de criptografia e do dispositivo**
```bash
cd backend
sed -i "s/^ENCRYPTION_KEY=.*/ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")/" .env
sed -i "s/^DEVICE_KEY=.*/DEVICE_KEY=$(node -e "console.log(require('crypto').randomBytes(16).toString('hex'))")/" .env
```
> ⚠️ Se a `ENCRYPTION_KEY` for perdida ou trocada, os dados já gravados **não podem mais ser lidos**. Cada computador tem a sua, então os dados de um não abrem no outro.

**5. Dependências do backend**
```bash
npm install
```

---

## Como rodar no dia a dia

**Terminal 1: bancos e backend**
```bash
cd ~/Projeto_Integrador/Projeto-Integrador-SCON-LCOM
docker compose up -d
cd backend
npm run dev
```
O esperado é `Backend rodando em http://localhost:3000`. Para conferir, abra http://localhost:3000/api/health no navegador. Deve mostrar `"postgres":"ok"` e `"influxdb":"ok"`.

> Abrir só `http://localhost:3000/` mostra "Rota não encontrada". Isso é normal, porque ainda não há site, só a API em `/api/...`.

**Terminal 2: a planta** (escolha uma das opções)
```bash
python3 simulacao/planta_simulada.py           # simulador em Python
```
```matlab
% ou no MATLAB:
cd ~/Projeto_Integrador/Projeto-Integrador-SCON-LCOM/firmware/matlab
cliente_planta
```

**Terminal 3: comandos** (fazem o papel do site por enquanto)
```bash
cd ~/Projeto_Integrador/Projeto-Integrador-SCON-LCOM/backend
npm run comando -- setpoint 40     # entre 0 e 100 °C
npm run comando -- enabled 1       # liga o controle
npm run comando -- enabled 0       # desliga e zera a integral
```

**Ver os dados**
```bash
curl "localhost:3000/api/data/latest?limit=5"                 # últimas amostras, já decifradas
docker exec -it pi_postgres psql -U pi_user -d projeto_integrador \
  -c "SELECT id, timestamp, event_type, status FROM logs ORDER BY id DESC LIMIT 10;"
```

**Desligar tudo**
- `Ctrl+C` no backend e na planta. Ao parar, a planta mostra o resumo com a perda de pacotes e o RTT.
- `docker compose stop` para os bancos. Os dados ficam guardados.

---

## Testar sem o kit

O `simulacao/planta_simulada.py` faz exatamente o que o MATLAB faz:
- PI a 100 Hz;
- sensor com ruído e filtro passa-baixa;
- saturação de 0 a 10 V;
- amostras a 10 Hz enviadas em lote a cada 1 s.

A planta é dT/dt = −0,4·(T − 25) + 2·u, ou seja, G(s) = 2/(s+0,4), o exemplo do professor. **Troque pelos parâmetros do kit do grupo** obtidos em LCON-I. Os mesmos valores estão no `cliente_planta.m`.

Resultado esperado com `setpoint 40` e `enabled 1`: a temperatura sobe de 25 para ~40 °C em ~3 s, com u ≈ 3 V em regime (25 + 5·3 = 40).

---

## Usar com o kit LTR701

No `firmware/matlab/cliente_planta.m`:
1. Mude `SIMULACAO = false`.
2. Configure a NI-USB-6003 (bloco `daq("ni")`, comentado no script).
3. Complete as três funções do fim do arquivo com o código de LCON-I:
   - `ler_temperatura_volts`: leitura do sensor;
   - `volts_para_celsius`: equação de conversão do kit;
   - `aplicar_aquecedor`: saída para o aquecedor (e o ventilador, se necessário).
4. Ajuste `Kp`, `Ki` e o filtro `ALFA` para os valores do grupo.

Antes de ligar o kit, confira se os seletores dos atuadores 1 e 2 estão em **OFF** e confira as ligações com a placa. Ao parar o script (Ctrl+C), o aquecedor é desligado automaticamente.

---

## API

Documentação completa das rotas em **[backend/README.md](backend/README.md)**. Resumo:

| Método | Rota | Autenticação | Descrição |
|---|---|---|---|
| GET | `/api/health` | — | estado do servidor e dos bancos |
| POST | `/api/data` | header `X-Device-Key` | recebe lote de amostras; responde com os comandos |
| GET | `/api/commands` | header `X-Device-Key` | comandos atuais `{ enabled, setpoint }` |
| GET | `/api/data/latest` | *(provisório: aberta)* | últimas amostras decifradas |

Exemplo de lote:
```json
{
  "device_id": "LTR701_MATLAB",
  "samples": [
    { "t": 1763740000123.4, "temp": 31.42, "setpoint": 35, "erro": 3.58, "u": 4.1, "enabled": 1 }
  ]
}
```
`t` = milissegundos desde 1970, em UTC.

---

## Segurança

- **Criptografia AES-256-GCM** (`backend/src/services/crypto.js`) antes de gravar:
  - leituras da planta (InfluxDB);
  - valores dos comandos (PostgreSQL);
  - descrição e IP dos logs (PostgreSQL).

  Cada valor tem um IV aleatório, e a tag GCM detecta adulteração no banco.
- **Origem do dispositivo**: toda requisição do MATLAB precisa do header `X-Device-Key`, que é comparado em tempo constante.
- **Log de toda requisição**: timestamp, IP, rota, duração e status.
- **Bancos acessíveis só pelo próprio computador**: as portas estão publicadas em `127.0.0.1`.
- **Segredos fora do Git**: os `.env` estão no `.gitignore`. Nunca commite um `.env`.

---

## Problemas comuns

| Sintoma | Causa / solução |
|---|---|
| `permission denied` ao usar `docker` | Seu usuário ainda não está no grupo `docker` desta sessão. Saia da sessão e entre de novo, ou rode `newgrp docker`. |
| `address already in use` na porta 5432 | Já existe um PostgreSQL instalado no sistema. Use `DB_PORT=5433` nos dois `.env`. |
| `docker compose` não acha o `.env` | Rode os comandos do Docker na **raiz** do repositório, não dentro de `backend/`. |
| `ls` não mostra o `.env` | Arquivos com `.` no início ficam ocultos. Use `ls -a`. |
| Backend não inicia: `ENCRYPTION_KEY inválida` | Gere a chave (passo 4 da instalação). |
| `/api/health` com `influxdb: indisponível` | O container está parado (`docker compose up -d`) ou o `INFLUX_TOKEN` está errado. |
| Simulador recebe `503` logo após subir os bancos | O InfluxDB ainda está iniciando. Espere alguns segundos. |
| Simulador recebe `401` | A `DEVICE_KEY` do `backend/.env` mudou e o backend não foi reiniciado. |
| RTT perto de 1 s | Falta `--wal-flush-interval=100ms` no `docker-compose.yml`. Rode `docker compose up -d` para aplicar. |

---

## Regras do repositório

- Antes de commitar, rode `git status` e confira que nenhum `.env` nem `node_modules/` aparece.
- Commits pequenos, um por funcionalidade, com mensagem descrevendo o que mudou.
- Uso de IA generativa: o relatório precisa citar o link das conversas usadas, como pede o PDF de SCOM.
