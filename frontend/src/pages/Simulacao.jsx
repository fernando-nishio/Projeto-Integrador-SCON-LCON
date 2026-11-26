// Aba Simulação: modelo matemático da planta (modelo digital).
//
// - Simula o soprador com o MESMO controle PI do cliente_planta.m, sem precisar do kit.
// - Mostra no modelo 3D, numa linha do tempo, o que o kit faria com essa entrada.
// - Identifica os parâmetros do modelo a partir de dados reais (InfluxDB ou CSV de ensaio).
// Os parâmetros ficam salvos neste navegador (localStorage). O padrão é o modelo
// identificado na Atividade 07 de LCON-I.
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { api, linhaParaAmostra } from '../api.js';
import LiveChart from '../components/LiveChart.jsx';
import { PARAMETROS_PADRAO, ATRASO_PARTIDA_FRIO, simular, metricasDegrau, lerDegraus } from '../sim/modelo.js';
import { identificar, lerCSV } from '../sim/identificar.js';

// three.js só é baixado quando a aba abre (mesmo arquivo usado no Painel)
const Gemeo3D = lazy(() => import('../components/Gemeo3D.jsx'));
const VELOCIDADES = [1, 2, 5, 10, 20];

const CHAVE = 'ltr701.modelo';
const CAMPOS_PLANTA = [
  { id: 'K', rotulo: 'Ganho K', unidade: '°C/V', step: 0.1 },
  { id: 'tau', rotulo: 'Constante de tempo τ', unidade: 's', step: 0.1 },
  { id: 'theta', rotulo: 'Atraso θ', unidade: 's', step: 0.1 },
  { id: 'Tamb', rotulo: 'Temperatura ambiente', unidade: '°C', step: 0.5 },
];
const CAMPOS_PI = [
  { id: 'Kp', rotulo: 'Kp', unidade: 'V/°C', step: 0.1 },
  { id: 'Ki', rotulo: 'Ki', unidade: 'V/(°C·s)', step: 0.05 },
  { id: 'Umax', rotulo: 'Saturação U_MAX', unidade: 'V', step: 0.5 },
  { id: 'ruido', rotulo: 'Ruído do sensor', unidade: '°C', step: 0.05 },
];

const fmt = (v, casas = 2) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(casas) : '—');

function carregarParametros() {
  try {
    const salvo = JSON.parse(localStorage.getItem(CHAVE) || 'null');
    if (salvo && typeof salvo === 'object') return { ...PARAMETROS_PADRAO, ...salvo };
  } catch {
    // localStorage indisponível ou valor corrompido: usa os padrões
  }
  return { ...PARAMETROS_PADRAO };
}

function salvarParametros(p) {
  try {
    localStorage.setItem(CHAVE, JSON.stringify(p));
  } catch {
    // sem armazenamento (modo privado etc.): segue sem salvar
  }
}

function validar(p) {
  if (!(p.tau > 0)) return 'τ precisa ser maior que zero.';
  if (!(p.theta >= 0) || p.theta > 60) return 'θ precisa estar entre 0 e 60 s.';
  if (!(p.Umax > 0)) return 'U_MAX precisa ser maior que zero.';
  if (!(p.Kp >= 0) || !(p.Ki >= 0)) return 'Kp e Ki não podem ser negativos.';
  if (!(p.ruido >= 0)) return 'O ruído não pode ser negativo.';
  if (![p.K, p.Tamb].every(Number.isFinite)) return 'Preencha K e a temperatura ambiente.';
  return null;
}

export default function Simulacao() {
  const [p, setP] = useState(carregarParametros);
  const [malha, setMalha] = useState('fechada');
  const [degrausTxt, setDegrausTxt] = useState({ fechada: '0:40, 60:50', aberta: '0:0, 5:6' });
  const [duracao, setDuracao] = useState(120);
  const [T0, setT0] = useState(''); // vazio = começa na temperatura ambiente

  // linha do tempo do 3D: índice da amostra mostrada (10 por segundo)
  const [idx, setIdx] = useState(0);
  const [tocando, setTocando] = useState(false);
  const [velocidade, setVelocidade] = useState(5);

  // identificação
  const [ident, setIdent] = useState(null);
  const [identMsg, setIdentMsg] = useState(null);
  const [carregando, setCarregando] = useState(false);

  function mudar(id, valor) {
    const novo = { ...p, [id]: valor === '' ? NaN : Number(String(valor).replace(',', '.')) };
    setP(novo);
    if (!validar(novo)) salvarParametros(novo);
  }

  const ehAtiv07 = ['K', 'tau', 'Tamb'].every((id) => p[id] === PARAMETROS_PADRAO[id]);
  const selo = !ehAtiv07
    ? null
    : p.theta === 0
      ? 'sem atraso'
      : p.theta === ATRASO_PARTIDA_FRIO
        ? 'com atraso'
        : 'atraso personalizado';

  function aplicarModelo(theta) {
    const novo = { ...p, K: PARAMETROS_PADRAO.K, tau: PARAMETROS_PADRAO.tau, Tamb: PARAMETROS_PADRAO.Tamb, theta };
    setP(novo);
    salvarParametros(novo);
  }

  // ---- simulação (recalcula a cada mudança; 120 s a 100 Hz leva poucos ms)
  const sim = useMemo(() => {
    const erro = validar(p);
    if (erro) return { erro };
    if (!(duracao >= 5 && duracao <= 1800)) return { erro: 'A duração deve ficar entre 5 e 1800 s.' };
    const Tini = T0 === '' ? undefined : Number(String(T0).replace(',', '.'));
    if (Tini !== undefined && !Number.isFinite(Tini)) return { erro: 'Temperatura inicial inválida.' };
    try {
      const degraus = lerDegraus(degrausTxt[malha]);
      const amostras = simular(p, { duracao, malha, degraus, T0: Tini });
      let metricas = null;
      if (malha === 'fechada') {
        const ultimo = degraus[degraus.length - 1];
        metricas = metricasDegrau(amostras, ultimo.t, { Umax: p.Umax });
      }
      return { amostras, metricas };
    } catch (e) {
      return { erro: e.message };
    }
  }, [p, malha, degrausTxt, duracao, T0]);

  // ---- reprodução no 3D
  const amostras = sim.amostras ?? [];
  const n = amostras.length;
  const i = Math.min(idx, Math.max(n - 1, 0));
  const atual = n ? amostras[i] : null;
  const posicao = useRef(0); // tempo do ensaio (s) durante a reprodução
  posicao.current = atual?.t ?? 0;

  useEffect(() => {
    if (!tocando || !n) return;
    const dtAmostra = n > 1 ? amostras[1].t - amostras[0].t : 0.1;
    let t = posicao.current;
    if (t >= amostras[n - 1].t) t = 0; // no fim, recomeça
    let antes = performance.now();
    let raf;
    const passo = (agora) => {
      t += ((agora - antes) / 1000) * velocidade;
      antes = agora;
      const novo = Math.min(Math.round(t / dtAmostra), n - 1);
      setIdx(novo);
      if (novo >= n - 1) {
        setTocando(false);
        return;
      }
      raf = requestAnimationFrame(passo);
    };
    raf = requestAnimationFrame(passo);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tocando, velocidade, sim]);

  const seriesTemp = useMemo(() => {
    const a = sim.amostras ?? [];
    const temp = { label: 'Temperatura simulada', cor: 'series-1', pontos: a.map((s) => ({ x: s.t, y: s.temp })) };
    if (malha === 'aberta') return [temp];
    return [temp, { label: 'Setpoint', cor: 'series-2', pontos: a.map((s) => ({ x: s.t, y: s.setpoint })) }];
  }, [sim, malha]);
  const seriesU = useMemo(
    () => [{ label: 'u', cor: 'series-1', pontos: (sim.amostras ?? []).map((s) => ({ x: s.t, y: s.u })) }],
    [sim],
  );

  // ---- identificação
  function rodarIdentificacao(amostras, origem) {
    setIdentMsg(null);
    try {
      const r = identificar(amostras);
      setIdent({ ...r, origem });
      if (r.ajuste < 80) {
        setIdentMsg({
          tipo: 'erro',
          texto: `Ajuste baixo (${r.ajuste.toFixed(0)}%). Prefira um trecho com degrau de u ou de setpoint, sem o controle desligado no meio.`,
        });
      }
    } catch (e) {
      setIdent(null);
      setIdentMsg({ tipo: 'erro', texto: e.message });
    }
  }

  async function identificarDaPlanta() {
    setCarregando(true);
    try {
      const linhas = await api.latest(2000); // até 200 s a 10 Hz (limite da API)
      const amostras = linhas.map(linhaParaAmostra).reverse();
      if (!amostras.length) throw new Error('O banco ainda não tem leituras da planta.');
      const t0 = amostras[0].t;
      rodarIdentificacao(
        amostras.map((s) => ({ t: (s.t - t0) / 1000, temp: s.temp, u: s.u })),
        `últimos ${((amostras[amostras.length - 1].t - t0) / 1000).toFixed(0)} s da planta`,
      );
    } catch (e) {
      setIdent(null);
      setIdentMsg({ tipo: 'erro', texto: `Não foi possível buscar os dados: ${e.message}` });
    } finally {
      setCarregando(false);
    }
  }

  async function identificarDeArquivo(ev) {
    const arq = ev.target.files?.[0];
    ev.target.value = '';
    if (!arq) return;
    try {
      rodarIdentificacao(lerCSV(await arq.text()), `arquivo ${arq.name}`);
    } catch (e) {
      setIdent(null);
      setIdentMsg({ tipo: 'erro', texto: e.message });
    }
  }

  function usarIdentificados() {
    const novo = {
      ...p,
      K: arred(ident.K, 3),
      tau: arred(ident.tau, 3),
      theta: arred(ident.theta, 2),
      Tamb: arred(ident.Tamb, 2),
    };
    setP(novo);
    salvarParametros(novo);
    setIdentMsg({ tipo: 'ok', texto: 'Parâmetros aplicados ao modelo e salvos neste navegador.' });
  }

  const seriesIdent = useMemo(() => {
    if (!ident) return null;
    return [
      { label: 'Medido', cor: 'series-1', pontos: ident.curva.map((s) => ({ x: s.t, y: s.temp })) },
      { label: 'Modelo', cor: 'series-2', pontos: ident.curva.map((s) => ({ x: s.t, y: s.modelo })) },
    ];
  }, [ident]);

  const m = sim.metricas;

  return (
    <div className="painel">
      <div className="colunas">
        <section className="cartao graficos" aria-label="Resultado da simulação">
          {sim.erro ? (
            <p className="msg erro">{sim.erro}</p>
          ) : (
            <>
              <LiveChart
                key={malha} // a malha aberta tem uma série a menos: recria o gráfico
                titulo={malha === 'fechada' ? 'Temperatura e setpoint' : 'Temperatura (malha aberta)'}
                unidade="°C"
                eixoX="tempo (s)"
                series={seriesTemp}
                cursorX={atual?.t ?? null}
              />
              <LiveChart
                titulo="Sinal de controle (tensão no aquecedor)"
                unidade="V"
                eixoX="tempo (s)"
                series={seriesU}
                altura={170}
                cursorX={atual?.t ?? null}
              />
            </>
          )}
        </section>

        <section className="cartao" aria-labelledby="titulo-ensaio">
          <h2 id="titulo-ensaio">Ensaio</h2>
          <div className="grupo">
            <div className="rotulo">Tipo</div>
            <div className="botoes">
              <button className={`btn ${malha === 'fechada' ? '' : 'secundario'}`} onClick={() => setMalha('fechada')}>
                Malha fechada (PI)
              </button>
              <button className={`btn ${malha === 'aberta' ? '' : 'secundario'}`} onClick={() => setMalha('aberta')}>
                Malha aberta
              </button>
            </div>
          </div>
          <div className="grupo">
            <label className="rotulo" htmlFor="degraus">
              {malha === 'fechada' ? 'Setpoints (tempo s : °C)' : 'Tensão no aquecedor (tempo s : V)'}
            </label>
            <input
              id="degraus"
              value={degrausTxt[malha]}
              onChange={(e) => setDegrausTxt({ ...degrausTxt, [malha]: e.target.value })}
            />
            <p className="dica muted">
              {malha === 'fechada'
                ? 'Ex.: 0:40, 60:50 → começa em 40 °C e muda para 50 °C em t = 60 s.'
                : 'Ex.: 0:0, 5:6 → aquecedor em 0 V e passa para 6 V em t = 5 s.'}
            </p>
          </div>
          <div className="grupo">
            <label className="rotulo" htmlFor="duracao">
              Duração (s)
            </label>
            <input
              id="duracao"
              type="number"
              min="5"
              max="1800"
              step="10"
              value={duracao}
              onChange={(e) => setDuracao(Number(e.target.value))}
            />
          </div>
          <div className="grupo">
            <label className="rotulo" htmlFor="t0">
              Temperatura inicial (°C)
            </label>
            <input
              id="t0"
              type="number"
              step="0.5"
              placeholder={`ambiente (${fmt(p.Tamb, 1)})`}
              value={T0}
              onChange={(e) => setT0(e.target.value)}
            />
          </div>
        </section>
      </div>

      {atual && (
        <section className="cartao" aria-labelledby="titulo-3d">
          <h2 id="titulo-3d">O que o kit faria</h2>
          <p className="dica muted">
            O modelo 3D mostra o ensaio simulado instante a instante: o LCD com os valores previstos e o tubo
            esquentando. A linha tracejada nos gráficos marca o mesmo instante.
          </p>
          <Suspense fallback={<p className="muted centro">Carregando modelo 3D…</p>}>
            <Gemeo3D
              amostra={atual}
              online
              simulacao
              altura={320}
              rodape={`t = ${atual.t.toFixed(1)} s de ${amostras[n - 1].t.toFixed(0)} s  x${velocidade}`}
            />
          </Suspense>
          <div className="linha-tempo">
            <button
              className="btn"
              onClick={() => setTocando(!tocando)}
              aria-label={tocando ? 'Pausar' : 'Reproduzir'}
            >
              {tocando ? '❚❚' : '▶'}
            </button>
            <input
              type="range"
              min="0"
              max={n - 1}
              value={i}
              aria-label="Instante do ensaio"
              onChange={(e) => {
                setTocando(false);
                setIdx(Number(e.target.value));
              }}
            />
            <span className="tempo-atual">{atual.t.toFixed(1)} s</span>
            <select
              value={velocidade}
              aria-label="Velocidade"
              onChange={(e) => setVelocidade(Number(e.target.value))}
            >
              {VELOCIDADES.map((v) => (
                <option key={v} value={v}>
                  {v}×
                </option>
              ))}
            </select>
          </div>
        </section>
      )}

      {m && (
        <section className="tiles" aria-label="Métricas do último degrau">
          <Tile rotulo="Sobressinal" valor={fmt(m.sobressinal, 1)} unidade="%" />
          <Tile rotulo="Tempo de subida (10–90%)" valor={fmt(m.subida, 1)} unidade="s" />
          <Tile rotulo="Acomodação (2%)" valor={m.acomodacao === null ? 'não acomodou' : fmt(m.acomodacao, 1)} unidade={m.acomodacao === null ? '' : 's'} />
          <Tile rotulo="Erro em regime" valor={fmt(m.erroRegime, 2)} unidade="°C" />
          <Tile rotulo="Tempo saturado" valor={fmt(m.saturado, 0)} unidade="%" />
        </section>
      )}
      {m && m.saturado >= 5 && (
        <p className="msg aviso">
          O u ficou na saturação ({fmt(p.Umax, 1)} V) em {fmt(m.saturado, 0)}% do degrau. O PI do script não tem
          anti-windup, então a integral continua crescendo enquanto está saturado, o que aumenta o sobressinal.
        </p>
      )}

      <div className="colunas">
        <section className="cartao" aria-labelledby="titulo-planta">
          <h2 id="titulo-planta">
            Modelo da planta {selo && <span className="selo">{selo}</span>}
          </h2>
          <p className="formula">
            G(s) = <b>{fmt(p.K, 3)}</b>
            {p.theta > 0 && (
              <>
                ·e<sup>−{fmt(p.theta, 2)}s</sup>
              </>
            )}{' '}
            / (<b>{fmt(p.tau, 2)}</b>s + 1)
          </p>
          <div className="botoes">
            <button className={`btn ${ehAtiv07 && p.theta === 0 ? '' : 'secundario'}`} onClick={() => aplicarModelo(0)}>
              Sem atraso
            </button>
            <button
              className={`btn ${ehAtiv07 && p.theta === ATRASO_PARTIDA_FRIO ? '' : 'secundario'}`}
              onClick={() => aplicarModelo(ATRASO_PARTIDA_FRIO)}
            >
              Com atraso (θ = {virgula(ATRASO_PARTIDA_FRIO)} s)
            </button>
          </div>
          <br />
          <Campos campos={CAMPOS_PLANTA} p={p} mudar={mudar} />

          <h2>Controlador</h2>
          <Campos campos={CAMPOS_PI} p={p} mudar={mudar} />
          <div className="botoes">
            <button
              className="btn secundario"
              onClick={() => {
                setP({ ...PARAMETROS_PADRAO });
                salvarParametros({ ...PARAMETROS_PADRAO });
              }}
            >
              Restaurar padrões
            </button>
          </div>
        </section>

        <section className="cartao" aria-labelledby="titulo-ident">
          <h2 id="titulo-ident">Identificar o modelo com dados</h2>
          <div className="botoes">
            <button className="btn" disabled={carregando} onClick={identificarDaPlanta}>
              {carregando ? 'Buscando…' : 'Últimos 200 s da planta'}
            </button>
            <label className="btn secundario">
              Arquivo CSV
              <input type="file" accept=".csv,.txt,text/csv" hidden onChange={identificarDeArquivo} />
            </label>
            <button
              className="btn secundario"
              disabled={!sim.amostras}
              onClick={() => rodarIdentificacao(sim.amostras, 'simulação desta página')}
            >
              Testar com a simulação
            </button>
          </div>
          <p className="dica muted">CSV: colunas t (s), temp (°C) e u (V), separadas por vírgula ou ponto e vírgula.</p>

          {identMsg && (
            <p className={`msg ${identMsg.tipo}`} role="status">
              {identMsg.texto}
            </p>
          )}

          {ident && (
            <>
              <table className="tabela-ident">
                <tbody>
                  <tr><th>Origem</th><td>{ident.origem} ({ident.n} amostras)</td></tr>
                  <tr><th>K</th><td className="num">{fmt(ident.K, 3)} °C/V</td></tr>
                  <tr><th>τ</th><td className="num">{fmt(ident.tau, 2)} s</td></tr>
                  <tr><th>θ</th><td className="num">{fmt(ident.theta, 2)} s</td></tr>
                  <tr><th>T ambiente</th><td className="num">{fmt(ident.Tamb, 2)} °C</td></tr>
                  <tr><th>Ajuste</th><td className="num">{fmt(ident.ajuste, 1)} %</td></tr>
                </tbody>
              </table>
              <LiveChart
                key={ident.origem + ident.n}
                titulo="Medido × modelo identificado (simulação livre)"
                unidade="°C"
                eixoX="tempo (s)"
                series={seriesIdent}
                altura={200}
              />
              <div className="botoes">
                <button className="btn" onClick={usarIdentificados}>
                  Usar estes parâmetros
                </button>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function Campos({ campos, p, mudar }) {
  return (
    <div className="campos">
      {campos.map((c) => (
        <label key={c.id} className="campo">
          <span>{c.rotulo}</span>
          <span className="campo-entrada">
            <input
              type="number"
              step={c.step}
              value={Number.isFinite(p[c.id]) ? p[c.id] : ''}
              onChange={(e) => mudar(c.id, e.target.value)}
            />
            <span className="muted">{c.unidade}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

function Tile({ rotulo, valor, unidade }) {
  return (
    <div className="tile">
      <div className="tile-rotulo">{rotulo}</div>
      <div className="tile-valor">
        {valor}
        <span className="tile-unidade"> {unidade}</span>
      </div>
    </div>
  );
}

const virgula = (v) => String(v).replace('.', ',');

function arred(v, casas) {
  const f = 10 ** casas;
  return Math.round(v * f) / f;
}
