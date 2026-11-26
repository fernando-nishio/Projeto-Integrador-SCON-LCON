// Painel: valores atuais, gráficos em tempo real, envio de comandos e últimas leituras.
//
// Dados em tempo real: o navegador abre /api/stream (Server-Sent Events). A cada
// lote que o MATLAB envia (1 por segundo, amostras a 10 Hz), o backend repassa as
// amostras para cá. Ao abrir a página, o histórico recente vem de /api/data/latest.
import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { api, linhaParaAmostra } from '../api.js';
import LiveChart from '../components/LiveChart.jsx';

// O three.js é grande (~600 kB): só é baixado quando o painel abre, em arquivo separado
const Gemeo3D = lazy(() => import('../components/Gemeo3D.jsx'));

const JANELA_S = 120; // segundos exibidos nos gráficos
const MAX_AMOSTRAS = JANELA_S * 10; // 10 amostras por segundo
const SEM_DADOS_MS = 5000; // sem lote há mais de 5 s => avisa

const fmt = (v, casas = 2) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(casas) : '—');
const hora = (t) => new Date(t).toLocaleTimeString('pt-BR', { hour12: false });

export default function Dashboard() {
  const [amostras, setAmostras] = useState([]);
  const [comandos, setComandos] = useState(null); // { enabled, setpoint } atuais no servidor
  const [conexao, setConexao] = useState('conectando');
  const [agora, setAgora] = useState(Date.now());

  // Formulário
  const [novoSetpoint, setNovoSetpoint] = useState('');
  const [msg, setMsg] = useState(null); // { tipo: 'ok' | 'erro', texto }
  const [enviando, setEnviando] = useState(false);

  function juntar(novas) {
    setAmostras((atuais) => {
      const todas = atuais.concat(novas);
      return todas.length > MAX_AMOSTRAS ? todas.slice(todas.length - MAX_AMOSTRAS) : todas;
    });
  }

  useEffect(() => {
    // 1. Histórico recente + comandos atuais
    api
      .latest(MAX_AMOSTRAS)
      .then((rows) => setAmostras(rows.map(linhaParaAmostra).reverse()))
      .catch(() => {});
    api
      .status()
      .then((r) => setComandos(r.commands))
      .catch(() => {});

    // 2. Tempo real
    const fonte = new EventSource('/api/stream');
    fonte.onopen = () => setConexao('conectado');
    fonte.onerror = () => {
      setConexao('reconectando');
      api.me().catch(() => {}); // se a sessão expirou, o App volta para o login
    };
    fonte.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.commands) setComandos(m.commands);
      if (m.type === 'samples') juntar(m.samples);
    };

    // 3. Relógio para o aviso de "sem dados"
    const relogio = setInterval(() => setAgora(Date.now()), 1000);

    return () => {
      fonte.close();
      clearInterval(relogio);
    };
  }, []);

  const ultima = amostras.length ? amostras[amostras.length - 1] : null;
  const semDados = !ultima || agora - ultima.t > SEM_DADOS_MS;

  // Pontos dos gráficos: x em segundos relativos à amostra mais recente
  const series = useMemo(() => {
    if (!ultima) return { temp: [], sp: [], u: [] };
    const t0 = ultima.t;
    const pts = (campo) =>
      amostras.filter((a) => typeof a[campo] === 'number').map((a) => ({ x: (a.t - t0) / 1000, y: a[campo] }));
    return { temp: pts('temp'), sp: pts('setpoint'), u: pts('u') };
  }, [amostras, ultima]);

  const seriesTemp = useMemo(
    () => [
      { label: 'Temperatura', cor: 'series-1', pontos: series.temp },
      { label: 'Setpoint', cor: 'series-2', pontos: series.sp },
    ],
    [series],
  );
  const seriesU = useMemo(() => [{ label: 'Sinal de controle', cor: 'series-1', pontos: series.u }], [series]);

  async function enviar(nome, valor, descricao) {
    setEnviando(true);
    setMsg(null);
    try {
      const r = await api.send(nome, valor);
      setComandos(r.commands);
      setMsg({ tipo: 'ok', texto: `${descricao} — enviado. O MATLAB aplica na próxima troca de dados (até 1 s).` });
    } catch (err) {
      setMsg({ tipo: 'erro', texto: `Não foi possível enviar: ${err.message}` });
    } finally {
      setEnviando(false);
    }
  }

  function enviarSetpoint(e) {
    e.preventDefault();
    const v = Number(String(novoSetpoint).replace(',', '.'));
    if (!Number.isFinite(v) || v <= 0 || v >= 100) {
      setMsg({ tipo: 'erro', texto: 'O setpoint deve estar entre 0 e 100 °C.' });
      return;
    }
    enviar('setpoint', v, `Setpoint ${v} °C`);
  }

  const ligado = comandos?.enabled === 1;

  return (
    <div className="painel">
      {/* Estado da conexão */}
      <div className="linha-status">
        <span className={`ponto ${conexao === 'conectado' && !semDados ? 'ok' : 'alerta'}`} aria-hidden="true" />
        <span>
          {conexao !== 'conectado'
            ? 'Reconectando ao servidor…'
            : semDados
              ? 'Conectado, mas sem dados da planta (o MATLAB está rodando?)'
              : `Recebendo dados da planta · última amostra às ${hora(ultima.t)}`}
        </span>
      </div>

      {/* Valores atuais */}
      <section className="tiles" aria-label="Valores atuais">
        <Tile rotulo="Temperatura" valor={fmt(ultima?.temp)} unidade="°C" destaque />
        <Tile rotulo="Setpoint" valor={fmt(comandos?.setpoint, 1)} unidade="°C" />
        <Tile rotulo="Erro" valor={fmt(ultima?.erro)} unidade="°C" />
        <Tile rotulo="Sinal de controle" valor={fmt(ultima?.u)} unidade="V" />
        <div className="tile">
          <div className="tile-rotulo">Controle</div>
          <div className={`estado ${ligado ? 'ligado' : 'desligado'}`}>
            <span aria-hidden="true">{ligado ? '●' : '○'}</span> {comandos ? (ligado ? 'Ligado' : 'Desligado') : '—'}
          </div>
        </div>
      </section>

      {/* Gêmeo digital: o LCD e o tubo do modelo 3D seguem a planta real */}
      <section className="cartao" aria-labelledby="titulo-gemeo">
        <h2 id="titulo-gemeo">Gêmeo digital</h2>
        <Suspense fallback={<p className="muted centro">Carregando modelo 3D…</p>}>
          <Gemeo3D amostra={ultima} online={conexao === 'conectado' && !semDados} />
        </Suspense>
      </section>

      <div className="colunas">
        {/* Gráficos */}
        <section className="cartao graficos">
          <LiveChart titulo={`Temperatura e setpoint — últimos ${JANELA_S} s`} unidade="°C" series={seriesTemp} />
          <LiveChart titulo="Sinal de controle (tensão no aquecedor)" unidade="V" series={seriesU} altura={180} />
        </section>

        {/* Comandos */}
        <section className="cartao comandos" aria-labelledby="titulo-comandos">
          <h2 id="titulo-comandos">Controle da planta</h2>

          <div className="grupo">
            <div className="rotulo">Sistema de controle</div>
            <div className="botoes">
              <button
                className="btn"
                disabled={enviando || ligado}
                onClick={() => enviar('enabled', 1, 'Ligar controle')}
              >
                Ligar
              </button>
              <button
                className="btn secundario"
                disabled={enviando || (comandos && !ligado)}
                onClick={() => enviar('enabled', 0, 'Desligar controle')}
              >
                Desligar
              </button>
            </div>
            <p className="dica muted">Desligar zera a parcela integral do PI.</p>
          </div>

          <form className="grupo" onSubmit={enviarSetpoint}>
            <label className="rotulo" htmlFor="setpoint">
              Setpoint de temperatura (°C)
            </label>
            <div className="botoes">
              <input
                id="setpoint"
                type="number"
                min="1"
                max="99"
                step="0.5"
                placeholder={comandos ? String(comandos.setpoint) : '40'}
                value={novoSetpoint}
                onChange={(e) => setNovoSetpoint(e.target.value)}
                required
              />
              <button className="btn" type="submit" disabled={enviando}>
                Enviar
              </button>
            </div>
          </form>

          {msg && (
            <p className={`msg ${msg.tipo}`} role="status">
              {msg.texto}
            </p>
          )}
        </section>
      </div>

      {/* Últimas leituras em texto (exigido na atividade como teste de funcionalidade) */}
      <section className="cartao">
        <h2>Últimas leituras</h2>
        <div className="tabela-rolagem">
          <table>
            <thead>
              <tr>
                <th>Hora</th>
                <th className="num">Temperatura (°C)</th>
                <th className="num">Setpoint (°C)</th>
                <th className="num">Erro (°C)</th>
                <th className="num">u (V)</th>
                <th>Controle</th>
              </tr>
            </thead>
            <tbody>
              {amostras
                .slice(-10)
                .reverse()
                .map((a) => (
                  <tr key={a.t}>
                    <td>{hora(a.t)}</td>
                    <td className="num">{fmt(a.temp)}</td>
                    <td className="num">{fmt(a.setpoint, 1)}</td>
                    <td className="num">{fmt(a.erro)}</td>
                    <td className="num">{fmt(a.u)}</td>
                    <td>{a.enabled === 1 ? 'ligado' : 'desligado'}</td>
                  </tr>
                ))}
              {amostras.length === 0 && (
                <tr>
                  <td colSpan="6" className="muted centro">
                    Nenhuma leitura ainda.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Tile({ rotulo, valor, unidade, destaque }) {
  return (
    <div className={`tile ${destaque ? 'destaque' : ''}`}>
      <div className="tile-rotulo">{rotulo}</div>
      <div className="tile-valor">
        {valor}
        <span className="tile-unidade"> {unidade}</span>
      </div>
    </div>
  );
}
