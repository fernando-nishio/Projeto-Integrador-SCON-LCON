package main

// Comandos do site para o MATLAB. Conforme o PDF de LCON-I, o MATLAB recebe apenas:
//
//	enabled  -> 1 liga o controle; 0 desliga e zera a parcela integral
//	setpoint -> temperatura desejada em °C
//
// (os ganhos Kp e Ki NÃO são enviados ao MATLAB; ficam no próprio script)

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Estado inicial seguro: controle desligado
var comandosPadrao = map[string]float64{"enabled": 0, "setpoint": 25}

// validarComando devolve "" se estiver tudo certo, ou a mensagem de erro.
func validarComando(name string, v float64) string {
	switch name {
	case "enabled":
		if v != 0 && v != 1 {
			return "enabled deve ser 0 ou 1"
		}
	case "setpoint":
		if v <= 0 || v >= 100 {
			return "setpoint deve estar entre 0 e 100 °C"
		}
	default:
		return fmt.Sprintf(`comando desconhecido "%s" (use: enabled, setpoint)`, name)
	}
	return ""
}

// addCommand grava um comando (valor cifrado). userID nil = enviado pelo terminal.
func (a *App) addCommand(ctx context.Context, name string, v float64, userID *int64) (int64, error) {
	if msg := validarComando(name, v); msg != "" {
		return 0, fmt.Errorf("%s", msg)
	}
	var id int64
	err := a.db.QueryRow(ctx,
		`INSERT INTO commands (command_name, value, user_id) VALUES ($1, $2, $3) RETURNING id`,
		name, a.crypt.Encrypt(formatNum(v)), userID,
	).Scan(&id)
	return id, err
}

// getCommandState devolve o último valor de cada comando. O MATLAB recebe o estado
// completo a cada consulta (e não só "o que mudou"): se um pacote se perder, o
// próximo já corrige.
func (a *App) getCommandState(ctx context.Context) (map[string]float64, error) {
	nomes := make([]string, 0, len(comandosPadrao))
	state := make(map[string]float64, len(comandosPadrao))
	for k, v := range comandosPadrao {
		nomes = append(nomes, k)
		state[k] = v
	}

	rows, err := a.db.Query(ctx,
		`SELECT DISTINCT ON (command_name) command_name, value
		   FROM commands
		  WHERE command_name = ANY($1)
		  ORDER BY command_name, id DESC`, nomes)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var name, enc string
		if err := rows.Scan(&name, &enc); err != nil {
			return nil, err
		}
		plain, err := a.crypt.Decrypt(enc)
		if err != nil {
			return nil, err
		}
		if state[name], err = strconv.ParseFloat(plain, 64); err != nil {
			return nil, err
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Os comandos pendentes acabaram de ser entregues ao dispositivo
	_, err = a.db.Exec(ctx, `UPDATE commands SET status = 'delivered' WHERE status = 'pending'`)
	return state, err
}

// runComando implementa "backend comando <nome> <valor>" (equivalente ao usuario.py
// do professor). Serve para testar antes de existir o formulário do site.
func (a *App) runComando(ctx context.Context, args []string) int {
	if len(args) != 2 {
		fmt.Fprintln(os.Stderr, "uso: comando <enabled|setpoint> <valor>   (ex.: comando setpoint 40)")
		return 2
	}
	name := args[0]
	v, err := strconv.ParseFloat(strings.Replace(args[1], ",", ".", 1), 64)
	if err != nil {
		fmt.Fprintln(os.Stderr, "Erro: o valor precisa ser um número")
		return 1
	}
	id, err := a.addCommand(ctx, name, v, nil)
	if err != nil {
		fmt.Fprintln(os.Stderr, "Erro:", err)
		return 1
	}
	a.logEvent(ctx, logEntry{EventType: "command_sent", Description: fmt.Sprintf("%s=%s (via terminal)", name, formatNum(v))})
	fmt.Printf("Comando #%d gravado: %s = %s\n", id, name, formatNum(v))
	return 0
}
