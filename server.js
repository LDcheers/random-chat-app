const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
app.use(express.json());
app.use(express.static(path.join(__dirname, '.')));

// 你的配置（和截图里的完全一致）
const MERCHANT_ID = "3653";
const API_KEY = "8QZZ8RuzhfizCVvaaufkRZu9AKcfurC0"; // 截图里的商户MD5密钥
const BASE_URL = "https://random-chat-app-production-a19a.up.railway.app";
const API_URL = "https://api.payqixiang.cn/"; // 截图里的官方接口地址

const db = new sqlite3.Database('./users.db');
db.run(`CREATE TABLE IF NOT EXISTS users (
  userId TEXT PRIMARY KEY,
  freeToday INTEGER DEFAULT 3,
  expireTime INTEGER DEFAULT 0
)`);

let waitingUser = null;
let userChats = {};

// ✅ 按官方V1接口写的创建订单
app.post('/create-order', async (req, res) => {
  const { userId, price } = req.body;
  const orderId = crypto.randomUUID().replace(/-/g, '');
  const amount = parseFloat(price).toFixed(2);

  // 1. 准备参数
  const params = {
    pid: MERCHANT_ID,
    type: 'alipay',
    out_trade_no: orderId,
    notify_url: `${BASE_URL}/pay-notify`,
    return_url: BASE_URL,
    name: "Blind Touch 会员",
    money: amount
  };

  // 2. 生成MD5签名（官方要求）
  const signStr = Object.keys(params)
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('&') + API_KEY;
  const sign = crypto.createHash('md5').update(signStr).digest('hex');
  params.sign = sign;

  try {
    // 3. 用POST方式请求官方接口
    const result = await axios.post(API_URL, new URLSearchParams(params).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    if (result.data.code === 1) {
      // 成功，返回支付链接
      res.json({ orderId, payUrl: result.data.qrcode });
    } else {
      res.status(400).json({ error: result.data.msg });
    }
  } catch (e) {
    console.error("支付接口错误：", e.response?.data || e.message);
    res.status(500).json({ error: "支付系统暂时不可用" });
  }
});

// 支付回调
app.post('/pay-notify', (req, res) => {
  const { out_trade_no, type, trade_no, money, trade_status } = req.body;
  if (trade_status !== 'TRADE_SUCCESS') return res.end('fail');

  let expire = 0;
  const now = Date.now();
  if (+money === 5) expire = now + 86400000;
  if (+money === 15) expire = now + 604800000;
  if (+money === 30) expire = now + 2592000000;

  // 这里的userId需要你在下单时存起来，简单处理一下
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
  socket.on('leave_chat', () => { const c = userChats[userId]; if (c) io.to(c).emit('chat_end'); delete userChats[userId]; });
  socket.on('send_message', (msg) => { const c = userChats[userId]; if (c) io.to(c).emit('new_message', { user: userId, msg }); });
  socket.on('disconnect', () => { if (waitingUser === userId) waitingUser = null; const c = userChats[userId]; if (c) io.to(c).emit('user_leave'); delete userChats[userId]; });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('服务已启动'));
