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

const LOJAS_ONLINE = new Set([203628722, 203953121, 205397393, 205401394, 206006851, 206029808, 205389906]);
const ID_ABERTO    = 6;

function fmt(d) { return d.toISOString().split('T')[0]; }
function getSituacaoId(o) { return Number((o.situacao && o.situacao.id) || o.situacao || 0); }
function isOnline(o) { return LOJAS_ONLINE.has(Number(o.loja && o.loja.id)); }

async function blingFetch(token, dataInicial, dataFinal) {
  const url  = 'https://www.bling.com.br/Api/v3/pedidos/vendas'
    + '?dataInicial=' + dataInicial
    + '&dataFinal='   + dataFinal
    + '&pagina=1&limite=100';
  const resp = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' } });
  const data = await resp.json();
  if (!resp.ok) throw new Error(JSON.stringify(data));
  return (data.data || []).filter(isOnline);
}

// Pedidos:
// - Em Aberto: busca 30 dias, filtra só situacao=6
// - Atendidos/Cancelados: busca 30 dias, filtra situacao != 6
//   O painel salva no Redis quais pedidos já existiam ontem (baseline)
//   e mostra no Atendido apenas os que MUDARAM de status hoje
app.get('/api/pedidos', ensureToken, async (req, res) => {
  try {
    const hoje   = new Date();
    const ini30  = new Date(hoje); ini30.setDate(ini30.getDate() - 30);
    const token  = req.blingToken;
    const hoje_s = fmt(hoje);

    // Busca 30 dias — todos os pedidos
    const todos30 = await blingFetch(token, fmt(ini30), hoje_s);

    // Abertos: situacao = 6
    const abertos = todos30.filter(o => getSituacaoId(o) === ID_ABERTO);

    // Baseline: pedidos que estavam abertos no final do dia anterior
    // Salvo no Redis com chave baseline:YYYY-MM-DD
    const ontem_s = fmt(new Date(hoje.getTime() - 86400000));
    const baselineKey = 'baseline:' + ontem_s;
    let baseline = new Set();
    try {
      const saved = await redisClient.get(baselineKey);
      if (saved) baseline = new Set(JSON.parse(saved));
    } catch(e) {}

    // Atendidos hoje = pedidos que ESTAVAM no baseline (abertos ontem) mas agora não estão mais abertos
    // OU pedidos com data == hoje e situacao != aberto (novos que já vieram faturados)
    const todosNaoAbertos = todos30.filter(o => getSituacaoId(o) !== ID_ABERTO);
    const fechados = todosNaoAbertos.filter(o => {
      return baseline.has(o.numero) || o.data === hoje_s;
    });

    // Salva baseline de hoje (abertos atuais) para usar amanhã
    const baselineHoje = 'baseline:' + hoje_s;
    try {
      await redisClient.set(baselineHoje, JSON.stringify(abertos.map(o => o.numero)), { EX: 7 * 86400 });
    } catch(e) {}

    // Junta sem duplicatas
    const vistos = new Set();
    const result = [...abertos, ...fechados].filter(o => {
      if (vistos.has(o.numero)) return false;
      vistos.add(o.numero);
      return true;
    });

    console.log('Abertos: ' + abertos.length + ' | Atendidos: ' + fechados.length);
    res.json({ data: result });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Histórico por data
app.get('/api/historico', ensureToken, async (req, res) => {
  try {
    const data_s  = req.query.data || fmt(new Date());
    const pedidos = await blingFetch(req.blingToken, data_s, data_s);
    res.json({ data: pedidos, data_s });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Popular baseline manualmente (roda uma vez para criar histórico)
app.get('/api/baseline/popular', ensureToken, async (req, res) => {
  try {
    const hoje  = new Date();
    const ini7  = new Date(hoje); ini7.setDate(ini7.getDate() - 7);
    const token = req.blingToken;

    // Busca últimos 7 dias
    const todos = await blingFetch(token, fmt(ini7), fmt(hoje));

    // Agrupa abertos por data
    const porData = {};
    todos.forEach(o => {
      const d = o.data ? o.data.substring(0,10) : '';
      if (!d) return;
      if (!porData[d]) porData[d] = [];
      // Só salva no baseline se estava aberto naquela data
      // (aproximação: se está aberto hoje, estava aberto em datas anteriores)
      if (getSituacaoId(o) === ID_ABERTO) {
        porData[d].push(o.numero);
      }
    });

    // Salva baseline de cada dia
    const salvos = [];
    for (const [data, numeros] of Object.entries(porData)) {
      const key = 'baseline:' + data;
      await redisClient.set(key, JSON.stringify(numeros), { EX: 7 * 86400 });
      salvos.push({ data, total: numeros.length });
    }

    // Baseline de ontem = todos os pedidos não abertos dos últimos 30 dias
    // que tinham data anterior a hoje (pedidos que já existiam ontem)
    const ontem_s = fmt(new Date(hoje.getTime() - 86400000));
    const todosAbertosOntem = todos.filter(o => {
      return getSituacaoId(o) === ID_ABERTO && o.data < fmt(hoje);
    });
    const keyOntem = 'baseline:' + ontem_s;
    await redisClient.set(keyOntem, JSON.stringify(todosAbertosOntem.map(o => o.numero)), { EX: 7 * 86400 });

    res.json({ ok: true, salvos, baseline_ontem: todosAbertosOntem.length });
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
    const todos = await blingFetch(req.blingToken, fmt(ini), fmt(hoje));
    const sits  = {};
    todos.forEach(o => {
      const id = getSituacaoId(o);
      if (!sits[id]) sits[id] = { id, total: 0, exemplo: o.numero };
      sits[id].total++;
    });
    res.json(Object.values(sits).sort((a, b) => a.id - b.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/health', (req, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log('Servidor na porta ' + PORT));
