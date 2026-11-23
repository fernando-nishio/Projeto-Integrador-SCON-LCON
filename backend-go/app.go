package main

import (
	"context"
	_ "embed"
	"fmt"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// App guarda as "peças" compartilhadas por todas as rotas.
type App struct {
	cfg    *Config
	db     *pgxpool.Pool // conexões com o PostgreSQL (reaproveitadas entre requisições)
	influx *Influx
	crypt  *Cipher
}

func newApp(ctx context.Context, cfg *Config) (*App, error) {
	crypt, err := NewCipher(cfg.EncryptionKey)
	if err != nil {
		return nil, err
	}

	poolCfg, err := pgxpool.ParseConfig(cfg.DatabaseURL)
	if err != nil {
		return nil, fmt.Errorf("configuração do PostgreSQL inválida: %w", err)
	}
	poolCfg.MaxConns = 5 // poucas conexões bastam (e economizam memória no banco)
	pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
	if err != nil {
		return nil, fmt.Errorf("PostgreSQL: %w", err)
	}

	return &App{
		cfg:   cfg,
		db:    pool,
		crypt: crypt,
		influx: &Influx{
			base:   cfg.InfluxURL,
			db:     cfg.InfluxDB,
			token:  cfg.InfluxToken,
			client: &http.Client{Timeout: 5 * time.Second},
		},
	}, nil
}

// O schema.sql é embutido dentro do binário na compilação (go:embed),
// então a imagem final não precisa de nenhum arquivo além do próprio programa.
//
//go:embed schema.sql
var schemaSQL string

// aplicarSchema cria as tabelas. O schema só usa "CREATE ... IF NOT EXISTS",
// então rodar de novo não altera nada.
func (a *App) aplicarSchema(ctx context.Context) error {
	// Sem parâmetros, o pgx usa o protocolo simples, que aceita vários comandos SQL de uma vez
	_, err := a.db.Exec(ctx, schemaSQL)
	return err
}
