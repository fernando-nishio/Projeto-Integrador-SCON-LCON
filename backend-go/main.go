// Backend do Projeto Integrador SCOM/LCON-I, em Go.
//
// Um único programa com três modos:
//
//	backend            -> inicia o servidor HTTP (API)
//	backend setup      -> gera/completa o .env e a configuração dos containers
//	backend comando X V -> grava um comando para o MATLAB (ex.: comando setpoint 40)
//
// Todos os arquivos .go desta pasta pertencem ao mesmo pacote "main": o Go os
// compila juntos, então uma função definida em crypto.go pode ser usada aqui
// sem import.
package main

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"time"
)

func main() {
	// "setup" roda antes de existir um .env completo, então vem primeiro
	if len(os.Args) > 1 && os.Args[1] == "setup" {
		os.Exit(runSetup())
	}

	// Carrega o .env (padrão: ../.env, o da raiz do repositório quando se roda
	// dentro de backend-go/; no Docker, ENV_FILE=/config/app.env).
	envFile := getenv("ENV_FILE", "../.env")
	if err := loadEnvFile(envFile); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			fmt.Fprintf(os.Stderr, "[aviso] %s não encontrado; usando só as variáveis de ambiente\n", envFile)
		} else {
			fatal("não foi possível ler %s: %v", envFile, err)
		}
	}

	cfg, err := loadConfig()
	if err != nil {
		fatal("%v", err)
	}

	ctx := context.Background()
	app, err := newApp(ctx, cfg)
	if err != nil {
		fatal("%v", err)
	}
	defer app.db.Close()

	if len(os.Args) > 1 && os.Args[1] == "comando" {
		os.Exit(app.runComando(ctx, os.Args[2:]))
	}

	// Garante as tabelas antes de aceitar requisições
	if err := app.aplicarSchema(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "[inicio] não foi possível preparar o PostgreSQL:", err)
		fmt.Fprintln(os.Stderr, "         Os bancos estão no ar? (docker compose up -d)")
		os.Exit(1)
	}

	addr := net.JoinHostPort(cfg.Host, cfg.Port)
	srv := &http.Server{
		Addr:              addr,
		Handler:           app.routes(),
		ReadHeaderTimeout: 5 * time.Second, // protege contra conexões que nunca terminam de enviar
	}
	fmt.Printf("Backend rodando em http://localhost:%s\n", cfg.Port)
	if err := srv.ListenAndServe(); err != nil {
		fatal("servidor parou: %v", err)
	}
}

func fatal(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "[erro] "+format+"\n", args...)
	os.Exit(1)
}
