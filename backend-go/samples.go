package main

// Validação dos lotes de amostras vindos do MATLAB e conversão para line protocol.
//
// Formato do lote (JSON):
//
//	{
//	  "device_id": "LTR701_MATLAB",
//	  "samples": [
//	    { "t": 1763740000123.4, "temp": 31.42, "setpoint": 35, "erro": 3.58, "u": 4.1, "enabled": 1 }
//	  ]
//	}
//
// t = instante da amostra em milissegundos desde 1970 (UTC). Cada amostra precisa
// do seu, senão amostras com o mesmo instante se sobrescreveriam no InfluxDB.

import (
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const (
	measurement = "planta" // "tabela" no InfluxDB
	maxSamples  = 1000     // por requisição (1 s a 100 Hz = 100 amostras)
)

var (
	deviceRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,50}$`)         // vira tag: sem espaço, vírgula ou "="
	fieldRe  = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,49}$`) // nomes de variáveis seguros
	reserved = map[string]bool{"t": true, "time": true, "device": true}
)

// Lote é o corpo do POST /api/data. As amostras ficam como mapa porque o nome
// das variáveis é livre (temp, u, erro...). Números JSON chegam como float64.
type Lote struct {
	DeviceID string           `json:"device_id"`
	Samples  []map[string]any `json:"samples"`
}

// validarLote devolve "" se estiver tudo certo, ou a mensagem de erro.
func validarLote(l *Lote) string {
	if !deviceRe.MatchString(l.DeviceID) {
		return `device_id deve ter de 1 a 50 caracteres: letras, números, "_" ou "-"`
	}
	if len(l.Samples) == 0 || len(l.Samples) > maxSamples {
		return fmt.Sprintf("samples deve ser uma lista com 1 a %d amostras", maxSamples)
	}
	for i, s := range l.Samples {
		t, ok := s["t"].(float64)
		if !ok || t <= 0 {
			return fmt.Sprintf(`amostra %d: "t" (milissegundos desde 1970) é obrigatório`, i)
		}
		if len(s) < 2 {
			return fmt.Sprintf(`amostra %d: nenhuma variável além de "t"`, i)
		}
		for k, v := range s {
			if k == "t" {
				continue
			}
			if !fieldRe.MatchString(k) || reserved[k] {
				return fmt.Sprintf(`amostra %d: nome de variável inválido "%s"`, i, k)
			}
			if _, isNum := v.(float64); !isNum {
				return fmt.Sprintf(`amostra %d: "%s" precisa ser um número`, i, k)
			}
		}
	}
	return ""
}

// formatNum escreve o número sem notação científica nem zeros sobrando (31.42, 1, 40).
func formatNum(v float64) string {
	return strconv.FormatFloat(v, 'f', -1, 64)
}

// amostraParaLinha transforma uma amostra numa linha de line protocol, com cada valor cifrado:
//
//	planta,device=LTR701_MATLAB temp="iv:tag:cifrado",u="iv:tag:cifrado" 1763740000123400000
//	└medição┘ └──── tag ───────┘ └──────────── campos (string) ──────────┘ └ timestamp (ns) ┘
func amostraParaLinha(c *Cipher, device string, s map[string]any) string {
	// Ordena os nomes para a linha sair sempre igual (mapas em Go não têm ordem)
	keys := make([]string, 0, len(s))
	for k := range s {
		if k != "t" {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)

	campos := make([]string, len(keys))
	for i, k := range keys {
		// base64 e ":" não precisam de escape dentro de aspas
		campos[i] = k + `="` + c.Encrypt(formatNum(s[k].(float64))) + `"`
	}

	// ms -> µs (arredonda) -> ns. int64 vai até ~9,2e18, sobra espaço (hoje ~1,8e18).
	ns := int64(math.Round(s["t"].(float64)*1000)) * 1000
	return fmt.Sprintf("%s,device=%s %s %d", measurement, device, strings.Join(campos, ","), ns)
}
