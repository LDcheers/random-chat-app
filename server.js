const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
app.use(express.json());
app.use(express.static(path.join(__dirname, '.')));

// 你的信息
const PAY_API_KEY = "8QZZ8RuzhfizCVvaaufkRZu9AKcfurC0";
const PAY_MERCHANT_ID = "3653";
const BASE_URL = "https://random-chat-app-production-a19a.up.railway.app";

// 数据库
const db = new sqlite3.Database('./users.db');
db.run(`CREATE TABLE IF NOT EXISTS users (
  userId TEXT PRIMARY KEY,
  freeToday INTEGER DEFAULT 3,
  expireTime INTEGER DEFAULT 0
)`);

let waitingUser = null;
let userChats = {};
let userMessageCounts = {};

// ==============================================
// ✅ ✅ ✅ 终极修复：code:-5 URL Error 彻底解决
// ==============================================
app.post('/create-order', (req, res) => {
  const { userId, price } = req.body;
  const orderId = crypto.randomUUID().replace(/-/g, '');

  // 七相官方要求：必须用 encodeURIComponent 包裹回调地址！
  const notify = encodeURIComponent(BASE_URL + "/pay-notify");
  const returnUrl = encodeURIComponent(BASE_URL);

  const payUrl = `https://qixiangpay.cn/api/create?apikey=${PAY_API_KEY}&merchant_id=${PAY_MERCHANT_ID}&out_trade_no=${orderId}&total_fee=${price}&notify_url=${notify}&return_url=${returnUrl}&pay_type=alipay`;

  res.json({ orderId, payUrl });
});

// 支付回调
app.post('/pay-notify', (req, res) => {
  const { total_fee, status, userId } = req.body;
  if (status !== 'success') return res.end('fail');

  let expire = 0;
  const now = Date.now();
  if (total_fee == 5) expire = now + 86400000;
  if (total_fee == 15) expire = now + 604800000;
  if (total_fee == 30) expire = now + 2592000000;

  db.run(`REPLACE INTO users (userId, freeToday, expireTime) VALUES (?, ?, ?)`, [userId, 999, expire]);
  res.end('success');
});

// 用户权限
app.get('/user-auth', (req, res) => {
  const userId = req.query.userId;
  db.get(`SELECT * FROM users WHERE userId = ?`, [userId], (err, row) => {
    if (!row) row = { freeToday: 3, expireTime: 0 };
    res.json({ freeToday: row.freeToday, isVip: row.expireTime > Date.now() });
  });
});

// 聊天逻辑不变
io.on('connection', (socket) => {
  const userId = socket.id;
  db.get(`SELECT * FROM users WHERE userId = ?`, [userId], (err, row) => {
    if (!row) db.run(`INSERT INTO users (userId) VALUES (?)`, [userId]);
  });

  socket.on('start_match', () => {
    db.get(`SELECT * FROM users WHERE userId = ?`, [userId], (err, row) => {
      const isVip = row && row.expireTime > Date.now();
      const left = isVip ? 999 : (row.freeToday || 3);
      if (!isVip && left <= 0) { socket.emit('match_error', '次数用完'); return; }

      if (waitingUser && waitingUser !== userId) {
        const chatId = `chat_${Date.now()}`;
        userChats[userId] = chatId;
        userChats[waitingUser] = chatId;
        socket.join(chatId);
        io.sockets.sockets.get(waitingUser).join(chatId);
        io.to(chatId).emit('match_success');
        waitingUser = null;
        if (!isVip) db.run(`UPDATE users SET freeToday = freeToday - 1 WHERE userId = ?`, [userId]);
        socket.emit('left_count', left - 1);
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

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('ok'));
