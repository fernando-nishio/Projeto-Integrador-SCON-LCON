// Administração (só admin): cadastro de usuários e visualização dos logs.
import { useEffect, useState } from 'react';
import { api } from '../api.js';

const dataHora = (s) => new Date(s).toLocaleString('pt-BR', { hour12: false });

export default function Admin() {
  return (
    <div className="painel">
      <Usuarios />
      <Logs />
    </div>
  );
}

function Usuarios() {
  const [lista, setLista] = useState([]);
  const [form, setForm] = useState({ username: '', password: '', role: 'user' });
  const [msg, setMsg] = useState(null);

  const carregar = () =>
    api
      .users()
      .then(setLista)
      .catch((e) => setMsg({ tipo: 'erro', texto: e.message }));

  useEffect(() => {
    carregar();
  }, []);

  async function criar(e) {
    e.preventDefault();
    setMsg(null);
    try {
      const u = await api.createUser(form.username, form.password, form.role);
      setMsg({ tipo: 'ok', texto: `Usuário "${u.username}" criado.` });
      setForm({ username: '', password: '', role: 'user' });
      carregar();
    } catch (err) {
      setMsg({ tipo: 'erro', texto: err.message });
    }
  }

  return (
    <section className="cartao">
      <h2>Usuários</h2>
      <div className="colunas">
        <div className="tabela-rolagem">
          <table>
            <thead>
              <tr>
                <th>Usuário</th>
                <th>Papel</th>
                <th>Criado em</th>
              </tr>
            </thead>
            <tbody>
              {lista.map((u) => (
                <tr key={u.id}>
                  <td>{u.username}</td>
                  <td>
                    <span className={`papel ${u.role}`}>{u.role === 'admin' ? 'admin' : 'usuário'}</span>
                  </td>
                  <td>{u.created_at ? dataHora(u.created_at) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <form className="grupo" onSubmit={criar}>
          <h3>Novo usuário</h3>
          <label>
            Usuário
            <input
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              pattern="[A-Za-z0-9_.\-]{3,50}"
              title="3 a 50 caracteres: letras, números, _ . -"
              required
            />
          </label>
          <label>
            Senha (mín. 8 caracteres)
            <input
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              minLength={8}
              autoComplete="new-password"
              required
            />
          </label>
          <label>
            Papel
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="user">Usuário: envia parâmetros e vê resultados</option>
              <option value="admin">Administrador: também cadastra usuários e vê logs</option>
            </select>
          </label>
          <button className="btn" type="submit">
            Cadastrar
          </button>
          {msg && (
            <p className={`msg ${msg.tipo}`} role="status">
              {msg.texto}
            </p>
          )}
        </form>
      </div>
    </section>
  );
}

function Logs() {
  const [logs, setLogs] = useState([]);
  const [erro, setErro] = useState('');
  const [filtro, setFiltro] = useState('');

  const carregar = () =>
    api
      .logs(200)
      .then((l) => {
        setLogs(l);
        setErro('');
      })
      .catch((e) => setErro(e.message));

  useEffect(() => {
    carregar();
  }, []);

  const tipos = [...new Set(logs.map((l) => l.event_type))].sort();
  const visiveis = filtro ? logs.filter((l) => l.event_type === filtro) : logs;

  return (
    <section className="cartao">
      <div className="titulo-com-acoes">
        <h2>Logs do sistema</h2>
        <div className="botoes">
          <select value={filtro} onChange={(e) => setFiltro(e.target.value)} aria-label="Filtrar por tipo">
            <option value="">Todos os tipos</option>
            {tipos.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <button className="btn secundario" onClick={carregar}>
            Atualizar
          </button>
        </div>
      </div>
      <p className="muted dica">
        Descrição e IP ficam criptografados no banco e só são decifrados aqui, para administradores.
      </p>
      {erro && <p className="msg erro">{erro}</p>}
      <div className="tabela-rolagem alta">
        <table>
          <thead>
            <tr>
              <th>Data/hora</th>
              <th>Evento</th>
              <th className="num">Status</th>
              <th>Usuário</th>
              <th>IP</th>
              <th>Descrição</th>
            </tr>
          </thead>
          <tbody>
            {visiveis.map((l) => (
              <tr key={l.id}>
                <td className="nowrap">{dataHora(l.timestamp)}</td>
                <td>
                  <span className={`evento ${l.status >= 400 ? 'falha' : ''}`}>{l.event_type}</span>
                </td>
                <td className="num">{l.status ?? '—'}</td>
                <td>{l.username ?? '—'}</td>
                <td>{l.ip || '—'}</td>
                <td>{l.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
