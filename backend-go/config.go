package main

import (
	"bufio"
	"encoding/hex"
	"errors"
	"net"
	"net/url"
	"os"
	"strings"
)

// Config reúne tudo o que vem do .env.
type Config struct {
	DatabaseURL   string // endereço completo do PostgreSQL
	InfluxURL     string
	InfluxDB      string
	InfluxToken   string
	DeviceKey     string
	EncryptionKey []byte // 32 bytes (AES-256)
	JWTSecret     []byte // chave que assina as sessões de login
	Host          string
	Port          string
}

// getenv devolve a variável de ambiente ou um valor padrão.
func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// loadEnvFile lê um arquivo KEY=VALOR e define as variáveis que AINDA NÃO existem.
// Variáveis já definidas têm prioridade (é assim que o docker-compose.yml troca
// DB_HOST=localhost por DB_HOST=db dentro do container). Mesmo comportamento do
// "node --env-file" da versão anterior.
func loadEnvFile(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		if _, exists := os.LookupEnv(key); !exists {
			os.Setenv(key, strings.TrimSpace(value))
		}
	}
	return sc.Err()
}

// loadConfig valida e monta a configuração. Falha logo no início se algo
// essencial estiver errado, em vez de falhar no meio de uma requisição.
func loadConfig() (*Config, error) {
	key, err := hex.DecodeString(os.Getenv("ENCRYPTION_KEY"))
	if err != nil || len(key) != 32 {
		return nil, errors.New("ENCRYPTION_KEY inválida no .env: precisa ter 64 caracteres hexadecimais (32 bytes). " +
			"Rode o setup (docker compose up) para gerar uma")
	}
	if os.Getenv("DEVICE_KEY") == "" {
		return nil, errors.New("DEVICE_KEY vazia no .env")
	}
	jwt := os.Getenv("JWT_SECRET")
	if len(jwt) < 32 || strings.HasPrefix(jwt, "troque_") {
		return nil, errors.New("JWT_SECRET ausente ou curta no .env (mínimo 32 caracteres). " +
			"Rode o setup (docker compose up) para gerar uma")
	}

	// postgres://usuario:senha@host:porta/banco?sslmode=disable
	// url.UserPassword escapa caracteres especiais da senha automaticamente.
	db := url.URL{
		Scheme:   "postgres",
		User:     url.UserPassword(getenv("DB_USER", "pi_user"), os.Getenv("DB_PASSWORD")),
		Host:     net.JoinHostPort(getenv("DB_HOST", "localhost"), getenv("DB_PORT", "5433")),
		Path:     "/" + getenv("DB_NAME", "projeto_integrador"),
		RawQuery: "sslmode=disable", // banco local, sem TLS
	}

	return &Config{
		DatabaseURL:   db.String(),
		InfluxURL:     getenv("INFLUX_URL", "http://localhost:8181"),
		InfluxDB:      getenv("INFLUX_DB", "planta"),
		InfluxToken:   os.Getenv("INFLUX_TOKEN"),
		DeviceKey:     os.Getenv("DEVICE_KEY"),
		EncryptionKey: key,
		JWTSecret:     []byte(jwt),
		// Fora do Docker: só localhost (o MATLAB roda no mesmo computador).
		// No Docker, HOST=0.0.0.0 vem do docker-compose.yml.
		Host: getenv("HOST", "127.0.0.1"),
		Port: getenv("PORT", "3000"),
	}, nil
}
