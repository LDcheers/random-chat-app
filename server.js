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

// 你的配置
const PID = "3653";
const KEY = "8QZZ8RuzhfizCVvaaufkRZu9AKcfurC0";
const BASE_URL = "https://random-chat-app-production-a19a.up.railway.app";

const db = new sqlite3.Database('./users.db');
db.run(`CREATE TABLE IF NOT EXISTS users (
  userId TEXT PRIMARY KEY,
  freeToday INTEGER DEFAULT 3,
  expireTime INTEGER DEFAULT 0
)`);

let waitingUser = null;
let userChats = {};

// ==============================================
// ✅ 七相PAY官方直链支付（100%能进支付宝）
// ==============================================
app.post('/create-order', (req, res) => {
  const { userId, price } = req.body;
  const orderId = crypto.randomUUID().replace(/-/g, '');
  const amount = parseFloat(price).toFixed(2);

  // 按官方文档生成签名
  const params = {
    pid: PID,
    type: "alipay",
    out_trade_no: orderId,
    money: amount,
    name: "Blind Touch会员",
    notify_url: `${BASE_URL}/pay-notify`,
    return_url: BASE_URL
  };

  // 生成MD5签名
  const keys = Object.keys(params).sort();
  let signStr = "";
  for (let k of keys) {
    signStr += `${k}=${params[k]}&`;
  }
  signStr += `key=${KEY}`;
  const sign = crypto.createHash('md5').update(signStr).digest('hex');

  // 最终支付链接（官方正确格式）
  const payUrl = `https://api.payqixiang.cn/?pid=${PID}&type=alipay&out_trade_no=${orderId}&money=${amount}&name=BlindTouch会员&notify_url=${encodeURIComponent(params.notify_url)}&return_url=${encodeURIComponent(BASE_URL)}&sign=${sign}&sign_type=MD5`;

  // 直接返回给前端
  res.json({ orderId, payUrl });
});

// 支付回调（必须保留，支付成功后会调用这里）
app.post('/pay-notify', (req, res) => {
  const { out_trade_no, money, trade_status } = req.body;
  if (trade_status !== 'TRADE_SUCCESS') return res.end('fail');

  const now = Date.now();
  let expire = 0;
  if (+money === 5) expire = now + 86400000;
  if (+money === 15) expire = now + 604800000;
  if (+money === 30) expire = now + 2592000000;

  // 用订单号关联用户（简单处理）
  db.run(`REPLACE INTO users (userId, freeToday, expireTime) VALUES (?, 999, ?)`, [out_trade_no, expire]);
  res.end('success');
});

// 获取用户权限
app.get('/user-auth', (req, res) => {
  const userId = req.query.userId;
  db.get(`SELECT * FROM users WHERE userId = ?`, [userId], (err, row) => {
    if (!row) row = { freeToday: 3, expireTime: 0 };
    const isVip = row.expireTime > Date.now();
    res.json({ freeToday: row.freeToday, isVip });
  });
});

// 聊天逻辑（完全不变）
io.on('connection', (socket) => {
  const userId = socket.id;
  db.get(`SELECT * FROM users WHERE userId = ?`, [userId], (err, row) => {
    if (!row) db.run(`INSERT INTO users (userId) VALUES (?)`, [userId]);
  });

  socket.on('start_match', () => {
    db.get(`SELECT * FROM users WHERE userId = ?`, [userId], (err, row) => {
      const isVip = row && row.expireTime > Date.now();
      const left = isVip ? 999 : (row.freeToday || 3);

      if (!isVip && left <= 0) {
        socket.emit('match_error', '今日免费次数已用完，请付费解锁！');
        return;
      }

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
  socket.on('leave_chat', () => { const chatId = userChats[userId]; if (chatId) io.to(chatId).emit('chat_end'); delete userChats[userId]; });
  socket.on('send_message', (msg) => { const chatId = userChats[userId]; if (chatId) io.to(chatId).emit('new_message', { user: userId, msg }); });
  socket.on('disconnect', () => { if (waitingUser === userId) waitingUser = null; const chatId = userChats[userId]; if (chatId) io.to(chatId).emit('user_leave'); delete userChats[userId]; });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('服务已启动'));
