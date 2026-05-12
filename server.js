const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const url = require('url');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
app.use(express.json());
app.use(express.static(path.join(__dirname, '.')));

// === 官方配置 ===
const PID = "3653";
const KEY = "8QZZ8RuzhfizCVvaaufkRZu9AKcfurC0";
const BASE_URL = "https://random-chat-app-production-a19a.up.railway.app";
const API_URL = "https://api.payqixiang.cn/submit.php"; // 文档里的正确地址

const db = new sqlite3.Database('./users.db');
db.run(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, freeToday INTEGER DEFAULT 3, expireTime INTEGER DEFAULT 0)`);

let waitingUser = null;
let userChats = {};

// === 按文档要求的支付接口（POST 表单提交）===
app.post('/create-order', (req, res) => {
  const { userId, price } = req.body;
  const out_trade_no = crypto.randomBytes(16).toString('hex');
  const money = parseFloat(price).toFixed(2);
  const name = "BlindTouch会员";

  // 按文档要求：参数按 ASCII 码从小到大排序
  const params = {
    pid: PID,
    type: "alipay",
    out_trade_no: out_trade_no,
    money: money,
    name: name,
    notify_url: `${BASE_URL}/pay-notify`,
    return_url: BASE_URL
  };

  // 1. 生成签名字符串（按 key 升序拼接）
  let signStr = '';
  Object.keys(params).sort().forEach(key => {
    signStr += `${key}=${params[key]}&`;
  });
  signStr += `key=${KEY}`;

  // 2. 生成 MD5 签名（小写）
  const sign = crypto.createHash('md5').update(signStr, 'utf8').digest('hex');

  // 3. 构造表单提交参数
  const formData = {
    ...params,
    sign: sign,
    sign_type: "MD5"
  };

  // 4. 返回给前端：直接跳转到 submit.php 并提交表单
  res.json({
    formUrl: API_URL,
    formData: formData
  });
});

// === 支付回调接口 ===
app.post('/pay-notify', (req, res) => {
  const { out_trade_no, money, trade_status } = req.body;
  if (trade_status !== 'TRADE_SUCCESS') {
    return res.end('fail');
  }

  const now = Date.now();
  let expireTime = 0;
  if (+money === 5) expireTime = now + 86400000;      // 1天
  if (+money === 15) expireTime = now + 604800000;    // 7天
  if (+money === 30) expireTime = now + 2592000000;  // 30天

  db.run(`REPLACE INTO users (userId, freeToday, expireTime) VALUES (?, 999, ?)`, [out_trade_no, expireTime]);
  res.end('success'); // 文档要求必须返回纯文本 success
});

// === 用户信息接口 ===
app.get('/user-auth', (req, res) => {
  const userId = req.query.userId;
  db.get(`SELECT * FROM users WHERE userId = ?`, [userId], (err, row) => {
    if (!row) row = { freeToday: 3, expireTime: 0 };
    res.json({ freeToday: row.freeToday, isVip: row.expireTime > Date.now() });
  });
});

// === 聊天匹配逻辑 ===
io.on('connection', (socket) => {
  const userId = socket.id;
  db.run(`INSERT OR IGNORE INTO users (userId) VALUES (?)`, [userId]);

  socket.on('start_match', () => {
    db.get(`SELECT * FROM users WHERE userId = ?`, [userId], (err, row) => {
      const isVip = row?.expireTime > Date.now();
      const left = isVip ? 999 : (row?.freeToday || 0);
      if (!isVip && left <= 0) return socket.emit('match_error', '今日次数已用完，请开通会员');

      if (waitingUser && waitingUser !== userId) {
        const chatId = `chat_${Date.now()}`;
        userChats[userId] = chatId;
        userChats[waitingUser] = chatId;
        socket.join(chatId);
        io.sockets.sockets.get(waitingUser)?.join(chatId);
        io.to(chatId).emit('match_success');
        if (!isVip) db.run(`UPDATE users SET freeToday = freeToday - 1 WHERE userId = ?`, [userId]);
        socket.emit('left_count', left - 1);
        waitingUser = null;
      } else {
        waitingUser = userId;
        socket.emit('waiting');
        socket.emit('left_count', left);
      }
    });
  });

  socket.on('cancel_match', () => { if (waitingUser === userId) waitingUser = null; });
  socket.on('leave_chat', () => { const c = userChats[userId]; if (c) io.to(c).emit('chat_end'); delete userChats[userId]; });
  socket.on('send_message', (msg) => { const c = userChats[userId]; if (c) io.to(c).emit('new_message', { user: userId, msg }); });
  socket.on('disconnect', () => { if (waitingUser === userId) waitingUser = null; const c = userChats[userId]; if (c) io.to(c).emit('user_leave'); delete userChats[userId]; });
});

// === 前端页面 ===
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

server.listen(process.env.PORT || 3000, () => {
  console.log('✅ 按官方文档配置的支付服务已启动');
});
