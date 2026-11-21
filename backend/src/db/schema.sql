-- Esquema do PostgreSQL do Projeto Integrador.
-- As leituras da planta (séries temporais) ficam no InfluxDB, não aqui.
-- Campos marcados com [cifrado] guardam texto criptografado com AES-256-GCM ("iv:tag:cifrado").

-- Usuários do site. A senha é guardada apenas como hash (bcrypt).
CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    username      VARCHAR(50)  NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role          VARCHAR(10)  NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Comandos enviados pelo site para o MATLAB (flag liga/desliga e setpoint).
CREATE TABLE IF NOT EXISTS commands (
    id           SERIAL PRIMARY KEY,
    timestamp    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    command_name VARCHAR(50) NOT NULL,
    value        TEXT        NOT NULL,                 -- [cifrado]
    status       VARCHAR(15) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
    user_id      INTEGER     REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_commands_name ON commands (command_name, id DESC);

-- Log de todas as interações (dados recebidos, comandos, logins, erros).
-- event_type, status e timestamp ficam em claro para permitir filtrar/auditar;
-- o conteúdo (descrição e IP) fica cifrado.
CREATE TABLE IF NOT EXISTS logs (
    id          BIGSERIAL PRIMARY KEY,
    timestamp   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    event_type  VARCHAR(30) NOT NULL,
    description TEXT,                                  -- [cifrado]
    ip          TEXT,                                  -- [cifrado]
    status      INTEGER,
    user_id     INTEGER REFERENCES users(id)           -- NULL quando a requisição vem do MATLAB
);
CREATE INDEX IF NOT EXISTS idx_logs_time ON logs (timestamp);
