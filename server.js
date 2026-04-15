require('dotenv').config();
const express = require('express');
const fetch   = require('node-fetch');
const cors    = require('cors');
const path    = require('path');
const redis   = require('redis');

const app           = express();
const PORT          = process.env.PORT          || 3000;
const CLIENT_ID     = process.env.BLING_CLIENT_ID;
const CLIENT_SECRET = process.env.BLING_CLIENT_SECRET;
const REDIRECT_URI  = process.env.REDIRECT_URI  || 'https://painel-bling-ipic.onrender.com/auth/callback';
const CUTOFF        = process.env.CUTOFF        || '12:00';
const REDIS_URL     = process.env.REDIS_URL;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Redis
const redisClient = redis.createClient({ url: REDIS_URL });
redisClient.on('error', err => console.error('Redis error:', err));
redisClient.connect().then(() => console.log('Redis conectado'));

async function getTokens() {
  try {
    const data = await redisClient.get('bling_tokens');
    return data ? JSON.parse(data) : { access_token: null, refresh_token: null, expires_at: null };
  } catch { return { access_token: null, refresh_token: null, expires_at: null }; }
}

async function saveTokens(t) {
  try { await redisClient.set('bling_tokens', JSON.stringify(t)); }
  catch (e) { console.error('Erro ao salvar tokens:', e); }
}

// Auth
app.get('/auth/login', (req, res) => {
  const url = 'https://www.bling.com.br/Api/v3/oauth/authorize'
    + '?response_type=code'
    + '&client_id=' + CLIENT_ID
    + '&redirect_uri=' + encodeURIComponent(REDIRECT_URI)
    + '&scope=pedidos.vendas.leitura'
    + '&state=painel-tv';
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.send('<h2>Erro: ' + (error || 'code não recebido') + '</h2>');
  try {
    const creds = Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64');
    const resp  = await fetch('https://www.bling.com.br/Api/v3/oauth/token', {
      method: 'POST',
      headers: { 'Authorization': 'Basic ' + creds, 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.access_token) return res.send('<h2>Erro: ' + JSON.stringify(data) + '</h2>');
    await saveTokens({ access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 });
    console.log('Autenticado!');
    res.redirect('/');
  } catch (e) { res.send('<h2>Erro: ' + e.message + '</h2>'); }
});

async function refreshToken() {
  const t = await getTokens();
  if (!t.refresh_token) return false;
  try {
    const creds = Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64');
    const resp  = await fetch('https://www.bling.com.br/Api/v3/oauth/token', {
      method: 'POST',
      headers: { 'Authorization': 'Basic ' + creds, 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.access_token) { await saveTokens({ access_token: null, refresh_token: null, expires_at: null }); return false; }
    await saveTokens({ access_token: data.access_token, refresh_token: data.refresh_token || t.refresh_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 });
    console.log('Token renovado');
    return true;
  } catch { return false; }
}

async function ensureToken(req, res, next) {
  const t = await getTokens();
  if (!t.access_token) return res.status(401).json({ error: 'not_authenticated', login_url: '/auth/login' });
  if (Date.now() >= t.expires_at) {
    const ok = await refreshToken();
    if (!ok) return res.status(401).json({ error: 'token_expired', login_url: '/auth/login' });
  }
  req.blingToken = (await getTokens()).access_token;
  next();
}

// Lojas online
const LOJAS_ONLINE = new Set([203628722, 203953121, 205397393, 205401394, 206006851, 206029808, 205389906]);
const ID_ABERTO = 6;

function fmt(d) { return d.toISOString().split('T')[0]; }

async function blingGet(token, params) {
  const qs   = new URLSearchParams(params).toString();
  const url  = 'https://www.bling.com.br/Api/v3/pedidos/vendas?' + qs;
  const resp = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' } });
  const data = await resp.json();
  if (!resp.ok) throw new Error(JSON.stringify(data));
  return (data.data || []).filter(o => LOJAS_ONLINE.has(Number(o.loja && o.loja.id)));
}

// Pedidos: abertos (30 dias) + outros status só de hoje
app.get('/api/pedidos', ensureToken, async (req, res) => {
  try {
    const hoje   = new Date();
    const ini30  = new Date(hoje); ini30.setDate(ini30.getDate() - 30);
    const token  = req.blingToken;
    const hoje_s = fmt(hoje);

    // 1. Todos os pedidos Em Aberto dos últimos 30 dias
    const abertos = await blingGet(token, {
      dataInicial: fmt(ini30),
      dataFinal:   hoje_s,
      situacao:    ID_ABERTO,
      pagina:      1,
      limite:      100,
    });

    // 2. Pedidos de HOJE com qualquer status EXCETO aberto
    const doDia = await blingGet(token, {
      dataInicial: hoje_s,
      dataFinal:   hoje_s,
      pagina:      1,
      limite:      100,
    });

    // Filtra do dia só os que NÃO são abertos
    const doDiaFechados = doDia.filter(o => {
      const id = Number((o.situacao && o.situacao.id) || o.situacao);
      return id !== ID_ABERTO;
    });

    // Junta sem duplicatas
    const vistos = new Set();
    const todos  = [...abertos, ...doDiaFechados].filter(o => {
      if (vistos.has(o.numero)) return false;
      vistos.add(o.numero);
      return true;
    });

    res.json({ data: todos });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Histórico por data
app.get('/api/historico', ensureToken, async (req, res) => {
  try {
    const data_s = req.query.data || fmt(new Date());
    const token  = req.blingToken;
    const pedidos = await blingGet(token, {
      dataInicial: data_s,
      dataFinal:   data_s,
      pagina:      1,
      limite:      100,
    });
    res.json({ data: pedidos, data_s });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Status
app.get('/api/status', async (req, res) => {
  const t = await getTokens();
  res.json({ authenticated: !!(t.access_token && Date.now() < (t.expires_at || 0)), login_url: '/auth/login', cutoff: CUTOFF });
});

// Debug
app.get('/api/debug', ensureToken, async (req, res) => {
  try {
    const hoje = new Date();
    const ini  = new Date(hoje); ini.setDate(ini.getDate() - 7);
    const url  = 'https://www.bling.com.br/Api/v3/pedidos/vendas?dataInicial=' + fmt(ini) + '&dataFinal=' + fmt(hoje) + '&pagina=1&limite=100';
    const resp = await fetch(url, { headers: { 'Authorization': 'Bearer ' + req.blingToken, 'Accept': 'application/json' } });
    const data = await resp.json();
    const sits = {};
    (data.data || []).forEach(o => {
      const id = (o.situacao && o.situacao.id) || o.situacao;
      if (!sits[id]) sits[id] = { id, total: 0, exemplo: o.numero };
      sits[id].total++;
    });
    res.json(Object.values(sits).sort((a, b) => a.id - b.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/health', (req, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log('Servidor na porta ' + PORT));
