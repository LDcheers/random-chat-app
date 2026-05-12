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

// 已帮你填好配置，无需再改
const PAY_API_KEY = "8QZZ8RuzhfizCVvaaufkRZu9AKcfurC0";
const PAY_MERCHANT_ID = "3653";
// 自动沿用你原有Railway域名作为回调地址
const BASE_URL = "https://random-chat-app-production-a19a.up.railway.app";

// 数据库初始化
const db = new sqlite3.Database('./users.db');
db.run(`CREATE TABLE IF NOT EXISTS users (
  userId TEXT PRIMARY KEY,
  freeToday INTEGER DEFAULT 3,
  expireTime INTEGER DEFAULT 0
)`);

let waitingUser = null;
let userChats = {};
let userMessageCounts = {};

// 创建订单
app.post('/create-order', (req, res) => {
  const { userId, price } = req.body;
  const orderId = crypto.randomUUID();

  const payUrl = `https://qixiangpay.cn/api/create?apikey=${PAY_API_KEY}&merchant_id=${PAY_MERCHANT_ID}&out_trade_no=${orderId}&total_fee=${price}&notify_url=${BASE_URL}/pay-notify&return_url=${BASE_URL}`;
  res.json({ orderId, payUrl });
});

// 支付回调 新套餐：5元当日/15元7天/30元30天
app.post('/pay-notify', (req, res) => {
  const { total_fee, status, userId } = req.body;
  if (status !== 'success') return res.end('fail');

  let expire = 0;
  const now = Date.now();
  if (total_fee === '5') {
    expire = now + 24 * 60 * 60 * 1000;
  } else if (total_fee === '15') {
    expire = now + 7 * 24 * 60 * 60 * 1000;
  } else if (total_fee === '30') {
    expire = now + 30 * 24 * 60 * 60 * 1000;
  }

  db.run(`REPLACE INTO users (userId, freeToday, expireTime) VALUES (?, ?, ?)`, [userId, 999, expire]);
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

// 聊天Socket逻辑
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
        userMessageCounts[userId] = 0;
        userMessageCounts[waitingUser] = 0;

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

  socket.on('cancel_match', () => {
    if (waitingUser === userId) waitingUser = null;
    socket.emit('match_canceled');
  });

  socket.on('leave_chat', () => {
    const chatId = userChats[userId];
    if (!chatId) return;
    io.to(chatId).emit('chat_end', '对方已离开对话');
    delete userChats[userId];
  });

  socket.on('send_message', (msg) => {
    const chatId = userChats[userId];
    if (!chatId) return;
    if (msg.length > 30) return socket.emit('message_error', '消息过长！');

    userMessageCounts[userId]++;
    if (userMessageCounts[userId] > 20) {
      io.to(chatId).emit('chat_end', '对话结束（已达20条）');
      return;
    }

    io.to(chatId).emit('new_message', { user: userId, msg });
  });

  socket.on('disconnect', () => {
    if (waitingUser === userId) waitingUser = null;
    const chatId = userChats[userId];
    if (chatId) io.to(chatId).emit('user_leave');
    delete userChats[userId];
  });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('运行正常'));
