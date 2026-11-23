// Todas as chamadas à API do backend ficam aqui.
//
// A sessão de login viaja num cookie HttpOnly que o próprio navegador envia;
// o JavaScript nunca vê o token (mais seguro contra roubo por XSS).

let aoExpirarSessao = () => {};

// O App registra o que fazer quando a sessão expira (voltar para o login)
export function quandoSessaoExpirar(fn) {
  aoExpirarSessao = fn;
}

async function request(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    // resposta sem corpo JSON
  }

  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) aoExpirarSessao();
    const err = new Error(data?.message || `Erro ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  // login
  setup: () => request('GET', '/auth/setup'),
  me: () => request('GET', '/auth/me'),
  login: (username, password) => request('POST', '/auth/login', { username, password }),
  logout: () => request('POST', '/auth/logout'),

  // usuários e logs (admin)
  users: () => request('GET', '/users'),
  createUser: (username, password, role) => request('POST', '/users', { username, password, role }),
  logs: (limit = 100) => request('GET', `/logs?limit=${limit}`),

  // planta
  status: () => request('GET', '/status'),
  latest: (limit = 20) => request('GET', `/data/latest?limit=${limit}`),
  send: (name, value) => request('POST', '/send', { name, value }),
};

// O InfluxDB devolve o horário em UTC sem o "Z" e com 6 casas nos segundos
// (2026-11-21T17:15:24.486791). Normaliza para milissegundos.
export function parseTime(valor) {
  if (typeof valor === 'number') return valor;
  let s = String(valor).replace(/(\.\d{3})\d+/, '$1');
  if (!/[zZ]|[+-]\d\d:?\d\d$/.test(s)) s += 'Z';
  return Date.parse(s);
}

// Converte uma linha do /api/data/latest para o mesmo formato das amostras do tempo real
export function linhaParaAmostra(row) {
  return {
    t: parseTime(row.time),
    temp: row.temp,
    setpoint: row.setpoint,
    erro: row.erro,
    u: row.u,
    enabled: row.enabled,
  };
}
