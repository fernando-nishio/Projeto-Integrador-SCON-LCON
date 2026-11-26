// Modelo matemático do soprador térmico LTR701 + o mesmo controle PI do MATLAB.
//
// Planta: 1ª ordem com atraso (FOPDT), entrada u (V no aquecedor), saída T (°C):
//
//                K · e^(−θs)
//     G(s) = ─────────────────        T = T_amb + (resposta de G a u)
//                 τs + 1
//
// Discretizada exatamente (ZOH) no mesmo período do laço do MATLAB (Ts = 10 ms).
// O laço de controle reproduz o cliente_planta.m passo a passo: leitura com ruído,
// filtro passa-baixa de Tustin, PI com integrador de Euler, saturação 0–U_MAX,
// N_AQUEC passos iniciais sem controle e integral zerada quando enabled = 0.
// Assim, o que a simulação mostra é o que o script faria na planta real.
//
// Arquivo sem React: roda no navegador e nos testes (node --test).

export const TS = 0.01; // s — 100 Hz, igual ao MATLAB
export const DECIMACAO = 10; // 1 amostra a cada 10 passos (10 Hz), como no banco

// Planta identificada na Atividade 07 de LCON-I (tfest, 1 polo, ajuste 92,77%):
//     G(s) = 1,387 / (s + 0,2351) = 5,90 / (4,254 s + 1)
// O script02 corta os primeiros 2,2 s do ensaio (partida a frio do aquecedor) antes
// do ajuste, então o modelo oficial NÃO tem atraso: θ = 0. ATRASO_PARTIDA_FRIO guarda
// o valor medido para simular o pior caso.
// T_amb = 24,4 °C: Parte A, aquecedor em 0%. Na Parte A (ventilador a 20%) a
// temperatura sobe ~5,9 °C por volt, o mesmo K do tfest, por isso o modelo é usado
// como desvio em torno da temperatura ambiente.
// Os parâmetros do controlador são os do cliente_planta.m (vindos de LCON-I).
export const ATRASO_PARTIDA_FRIO = 2.2; // s
export const PARAMETROS_PADRAO = Object.freeze({
  K: 5.9, // °C/V — ganho estático (1,387 / 0,2351)
  tau: 4.254, // s — constante de tempo (1 / 0,2351)
  theta: 0, // s — atraso
  Tamb: 24.4, // °C — temperatura ambiente (saída com u = 0)
  Kp: 1.1,
  Ki: 0.4,
  Umax: 9.5, // V — saturação do aquecedor
  nAquec: 6, // passos iniciais sem controle (filtro estabilizando)
  tauFiltro: 0.012732395447352, // s — filtro de 1ª ordem, fc = 12,5 Hz
  ruido: 0.15, // °C — desvio-padrão do ruído de medição (como no modo SIMULACAO)
});

/** Gerador pseudoaleatório com semente (resultados repetíveis) + normal por Box–Muller. */
function geradorNormal(semente = 1) {
  let s = semente >>> 0 || 1;
  const unif = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(unif() || 1e-12)) * Math.cos(2 * Math.PI * unif());
}

/** Valor de um degrau por partes: [{ t, v }] ordenado por t → valor vigente em `t`. */
export function valorEm(degraus, t) {
  let v = degraus[0]?.v ?? 0;
  for (const d of degraus) if (t >= d.t) v = d.v;
  return v;
}

/**
 * Lê degraus escritos como "0:40, 60:50" (tempo em s : valor).
 * @returns {{t:number, v:number}[]} ordenado por tempo
 */
export function lerDegraus(texto) {
  const lista = String(texto)
    .split(/[;,\n]+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const [t, v] = p.split(':').map((x) => Number(x.trim().replace(/\s+/g, '')));
      if (!Number.isFinite(t) || !Number.isFinite(v) || t < 0) throw new Error(`Degrau inválido: "${p}"`);
      return { t, v };
    })
    .sort((a, b) => a.t - b.t);
  if (!lista.length) throw new Error('Informe pelo menos um degrau (ex.: 0:40, 60:50)');
  return lista;
}

/**
 * Simula a planta com o controle do cliente_planta.m.
 *
 * @param {object} p         parâmetros (veja PARAMETROS_PADRAO)
 * @param {object} ensaio
 * @param {number} ensaio.duracao      s
 * @param {'fechada'|'aberta'} [ensaio.malha='fechada']
 *        fechada: degraus = setpoints (°C), PI ligado
 *        aberta:  degraus = tensão no aquecedor (V), sem controle (ensaio de identificação)
 * @param {{t:number,v:number}[]} ensaio.degraus
 * @param {number} [ensaio.T0]          temperatura inicial (padrão: T_amb)
 * @param {number} [ensaio.semente=1]
 * @returns {{t:number, temp:number, Treal:number, setpoint:number|null, erro:number|null,
 *            u:number, enabled:number}[]}  amostras a 10 Hz (t em s)
 */
export function simular(p, { duracao, malha = 'fechada', degraus, T0, semente = 1 }) {
  const Ts = TS;
  const a = Math.exp(-Ts / p.tau);
  const b = p.K * (1 - a);
  const atraso = Math.max(0, Math.round(p.theta / Ts));
  const filaU = new Array(atraso).fill(0); // u atrasado de θ
  const normal = geradorNormal(semente);

  // filtro de Tustin (coeficientes iguais aos do MATLAB)
  const a0 = 1 + (2 * p.tauFiltro) / Ts;
  const a1 = 1 - (2 * p.tauFiltro) / Ts;
  // Diferença do MATLAB: lá as memórias do filtro começam em 0, e a 1ª amostra
  // gravada sai ~1/3,5 da temperatura real (some em ~60 ms). Aqui começam na
  // temperatura inicial, para o gráfico não ter esse pico falso em t = 0.
  const Tini = T0 ?? p.Tamb;
  let xf0 = Tini, xf1 = Tini, yf0 = Tini, yf1 = Tini;

  let x = Tini - p.Tamb; // desvio em relação ao ambiente
  let integral = 0;
  let u = 0;
  const passos = Math.round(duracao / Ts);
  const saida = [];

  for (let k = 0; k <= passos; k++) {
    const t = k * Ts;
    const Treal = p.Tamb + x;

    // 1. leitura (°C) com ruído
    const medida = Treal + p.ruido * normal();
    // 2. filtro
    xf1 = xf0; xf0 = medida;
    yf1 = yf0; yf0 = (xf0 + xf1 - a1 * yf1) / a0;
    const temp = yf0;

    // 3. controle
    let setpoint = null, erro = null, enabled = 0;
    if (malha === 'fechada') {
      setpoint = valorEm(degraus, t);
      erro = setpoint - temp;
      enabled = 1;
      if (k < p.nAquec) {
        u = 0;
      } else {
        integral += erro * p.Ki * Ts; // sem anti-windup, como no script
        u = Math.min(Math.max(p.Kp * erro + integral, 0), p.Umax);
      }
    } else {
      u = Math.min(Math.max(valorEm(degraus, t), 0), p.Umax);
    }

    // 5. amostra decimada (o que iria para o banco)
    if (k % DECIMACAO === 0) {
      saida.push({ t, temp, Treal, setpoint, erro, u, enabled });
    }

    // 4. planta avança um passo com o u aplicado agora (atraso θ)
    filaU.push(u);
    const uAtrasado = filaU.shift();
    x = a * x + b * uAtrasado;
  }
  return saida;
}

/**
 * Métricas da resposta a um degrau de setpoint (malha fechada).
 * Usa a temperatura filtrada, como a planta real veria.
 *
 * @param {object[]} amostras   saída de simular() (ou amostras reais com t em s)
 * @param {number} tDegrau      instante do degrau (s)
 * @param {object} [op]
 * @param {number} [op.tFim]        fim da janela (padrão: fim dos dados)
 * @param {number} [op.faixa=0.02]  faixa de acomodação (fração do tamanho do degrau)
 * @param {number} [op.Umax]        saturação, para medir o tempo saturado
 */
export function metricasDegrau(amostras, tDegrau, { tFim = Infinity, faixa = 0.02, Umax = Infinity } = {}) {
  // média móvel de ~1 s: sem ela, o ruído do sensor (±0,15 °C) cruza a faixa de 2%
  // o tempo todo e inflaria o sobressinal e a acomodação
  const suave = mediaMovel(amostras, 10);
  const antes = amostras.filter((s) => s.t < tDegrau).slice(-10); // sem suavizar: não mistura o degrau
  const jan = suave.filter((s) => s.t >= tDegrau && s.t < tFim);
  if (jan.length < 5) return null;

  const y0 = antes.length ? media(antes.map((s) => s.temp)) : jan[0].temp;
  const sp = jan[jan.length - 1].setpoint;
  const passo = sp - y0;
  if (!Number.isFinite(passo) || Math.abs(passo) < 1e-6) return null;
  const sinal = Math.sign(passo);
  const norm = (y) => (y - y0) / passo; // 0 → 1

  const ultimos = jan.slice(-Math.max(5, Math.round(jan.length * 0.1)));
  const yFinal = media(ultimos.map((s) => s.temp));

  const pico = jan.reduce((m, s) => (sinal * s.temp > sinal * m.temp ? s : m), jan[0]);
  const sobressinal = Math.max(0, ((pico.temp - sp) / passo) * 100);

  const t10 = jan.find((s) => norm(s.temp) >= 0.1)?.t;
  const t90 = jan.find((s) => norm(s.temp) >= 0.9)?.t;
  const subida = t10 !== undefined && t90 !== undefined ? t90 - t10 : null;

  // acomodação: último instante fora da faixa ± faixa·|passo| em torno do setpoint
  const lim = Math.abs(passo) * faixa;
  let ultimoFora = null;
  for (const s of jan) if (Math.abs(s.temp - sp) > lim) ultimoFora = s.t;
  const acomodou = ultimoFora === null || ultimoFora < jan[jan.length - 1].t - 1;
  const acomodacao = acomodou ? (ultimoFora ?? tDegrau) - tDegrau : null;

  const saturado = (jan.filter((s) => s.u >= Umax - 1e-9).length / jan.length) * 100;

  return {
    passo,
    sobressinal, // %
    tempoPico: pico.t - tDegrau, // s
    subida, // s (10–90%), null se não chegou a 90%
    acomodacao, // s (faixa de 2%), null se não acomodou na janela
    erroRegime: sp - yFinal, // °C
    uMax: Math.max(...jan.map((s) => s.u)),
    saturado, // % do tempo com u na saturação
  };
}

/** Média móvel centrada da temperatura (janela de n amostras). */
function mediaMovel(amostras, n) {
  const h = Math.floor(n / 2);
  return amostras.map((s, i) => {
    const ini = Math.max(0, i - h), fim = Math.min(amostras.length, i + h + 1);
    let soma = 0;
    for (let j = ini; j < fim; j++) soma += amostras[j].temp;
    return { ...s, temp: soma / (fim - ini) };
  });
}

export function media(v) {
  return v.reduce((a, b) => a + b, 0) / v.length;
}
