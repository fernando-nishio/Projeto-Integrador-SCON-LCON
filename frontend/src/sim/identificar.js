// Identificação do modelo da planta a partir de dados medidos.
//
// Ajusta, por mínimos quadrados, o modelo discreto de 1ª ordem com atraso
//     y[k+1] = a·y[k] + b·u[k−d] + c
// e converte para os parâmetros contínuos do FOPDT usado em modelo.js:
//     τ = −Δt / ln(a)      K = b / (1 − a)      T_amb = c / (1 − a)      θ = d·Δt
// O atraso d é escolhido testando todos de 0 até atrasoMax e ficando com o menor erro.
//
// Funciona com dados de malha aberta (degrau de u: o ideal) ou de malha fechada,
// desde que u varie bastante no trecho. Arquivo sem React (testável com node --test).

/**
 * @param {{t:number, temp:number, u:number}[]} amostras  t em segundos, em ordem
 * @param {object} [op]
 * @param {number} [op.atrasoMax=5]  maior atraso testado (s)
 * @returns {{K:number, tau:number, theta:number, Tamb:number, ajuste:number, dt:number,
 *            n:number, curva:{t:number, temp:number, modelo:number}[]}}
 */
export function identificar(amostras, { atrasoMax = 5 } = {}) {
  const dados = amostras.filter((s) => [s.t, s.temp, s.u].every(Number.isFinite));
  const n = dados.length;
  if (n < 30) throw new Error(`Poucos dados (${n} amostras). Use pelo menos alguns segundos de ensaio.`);

  const t = dados.map((s) => s.t);
  const y = dados.map((s) => s.temp);
  const u = dados.map((s) => s.u);
  const dt = mediana(t.slice(1).map((v, i) => v - t[i]));
  if (!(dt > 0)) throw new Error('Os tempos das amostras precisam ser crescentes.');

  if (desvio(u) < 0.05) {
    throw new Error(
      'O sinal u quase não variou neste trecho, então não dá para separar o efeito do aquecedor. ' +
        'Use um trecho com degrau de u ou de setpoint.',
    );
  }

  const dMax = Math.max(0, Math.round(atrasoMax / dt));
  let melhor = null;
  for (let d = 0; d <= dMax; d++) {
    const r = ajustarARX(t, y, u, d, dt);
    if (r && (!melhor || r.sse < melhor.sse)) melhor = { ...r, d };
  }
  if (!melhor) throw new Error('Não foi possível ajustar o modelo (dados com muitas falhas de tempo?).');

  const { a, b, c, d } = melhor;
  if (!(a > 0 && a < 1)) {
    throw new Error(
      `O ajuste não resultou numa planta estável de 1ª ordem (a = ${a.toFixed(4)}). ` +
        'O trecho pode ser curto demais ou ter pouca variação de temperatura.',
    );
  }
  const tau = -dt / Math.log(a);
  const K = b / (1 - a);
  const Tamb = c / (1 - a);
  const theta = d * dt;

  // Validação em simulação livre (o modelo não vê as medidas, só u): é o teste honesto
  const yh = new Array(n);
  yh[0] = mediana(y.slice(0, 5)); // robusto a um 1º ponto ruim (ex.: filtro começando do zero)
  for (let k = 0; k < n - 1; k++) yh[k + 1] = a * yh[k] + b * u[Math.max(0, k - d)] + c;
  const ym = y.reduce((s, v) => s + v, 0) / n;
  const errNorm = Math.sqrt(y.reduce((s, v, i) => s + (v - yh[i]) ** 2, 0));
  const refNorm = Math.sqrt(y.reduce((s, v) => s + (v - ym) ** 2, 0)) || 1;
  const ajuste = 100 * (1 - errNorm / refNorm); // % (100 = perfeito), estilo "fit" do MATLAB

  return {
    K, tau, theta, Tamb, ajuste, dt, n,
    curva: dados.map((s, i) => ({ t: s.t, temp: s.temp, modelo: yh[i] })),
  };
}

/** Mínimos quadrados para y[k+1] = a·y[k] + b·u[k−d] + c (equações normais 3×3). */
function ajustarARX(t, y, u, d, dt) {
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const B = [0, 0, 0];
  let linhas = 0;
  for (let k = d; k < y.length - 1; k++) {
    // só usa linhas sem buraco no tempo entre k−d e k+1
    if (Math.abs(t[k + 1] - t[k - d] - (d + 1) * dt) > 0.5 * dt) continue;
    const phi = [y[k], u[k - d], 1];
    for (let i = 0; i < 3; i++) {
      B[i] += phi[i] * y[k + 1];
      for (let j = 0; j < 3; j++) A[i][j] += phi[i] * phi[j];
    }
    linhas++;
  }
  if (linhas < 10) return null;
  const x = resolver3(A, B);
  if (!x) return null;
  const [a, b, c] = x;
  let sse = 0;
  for (let k = d; k < y.length - 1; k++) {
    if (Math.abs(t[k + 1] - t[k - d] - (d + 1) * dt) > 0.5 * dt) continue;
    sse += (y[k + 1] - (a * y[k] + b * u[k - d] + c)) ** 2;
  }
  return { a, b, c, sse: sse / linhas };
}

/** Eliminação de Gauss com pivoteamento parcial (sistema 3×3). */
function resolver3(A, B) {
  const M = A.map((l, i) => [...l, B[i]]);
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c < 4; c++) M[r][c] -= f * M[col][c];
    }
  }
  return [0, 1, 2].map((i) => M[i][3] / M[i][i]);
}

/**
 * Lê um CSV de ensaio com colunas de tempo, temperatura e u.
 * Aceita cabeçalho (t/tempo/time, temp/temperatura/y, u), separador , ; ou tab,
 * vírgula decimal (com ;) e tempo em s ou em ms desde 1970 (vira s a partir de 0).
 */
export function lerCSV(texto) {
  const linhas = String(texto).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!linhas.length) throw new Error('Arquivo vazio.');
  const sep = linhas[0].includes(';') ? ';' : linhas[0].includes('\t') ? '\t' : ',';
  const partes = (l) => l.split(sep).map((c) => c.trim().replace(/^"|"$/g, ''));
  const num = (c) => Number(sep === ';' ? c.replace(',', '.') : c);

  let cab = partes(linhas[0]).map((c) => c.toLowerCase());
  let inicio = 1;
  if (cab.every((c) => Number.isFinite(num(c)))) {
    cab = ['t', 'temp', 'u'];
    inicio = 0;
  }
  const achar = (nomes) => cab.findIndex((c) => nomes.some((n) => c === n || c.startsWith(n + ' ') || c.startsWith(n + '(')));
  const it = achar(['t', 'tempo', 'time', 'tempo_s', 't_s']);
  const iy = achar(['temp', 'temperatura', 'y', 'temp_c']);
  const iu = achar(['u', 'u_v', 'tensao', 'tensão']);
  if (it < 0 || iy < 0 || iu < 0) {
    throw new Error('O CSV precisa das colunas t (tempo), temp (temperatura) e u (tensão no aquecedor).');
  }

  let dados = linhas.slice(inicio).map((l) => {
    const c = partes(l);
    return { t: num(c[it]), temp: num(c[iy]), u: num(c[iu]) };
  }).filter((s) => [s.t, s.temp, s.u].every(Number.isFinite));
  if (dados.length && dados[0].t > 1e9) dados = dados.map((s) => ({ ...s, t: s.t / 1000 }));
  const t0 = dados[0]?.t ?? 0;
  return dados.map((s) => ({ ...s, t: Math.round((s.t - t0) * 1e6) / 1e6 }));
}

function mediana(v) {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
}

function desvio(v) {
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
}
