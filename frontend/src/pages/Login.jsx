// Tela de login. Se o sistema ainda não tem nenhum usuário, vira a tela de
// "criar o primeiro administrador".
import { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function Login({ onLogin, aviso }) {
  const [precisaAdmin, setPrecisaAdmin] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmacao, setConfirmacao] = useState('');
  const [erro, setErro] = useState('');
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    api
      .setup()
      .then((r) => setPrecisaAdmin(r.needs_admin))
      .catch(() => {});
  }, []);

  async function enviar(e) {
    e.preventDefault();
    setErro('');
    if (precisaAdmin && password !== confirmacao) {
      setErro('As senhas não conferem.');
      return;
    }
    setEnviando(true);
    try {
      if (precisaAdmin) await api.createUser(username, password, 'admin');
      const r = await api.login(username, password);
      onLogin(r.user);
    } catch (err) {
      setErro(err.message);
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="login-pagina">
      <form className="cartao login" onSubmit={enviar}>
        <h1>{precisaAdmin ? 'Criar administrador' : 'Entrar'}</h1>
        <p className="muted">
          {precisaAdmin
            ? 'Nenhum usuário cadastrado ainda. Crie a conta de administrador do sistema.'
            : 'Soprador térmico LTR701 — Projeto Integrador SCOM/LCON'}
        </p>

        {aviso && <p className="msg aviso">{aviso}</p>}

        <label>
          Usuário
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required autoFocus />
        </label>
        <label>
          Senha
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={precisaAdmin ? 'new-password' : 'current-password'}
            minLength={precisaAdmin ? 8 : undefined}
            required
          />
        </label>
        {precisaAdmin && (
          <label>
            Confirme a senha
            <input
              type="password"
              value={confirmacao}
              onChange={(e) => setConfirmacao(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
            />
          </label>
        )}

        {erro && (
          <p className="msg erro" role="alert">
            {erro}
          </p>
        )}

        <button className="btn" type="submit" disabled={enviando}>
          {enviando ? 'Aguarde…' : precisaAdmin ? 'Criar e entrar' : 'Entrar'}
        </button>
      </form>
    </div>
  );
}
