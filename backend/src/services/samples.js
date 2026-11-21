// Validação dos lotes de amostras vindos do MATLAB e conversão para line protocol.
// Fica separado da rota para poder ser testado sem subir o servidor.
import { encrypt } from './crypto.js';

export const MEASUREMENT = 'planta';  // "tabela" no InfluxDB
const MAX_SAMPLES = 1000;             // por requisição (1 s a 100 Hz = 100 amostras)
const DEVICE_RE = /^[A-Za-z0-9_-]{1,50}$/;          // vira tag: sem espaço, vírgula ou "="
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,49}$/;    // nomes de variáveis seguros
const RESERVED = new Set(['t', 'time', 'device']);

/*
  Formato do lote:
  {
    "device_id": "LTR701_MATLAB",
    "samples": [
      { "t": 1763740000123.4, "temp": 31.42, "setpoint": 35, "erro": 3.58, "u": 4.1, "enabled": 1 },
      ...
    ]
  }
  t = instante da amostra em milissegundos desde 1970 (UTC). Cada amostra precisa do seu,
  senão amostras com o mesmo instante se sobrescreveriam no InfluxDB.
*/
export function validarLote(body) {
  const { device_id, samples } = body ?? {};
  if (typeof device_id !== 'string' || !DEVICE_RE.test(device_id)) {
    return 'device_id deve ter de 1 a 50 caracteres: letras, números, "_" ou "-"';
  }
  if (!Array.isArray(samples) || samples.length === 0 || samples.length > MAX_SAMPLES) {
    return `samples deve ser uma lista com 1 a ${MAX_SAMPLES} amostras`;
  }
  for (const [i, s] of samples.entries()) {
    if (!s || typeof s !== 'object' || !Number.isFinite(s.t) || s.t <= 0) {
      return `amostra ${i}: "t" (milissegundos desde 1970) é obrigatório`;
    }
    const vars = Object.entries(s).filter(([k]) => k !== 't');
    if (vars.length === 0) return `amostra ${i}: nenhuma variável além de "t"`;
    for (const [k, v] of vars) {
      if (!FIELD_RE.test(k) || RESERVED.has(k)) return `amostra ${i}: nome de variável inválido "${k}"`;
      if (!Number.isFinite(v)) return `amostra ${i}: "${k}" precisa ser um número`;
    }
  }
  return null; // tudo certo
}

// Uma amostra vira uma linha de line protocol, com cada valor criptografado:
//   planta,device=LTR701_MATLAB temp="iv:tag:cifrado",u="iv:tag:cifrado" 1763740000123400000
//   └medição┘ └──── tag ───────┘ └──────────── campos (string) ──────────┘ └ timestamp (ns) ┘
export function amostraParaLinha(deviceId, { t, ...vars }) {
  const campos = Object.entries(vars)
    .map(([k, v]) => `${k}="${encrypt(v)}"`) // base64 e ":" não precisam de escape dentro de aspas
    .join(',');
  const ns = BigInt(Math.round(t * 1000)) * 1000n; // ms → µs (arredonda) → ns
  return `${MEASUREMENT},device=${deviceId} ${campos} ${ns}`;
}
