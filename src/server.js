require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const Database = require('better-sqlite3');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BASE = (process.env.APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const isProd = process.env.NODE_ENV === 'production';
if (isProd && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  throw new Error('Production requires SESSION_SECRET with at least 32 characters.');
}
const secret = process.env.SESSION_SECRET || 'dev-only-change-this-secret-before-deploying';
const dbPath = path.resolve(process.env.DATABASE_PATH || './data/fandazi.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider, provider_id)
);
CREATE TABLE IF NOT EXISTS user_data (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);`);

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(session({
  name: 'fandazi.sid', secret,
  resave: false, saveUninitialized: false,
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: path.dirname(dbPath) }),
  cookie: { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: 30 * 24 * 60 * 60 * 1000 }
}));
app.use('/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: true, legacyHeaders: false }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const pendingStates = new Map();
function makeState() {
  const state = crypto.randomBytes(24).toString('hex');
  pendingStates.set(state, Date.now());
  for (const [key, time] of pendingStates) if (Date.now() - time > 10 * 60 * 1000) pendingStates.delete(key);
  return state;
}
function takeState(state) {
  const time = pendingStates.get(state);
  pendingStates.delete(state);
  return Boolean(time && Date.now() - time < 10 * 60 * 1000);
}
function requireUser(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: '请先使用微信或 QQ 登录。' });
  next();
}
function upsertUser(provider, providerId, displayName, avatarUrl) {
  const existing = db.prepare('SELECT id FROM users WHERE provider = ? AND provider_id = ?').get(provider, String(providerId));
  if (existing) {
    db.prepare('UPDATE users SET display_name = ?, avatar_url = ?, last_login_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(displayName || (provider === 'wechat' ? '微信用户' : 'QQ用户'), avatarUrl || null, existing.id);
    return existing.id;
  }
  const result = db.prepare('INSERT INTO users(provider, provider_id, display_name, avatar_url) VALUES (?, ?, ?, ?)')
    .run(provider, String(providerId), displayName || (provider === 'wechat' ? '微信用户' : 'QQ用户'), avatarUrl || null);
  return Number(result.lastInsertRowid);
}
function finishLogin(req, res, provider, profile) {
  const id = upsertUser(provider, profile.id, profile.name, profile.avatar);
  req.session.regenerate(err => {
    if (err) return res.status(500).send('创建登录会话失败，请重试。');
    req.session.userId = id;
    req.session.save(err2 => {
      if (err2) return res.status(500).send('保存登录会话失败，请重试。');
      res.redirect('/?login=success');
    });
  });
}
async function getJson(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'FanDazi/1.0' } });
  const text = await response.text();
  if (!response.ok) throw new Error(`OAuth provider returned HTTP ${response.status}: ${text.slice(0, 250)}`);
  try { return JSON.parse(text); } catch { throw new Error(`OAuth provider returned non-JSON: ${text.slice(0, 250)}`); }
}

// WeChat Website QR OAuth. Register this exact callback URL in the WeChat Open Platform console.
app.get('/auth/wechat', (req, res) => {
  if (!process.env.WECHAT_APP_ID || !process.env.WECHAT_APP_SECRET) return res.status(503).send('微信登录尚未配置：请在服务器环境变量中设置 WECHAT_APP_ID 和 WECHAT_APP_SECRET。');
  const state = makeState(); req.session.oauthState = state;
  const callback = `${BASE}/auth/wechat/callback`;
  const url = new URL('https://open.weixin.qq.com/connect/qrconnect');
  url.search = new URLSearchParams({ appid: process.env.WECHAT_APP_ID, redirect_uri: callback, response_type: 'code', scope: 'snsapi_login', state }).toString();
  res.redirect(`${url.toString()}#wechat_redirect`);
});
app.get('/auth/wechat/callback', async (req, res) => {
  try {
    if (!req.query.code || !req.query.state || req.query.state !== req.session.oauthState) return res.status(400).send('微信授权状态校验失败，请返回重试。');
    delete req.session.oauthState;
    const token = await getJson(`https://api.weixin.qq.com/sns/oauth2/access_token?${new URLSearchParams({ appid: process.env.WECHAT_APP_ID, secret: process.env.WECHAT_APP_SECRET, code: req.query.code, grant_type: 'authorization_code' })}`);
    if (token.errcode || !token.access_token || !token.openid) throw new Error(token.errmsg || '未取得微信授权令牌');
    const info = await getJson(`https://api.weixin.qq.com/sns/userinfo?${new URLSearchParams({ access_token: token.access_token, openid: token.openid, lang: 'zh_CN' })}`);
    if (info.errcode) throw new Error(info.errmsg || '获取微信用户信息失败');
    finishLogin(req, res, 'wechat', { id: token.unionid || token.openid, name: info.nickname || '微信用户', avatar: info.headimgurl || null });
  } catch (err) { console.error('WeChat OAuth:', err.message); res.status(502).send('微信授权未完成。请检查开放平台应用配置、回调域名和应用权限，然后返回重试。'); }
});

// QQ Connect OAuth2. Register this exact callback URL in the QQ Connect console.
app.get('/auth/qq', (req, res) => {
  if (!process.env.QQ_APP_ID || !process.env.QQ_APP_KEY) return res.status(503).send('QQ 登录尚未配置：请在服务器环境变量中设置 QQ_APP_ID 和 QQ_APP_KEY。');
  const state = makeState(); req.session.oauthState = state;
  const url = new URL('https://graph.qq.com/oauth2.0/authorize');
  url.search = new URLSearchParams({ response_type: 'code', client_id: process.env.QQ_APP_ID, redirect_uri: `${BASE}/auth/qq/callback`, state, scope: 'get_user_info' }).toString();
  res.redirect(url.toString());
});
app.get('/auth/qq/callback', async (req, res) => {
  try {
    if (!req.query.code || !req.query.state || req.query.state !== req.session.oauthState) return res.status(400).send('QQ 授权状态校验失败，请返回重试。');
    delete req.session.oauthState;
    const tokenUrl = new URL('https://graph.qq.com/oauth2.0/token');
    tokenUrl.search = new URLSearchParams({ grant_type: 'authorization_code', client_id: process.env.QQ_APP_ID, client_secret: process.env.QQ_APP_KEY, code: req.query.code, redirect_uri: `${BASE}/auth/qq/callback`, fmt: 'json' }).toString();
    const token = await getJson(tokenUrl.toString());
    if (!token.access_token) throw new Error('未取得 QQ access_token');
    const openidResponse = await fetch(`https://graph.qq.com/oauth2.0/me?${new URLSearchParams({ access_token: token.access_token, fmt: 'json' })}`);
    const openidText = await openidResponse.text();
    const openidMatch = openidText.match(/\{[\s\S]*\}/);
    if (!openidMatch) throw new Error('无法解析 QQ openid');
    const openid = JSON.parse(openidMatch[0]).openid;
    if (!openid) throw new Error('QQ 未返回 openid');
    const profile = await getJson(`https://graph.qq.com/user/get_user_info?${new URLSearchParams({ access_token: token.access_token, oauth_consumer_key: process.env.QQ_APP_ID, openid })}`);
    if (profile.ret !== 0) throw new Error(profile.msg || '获取 QQ 用户信息失败');
    finishLogin(req, res, 'qq', { id: openid, name: profile.nickname || 'QQ用户', avatar: profile.figureurl_qq_2 || profile.figureurl_qq_1 || null });
  } catch (err) { console.error('QQ OAuth:', err.message); res.status(502).send('QQ 授权未完成。请检查 QQ 互联应用配置、回调域名和应用权限，然后返回重试。'); }
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const user = db.prepare('SELECT id, provider, display_name AS name, avatar_url AS avatar FROM users WHERE id = ?').get(req.session.userId);
  if (!user) { req.session.destroy(() => {}); return res.json({ user: null }); }
  res.json({ user });
});
app.get('/api/data', requireUser, (req, res) => {
  const row = db.prepare('SELECT payload FROM user_data WHERE user_id = ?').get(req.session.userId);
  res.json({ data: row ? JSON.parse(row.payload) : null });
});
app.put('/api/data', requireUser, (req, res) => {
  const payload = req.body?.data;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.records) || typeof payload.budget !== 'number' || !payload.mealDays || typeof payload.mealDays !== 'object') {
    return res.status(400).json({ error: '账本数据格式不正确。' });
  }
  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json, 'utf8') > 900_000) return res.status(413).json({ error: '账本数据过大。' });
  db.prepare(`INSERT INTO user_data(user_id, payload, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET payload = excluded.payload, updated_at = CURRENT_TIMESTAMP`).run(req.session.userId, json);
  res.json({ ok: true });
});
app.post('/auth/logout', (req, res) => req.session.destroy(err => {
  res.clearCookie('fandazi.sid', { httpOnly: true, sameSite: 'lax', secure: isProd });
  res.json({ ok: !err });
}));
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
app.listen(PORT, () => console.log(`饭搭子 online server listening on ${PORT}; public URL configured as ${BASE}`));
