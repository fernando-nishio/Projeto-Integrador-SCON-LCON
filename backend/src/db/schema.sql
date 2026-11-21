-- Esquema do banco do Projeto Integrador (PostgreSQL)
-- Baseado na "estrutura mínima recomendada" da atividade de SCOM.

-- Usuários do site. A senha é guardada apenas como hash (bcrypt).
CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    username      VARCHAR(50)  NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role          VARCHAR(10)  NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Leituras enviadas pelo ESP32. O valor é criptografado (AES-256-GCM) antes de gravar.
CREATE TABLE IF NOT EXISTS readings (
    id              BIGSERIAL PRIMARY KEY,
    timestamp       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    variable_name   VARCHAR(50)  NOT NULL,
    value_encrypted TEXT         NOT NULL,
    device_id       VARCHAR(50)  NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_readings_time ON readings (timestamp);

-- Comandos/parâmetros enviados pelo site para o ESP32.
CREATE TABLE IF NOT EXISTS commands (
    id           SERIAL PRIMARY KEY,
    timestamp    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    command_name VARCHAR(50) NOT NULL,
    value        TEXT        NOT NULL,
    status       VARCHAR(15) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
    user_id      INTEGER     REFERENCES users(id)
);

-- Log de todas as interações (dados recebidos, comandos, logins, erros).
CREATE TABLE IF NOT EXISTS logs (
    id          BIGSERIAL PRIMARY KEY,
    timestamp   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    event_type  VARCHAR(30) NOT NULL,
    description TEXT,
    ip          VARCHAR(45),
    status      INTEGER,
    user_id     INTEGER REFERENCES users(id)  -- pode ser NULL (ex.: requisição do ESP)
);
CREATE INDEX IF NOT EXISTS idx_logs_time ON logs (timestamp);
