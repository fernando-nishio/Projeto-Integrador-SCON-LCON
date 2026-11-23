package main

// Grava eventos na tabela logs. Descrição e IP são criptografados antes de gravar
// (o PDF exige que logs também sejam armazenados cifrados). event_type, status e
// timestamp ficam em claro para permitir filtrar.

import (
	"context"
	"fmt"
	"os"
)

type logEntry struct {
	EventType   string
	Description string // "" vira NULL
	IP          string // "" vira NULL
	Status      int    // 0 vira NULL
	UserID      *int64 // nil vira NULL (ex.: requisição do MATLAB)
}

// logEvent nunca derruba quem chamou: se falhar, só avisa no console.
func (a *App) logEvent(ctx context.Context, e logEntry) {
	var desc, ip, status any // nil = NULL no banco
	if e.Description != "" {
		desc = a.crypt.Encrypt(e.Description)
	}
	if e.IP != "" {
		ip = a.crypt.Encrypt(e.IP)
	}
	if e.Status != 0 {
		status = e.Status
	}
	_, err := a.db.Exec(ctx,
		`INSERT INTO logs (event_type, description, ip, status, user_id) VALUES ($1, $2, $3, $4, $5)`,
		e.EventType, desc, ip, status, e.UserID)
	if err != nil {
		fmt.Fprintln(os.Stderr, "[log] falha ao gravar log:", err)
	}
}
