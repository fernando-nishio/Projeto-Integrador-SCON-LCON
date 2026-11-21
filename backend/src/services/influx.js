// Comunicação com o InfluxDB 3 Core pela API HTTP dele (sem biblioteca extra:
// usa o fetch que já vem no Node).
//
//   escrita:  POST /api/v3/write_lp   (corpo em "line protocol", uma linha por ponto)
//   leitura:  GET  /api/v3/query_sql  (consulta SQL, resposta em JSON)
const BASE = process.env.INFLUX_URL;
const DB = process.env.INFLUX_DB;
const AUTH = { Authorization: `Bearer ${process.env.INFLUX_TOKEN}` };

class InfluxError extends Error {
  constructor(status, body) {
    super(`InfluxDB respondeu ${status}: ${body}`);
    this.status = status;
  }
}

// Grava várias linhas de line protocol numa única requisição.
// precision=nanosecond: o timestamp no fim de cada linha está em nanossegundos.
export async function writeLines(lines) {
  const url = new URL('/api/v3/write_lp', BASE);
  url.searchParams.set('db', DB);
  url.searchParams.set('precision', 'nanosecond');

  const res = await fetch(url, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'text/plain; charset=utf-8' },
    body: lines.join('\n'),
  });
  if (!res.ok) throw new InfluxError(res.status, await res.text());
}

// Executa uma consulta SQL e devolve um array de objetos (uma linha = um objeto).
export async function querySql(sql) {
  const url = new URL('/api/v3/query_sql', BASE);
  url.searchParams.set('db', DB);
  url.searchParams.set('q', sql);
  url.searchParams.set('format', 'json');

  const res = await fetch(url, { headers: AUTH });
  if (!res.ok) throw new InfluxError(res.status, await res.text());
  return res.json();
}

// Usado pelo /api/health
export async function influxHealthy() {
  try {
    const res = await fetch(new URL('/health', BASE), { headers: AUTH });
    return res.ok;
  } catch {
    return false;
  }
}
