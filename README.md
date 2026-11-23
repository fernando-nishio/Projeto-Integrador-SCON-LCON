# Projeto Integrador SCOM / LCON-I

Sistema web para **monitorar e controlar remotamente o soprador térmico (kit LTR701)** da UNESP Sorocaba.

O MATLAB roda o controle PI da temperatura a 100 Hz e troca dados com um backend em **Go** por HTTP. O backend guarda tudo **criptografado** e vai servir o dashboard do site.

**Para rodar do zero, só é preciso o Docker:**
```bash
docker compose up -d --build
```

---

## Sumário
- [Situação atual](#situação-atual)
- [Arquitetura](#arquitetura)
- [Estrutura do repositório](#estrutura-do-repositório)
- [Pré-requisitos](#pré-requisitos)
- [Subir tudo do zero](#subir-tudo-do-zero)
- [Rodar no Windows (Docker Desktop)](#rodar-no-windows-docker-desktop)
- [Como usar no dia a dia](#como-usar-no-dia-a-dia)
- [Desenvolver o backend fora do Docker](#desenvolver-o-backend-fora-do-docker)
- [Testar sem o kit](#testar-sem-o-kit)
- [Usar com o kit LTR701](#usar-com-o-kit-ltr701)
- [API](#api)
- [Segurança](#segurança)
- [Uso de memória e disco](#uso-de-memória-e-disco)
- [Problemas comuns](#problemas-comuns)
- [Regras do repositório](#regras-do-repositório)

---

## Situação atual

| Parte | Estado |
|---|---|
| Tudo sobe com `docker compose up` (bancos + backend + configuração automática) | ✅ |
| Backend reescrito em Go (imagem `FROM scratch`, ~10 MB) | ✅ funcionando (5,5 MB de RAM em uso) |
| Backend: receber dados da planta (`POST /api/data`) | ✅ funcionando |
| Backend: comandos para o MATLAB (`enabled`, `setpoint`) | ✅ funcionando (enviados pelo terminal) |
| Criptografia AES-256-GCM de leituras, comandos e logs | ✅ funcionando |
| Log de toda requisição (timestamp, IP, status) | ✅ funcionando |
| Simulador da planta em Python | ✅ funcionando |
| Script MATLAB (`cliente_planta.m`) com o kit real, a partir do script de LCON-I | ⚠️ escrito, falta testar no laboratório |
| Login, níveis de acesso admin/usuário, `POST /api/send` | ⏳ próximo passo |
| Frontend: formulário + dashboard em tempo real | ⏳ a fazer |
| Simulação no site ("sombra digital") | ⏳ a fazer |
| Backup diário e restauração | ⏳ a fazer |
| Estatística descritiva (média, variância, curtose, outliers) | ⏳ a fazer |

Medições de desempenho já feitas (simulador → backend → InfluxDB, mesmo computador):

| Configuração | RTT médio | Observação |
|---|---|---|
| WAL do InfluxDB a cada 1 s (padrão) | ~825 ms | a escrita esperava a próxima gravação do WAL |
| WAL a cada 100 ms, backend antigo em Node.js | ~81 ms | `--wal-flush-interval=100ms` no `docker-compose.yml` |
| WAL a cada 100 ms, backend em Go (atual) | ~57 ms | 0% de perda em 43 lotes |
| Escrita sem esperar o WAL (`no_sync`) | ~9 ms | só para comparação, não usado |

---

## Arquitetura

```
 Kit LTR701 ⇄ NI-USB-6003 ⇄ MATLAB  (PI a 100 Hz, filtro, saturação 0–10 V)
                              │
                              │  HTTP, 1 lote por segundo (amostras a 10 Hz)
                              │  POST /api/data  →  resposta traz { enabled, setpoint }
                              ▼
 ┌──────────────────────────── Docker ─────────────────────────────┐
 │              backend: Go, imagem FROM scratch (3000)            │
 │                    │                        │                   │
 │                    ▼                        ▼                   │
 │       influxdb: InfluxDB 3 (8181)    db: PostgreSQL 16 (5433)   │
 │       séries temporais cifradas:     usuários, comandos, logs   │
 │       temp, setpoint, erro, u        (cifrados)                 │
 │                                                                 │
 │  setup: gera .env, senhas, chaves e token (roda e termina)      │
 └─────────────────────────────────────────────────────────────────┘
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
├── docker-compose.yml          # setup + PostgreSQL + InfluxDB + backend
├── .env.example                # modelo de configuração (o .env é gerado a partir dele)
├── .env                        # (gerado, não versionado) senhas e chaves deste computador
├── backend-go/                 # API em Go — ver backend-go/README.md (guia arquivo por arquivo)
│   ├── Dockerfile              # compila com golang:alpine, roda em FROM scratch
│   ├── main.go                 # modos: servidor, setup, comando
│   ├── handlers.go             # rotas da API
│   ├── crypto.go, influx.go, samples.go, commands.go, logger.go, middleware.go, ...
│   ├── schema.sql              # tabelas do Postgres (embutido no binário)
│   └── backend_test.go         # testes automáticos
├── firmware/matlab/
│   └── cliente_planta.m        # controle PI + comunicação com o backend
├── simulacao/
│   └── planta_simulada.py      # imita o MATLAB + planta, para testar sem o kit
├── frontend/                   # (a fazer)
└── docs/                       # diagramas e material do relatório
```

---

## Pré-requisitos

| Ferramenta | Obrigatório? | Para quê |
|---|---|---|
| Docker + Docker Compose v2 | **sim** | bancos e backend |
| Python 3 (≥ 3.8) | para o simulador | simular a planta sem o kit (só biblioteca padrão) |
| MATLAB (R2015a+, com `webwrite`) | para a planta | cliente da planta |
| Go (≥ 1.24) | não (opcional) | desenvolver o backend fora do Docker — a compilação normal acontece dentro do Docker |

Funciona em Linux, Windows e macOS. Os comandos abaixo são para **Ubuntu**; para Windows, veja [Rodar no Windows](#rodar-no-windows-docker-desktop).

Instalar o Docker no Ubuntu 22.04:
```bash
sudo apt update
sudo apt install docker.io docker-compose-v2
sudo usermod -aG docker $USER     # depois: sair da sessão e entrar de novo
docker run hello-world            # teste
```

---

## Subir tudo do zero

Na raiz do repositório:
```bash
docker compose up -d --build
```

O que acontece, na ordem:
1. **`setup`** cria o `.env` a partir do `.env.example`, gerando senha do banco, chave de criptografia, chave do dispositivo, segredo JWT e token do InfluxDB. Se o `.env` já existe, **mantém o que já foi definido** e só completa o que falta. Depois, copia a configuração para um volume interno que os outros containers leem, e termina.
2. **`db`** (PostgreSQL) e **`influxdb`** sobem já com a senha e o token gerados.
3. **`backend`** espera o PostgreSQL ficar pronto, cria as tabelas e começa a aceitar requisições.

Para conferir:
```bash
docker compose ps                        # db, influxdb e backend "running"; setup "exited (0)"
curl localhost:3000/api/health           # {"status":"ok","postgres":"ok","influxdb":"ok",...}
```

A primeira vez demora mais, porque baixa as imagens e monta a do backend. Nas próximas, é só `docker compose up -d`.

> ⚠️ **Não apague nem troque a `ENCRYPTION_KEY` do `.env`.** Sem ela, os dados já gravados não podem mais ser lidos. Cada computador gera a sua, então os dados de um não abrem no outro.

---

## Rodar no Windows (Docker Desktop)

O projeto roda igual no Windows: tudo fica dentro do Docker. O caso típico é o **computador do laboratório**, com MATLAB e a NI-USB-6003.

**1. Instalar**
- **Docker Desktop**: https://www.docker.com/products/docker-desktop/. Na instalação, deixe marcada a opção **"Use WSL 2"**. Se o Windows pedir para instalar ou atualizar o WSL, aceite e reinicie. Depois, abra o Docker Desktop e espere aparecer **"Engine running"** no canto inferior esquerdo.
- **Git**: https://git-scm.com/download/win. As opções padrão servem.
- **Python 3**, só para o simulador: https://www.python.org/downloads/. Marque **"Add python.exe to PATH"**.

**2. Baixar o projeto** (no **PowerShell**)
```powershell
cd $HOME\Documents
git clone https://github.com/fernando-nishio/Projeto-Integrador-SCON-LCOM.git
cd Projeto-Integrador-SCON-LCOM
```

**3. Subir tudo**: são os mesmos comandos do Linux.
```powershell
docker compose up -d --build
docker compose ps
curl.exe http://localhost:3000/api/health
```
Use `curl.exe`, e não `curl`, porque no PowerShell `curl` é outro comando. Ou abra http://localhost:3000/api/health no navegador. O `.env` é criado na pasta do projeto, como no Linux.

**4. Usar**
```powershell
docker compose exec backend /backend comando setpoint 40
docker compose exec backend /backend comando enabled 1
python simulacao\planta_simulada.py            # simulador (ou "py" no lugar de "python")
```
No MATLAB:
```matlab
cd(fullfile(getenv('USERPROFILE'), 'Documents', 'Projeto-Integrador-SCON-LCOM', 'firmware', 'matlab'))
cliente_planta
```

**5. Testes do backend** (o `-u` do Linux não é necessário no Windows):
```powershell
docker run --rm -v "${PWD}\backend-go:/src" -w /src golang:1.25-alpine sh -c "go mod tidy && go test -v ./..."
```

**Diferenças e cuidados no Windows**
- **Docker Desktop precisa estar aberto.** Sem ele, os comandos `docker` dão erro de conexão (`error during connect` / `pipe`).
- **Finais de linha**: o arquivo `.gitattributes` do repositório força o formato do Linux (LF) em todos os arquivos de texto, então o clone no Windows funciona sem ajustes.
- **Memória**: o Docker Desktop roda uma pequena máquina virtual (WSL 2), que pode reservar bastante RAM. Para limitar, crie `C:\Users\SEU_USUARIO\.wslconfig` com as linhas abaixo e rode `wsl --shutdown`. Os containers do projeto usam ~60 MB no total.
  ```ini
  [wsl2]
  memory=2GB
  ```
- **Firewall**: como tudo é acessado por `localhost`, não é preciso liberar portas.
- **Porta ocupada** (`address already in use`): veja quem usa a porta com `netstat -ano | findstr :3000` e feche o programa, ou troque a porta no `.env`.

---

## Como usar no dia a dia

**Ligar e desligar**
```bash
docker compose up -d        # liga tudo (bancos + backend)
docker compose stop         # desliga (os dados ficam guardados)
docker compose logs -f backend   # acompanhar o log do backend (Ctrl+C sai do log)
```

**A planta** (escolha uma das opções)
```bash
python3 simulacao/planta_simulada.py           # simulador em Python
```
```matlab
% ou no MATLAB:
cd ~/Projeto_Integrador/Projeto-Integrador-SCON-LCOM/firmware/matlab
cliente_planta
```
Os dois leem a `DEVICE_KEY` do `.env` da raiz automaticamente.

**Comandos** (fazem o papel do site por enquanto)
```bash
docker compose exec backend /backend comando setpoint 40     # entre 0 e 100 °C
docker compose exec backend /backend comando enabled 1       # liga o controle
docker compose exec backend /backend comando enabled 0       # desliga e zera a integral
```

**Ver os dados**
- No navegador: http://localhost:3000/api/data/latest?limit=5 mostra as últimas amostras, já decifradas.
- Os logs, direto no banco:
  ```bash
  docker exec -it pi_postgres psql -U pi_user -d projeto_integrador \
    -c "SELECT id, timestamp, event_type, status FROM logs ORDER BY id DESC LIMIT 10;"
  ```

> Abrir só `http://localhost:3000/` mostra "Rota não encontrada". Isso é normal, porque ainda não há site, só a API em `/api/...`.

**Depois de mudar o código do backend**
```bash
docker compose up -d --build backend
```

**Apagar tudo e recomeçar do zero** (⚠️ apaga todos os dados):
```bash
docker compose down -v      # remove containers e volumes
rm .env                     # opcional: gera novas senhas/chaves
docker compose up -d --build
```

---

## Desenvolver o backend fora do Docker

Só é preciso para quem tiver o Go instalado. Sem ele, use o fluxo normal (`docker compose up -d --build backend` depois de cada mudança). Os bancos continuam no Docker:
```bash
docker compose up -d db influxdb     # sobe só os bancos (o setup roda junto)
docker compose stop backend          # libera a porta 3000, se o container estiver ligado
cd backend-go
go run .                             # sobe a API (lê o .env da raiz)
go run . comando setpoint 40         # envia comando
```

**Testes automáticos sem ter Go instalado** (também gera o `go.sum`, que deve ser commitado):
```bash
docker run --rm -u "$(id -u):$(id -g)" -e GOCACHE=/tmp/gocache -e GOMODCACHE=/tmp/gomod \
  -v "$PWD/backend-go":/src -w /src golang:1.25-alpine sh -c "go mod tidy && go test -v ./..."
```

---

## Testar sem o kit

O `simulacao/planta_simulada.py` faz exatamente o que o MATLAB faz:
- PI a 100 Hz;
- sensor com ruído e filtro passa-baixa;
- saturação de 0 a 10 V;
- amostras a 10 Hz enviadas em lote a cada 1 s.

O controlador e o filtro usam os mesmos valores do kit real (Kp = 1,1, Ki = 0,4, saturação em 9,5 V). A **planta** ainda é o exemplo do professor: dT/dt = −0,4·(T − 25) + 2·u, ou seja, G(s) = 2/(s+0,4). **Troque pela função de transferência do kit** obtida em LCON-I (no simulador e no modo `SIMULACAO` do `cliente_planta.m`).

Resultado esperado com `setpoint 40` e `enabled 1`: a temperatura sobe de 25 para ~40 °C em ~3 s, com u ≈ 3 V em regime (25 + 5·3 = 40). Ao parar com Ctrl+C, o simulador mostra a perda de pacotes e o RTT.

---

## Usar com o kit LTR701

O `firmware/matlab/cliente_planta.m` já tem a parte de hardware, feita a partir do script de LCON-I do grupo (`script09`):

| Item | Valor |
|---|---|
| Placa | NI-USB-6003, **encontrada automaticamente** (normalmente `Dev4`) |
| Sensor | SENSOR 2 em `ai0`, modo single-ended |
| Aquecedor (ACTUATOR 2) | `ao0`, de 0 a **9,5 V** (saturação) |
| Ventilador (ACTUATOR 1) | `ao1`, fixo em **2,5 V** enquanto o script roda |
| Conversão | T [°C] = 10,29 · V + 0,34 |
| Filtro | passa-baixa de 1ª ordem, τ = 0,0127 s (fc = 12,5 Hz), discretizado por Tustin |
| Controlador | PI com Kp = 1,1 e Ki = 0,4, a 100 Hz; as 6 primeiras amostras ficam sem controle (filtro estabilizando) |

**Para rodar no laboratório:**
1. Confira os seletores dos atuadores 1 e 2 em **OFF** e as ligações com a placa.
2. Suba o backend (`docker compose up -d`).
3. No MATLAB, vá até `firmware/matlab` e rode `cliente_planta`. Ele mostra qual placa encontrou.
4. Ligue o controle pelo site ou pelo terminal (`docker compose exec backend /backend comando enabled 1`).
5. Ao parar com Ctrl+C, aquecedor e ventilador são **desligados automaticamente**.

**Se o nome da placa mudar** (por exemplo, `Dev2`), não precisa fazer nada: o script procura a USB-6003 sozinho. Para forçar um nome, use `DEV_ID = "Dev2"` no topo do script.

**Sem o kit:** mude `SIMULACAO = true` no topo do script. Um modelo da planta substitui a placa.

> Para a perturbação de temperatura no kit real, abra ou feche parcialmente a tampa de entrada de ar.

---

## API

Documentação completa das rotas em **[backend-go/README.md](backend-go/README.md)**. Resumo:

| Método | Rota | Autenticação | Descrição |
|---|---|---|---|
| GET | `/api/health` | — | estado do servidor e dos bancos |
| POST | `/api/data` | header `X-Device-Key` | recebe lote de amostras; responde com os comandos |
| GET | `/api/commands` | header `X-Device-Key` | comandos atuais `{ enabled, setpoint }` |
| GET | `/api/data/latest` | *(provisório: aberta)* | últimas amostras decifradas |

---

## Segurança

- **Criptografia AES-256-GCM** antes de gravar:
  - leituras da planta (InfluxDB);
  - valores dos comandos (PostgreSQL);
  - descrição e IP dos logs (PostgreSQL).

  Cada valor tem um IV aleatório, e a tag GCM detecta adulteração no banco.
- **Origem do dispositivo**: toda requisição do MATLAB precisa do header `X-Device-Key`, que é comparado em tempo constante.
- **Log de toda requisição**: timestamp, IP, rota, duração e status.
- **Segredos gerados automaticamente**, com gerador criptográfico. O `.env` tem permissão `600`, só o seu usuário lê.
- **Nada exposto na rede**: todas as portas estão publicadas só em `127.0.0.1`.
- **Backend sem root e sem sistema operacional**: imagem `FROM scratch`, só com o binário, rodando como o usuário `nobody` (UID 65534).
- **Segredos fora do Git**: o `.env` está no `.gitignore`. Nunca commite um `.env`.

---

## Uso de memória e disco

| Container | Limite de RAM | Ajustes |
|---|---|---|
| `db` (postgres:16-alpine) | 160 MB | `shared_buffers=32MB`, `work_mem=2MB`, `max_connections=20` |
| `influxdb` (influxdb:3-core) | 320 MB | pool de consultas 128 MB, buffer 64 MB, sem cache de arquivos, log só de avisos, 50 arquivos de WAL guardados |
| `backend` (Go, `FROM scratch`) | 64 MB | binário estático de ~10 MB; `GOMEMLIMIT=40MiB` |
| `setup` | — | roda alguns segundos e termina |

Além disso:
- Os logs do Docker ficam limitados a 2 arquivos de 5 MB por container.
- As imagens usam Alpine, que é menor.
- O `setup` e o `backend` usam a mesma imagem (o mesmo binário, em modos diferentes).

Para ver o consumo real:
```bash
docker stats --no-stream            # RAM e CPU de cada container
docker system df                    # espaço usado por imagens e volumes
docker image prune                  # apaga imagens antigas que não são mais usadas
```

---

## Problemas comuns

| Sintoma | Causa / solução |
|---|---|
| `permission denied` ao usar `docker` | Seu usuário ainda não está no grupo `docker` desta sessão. Saia da sessão e entre de novo, ou rode `newgrp docker`. |
| `address already in use` (3000, 5433 ou 8181) | Outro programa usa a porta. Para a 3000, provavelmente é um `go run .` aberto, ou o container `backend` está ligado enquanto você roda o backend fora do Docker. |
| `docker compose` não acha o `.env` | Rode os comandos do Docker na **raiz** do repositório. |
| `ls` não mostra o `.env` | Arquivos com `.` no início ficam ocultos. Use `ls -a`. |
| `backend` reiniciando sem parar | Veja o motivo em `docker compose logs backend`. |
| `/api/health` com `influxdb: indisponível` | Veja `docker compose logs influxdb`. Se o volume do InfluxDB foi criado antes do token atual, apague os volumes e recomece (`docker compose down -v`). |
| `password authentication failed` | A senha do `.env` mudou depois que o banco foi criado. Volte a senha antiga, ou recomece com `docker compose down -v`. |
| Simulador recebe `503` logo após subir | O InfluxDB ainda está iniciando. Espere alguns segundos. |
| Simulador recebe `401` | A `DEVICE_KEY` do `.env` mudou e o backend não foi reiniciado (`docker compose restart backend`). |
| RTT perto de 1 s | Falta `--wal-flush-interval=100ms` no `docker-compose.yml`. |

---

## Regras do repositório

- Antes de commitar, rode `git status` e confira que nenhum `.env` nem `node_modules/` aparece.
- Commits pequenos, um por funcionalidade, com mensagem descrevendo o que mudou.
- Uso de IA generativa: o relatório precisa citar o link das conversas usadas, como pede o PDF de SCOM.
