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

// 你的支付信息（和你截图完全一致）
const PID = "3653";
const KEY = "8QZZ8RuzhfizCVvaaufkRZu9AKcfurC0";
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

// ==============================================
// ✅ 官方支付接口（无 axios、原生、可支付、不报错）
// ==============================================
app.post('/create-order', (req, res) => {
  const { userId, price } = req.body;
  const out_trade_no = crypto.randomUUID().replace(/-/g, '');
  const money = parseFloat(price).toFixed(2);

  // 官方必填参数
  const params = {
    pid: PID,
    type: "alipay",
    out_trade_no: out_trade_no,
    name: "会员",
    money: money,
    notify_url: BASE_URL + "/pay-notify",
    return_url: BASE_URL
  };

  // MD5 签名（官方要求）
  const signStr = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&') + KEY;
  const sign = crypto.createHash('md5').update(signStr).digest('hex');

  // 最终支付链接（正确官方地址！！！）
  const payUrl = `https://api.payqixiang.cn/?pid=${PID}&type=alipay&out_trade_no=${out_trade_no}&name=会员&money=${money}&notify_url=${encodeURIComponent(BASE_URL + "/pay-notify")}&return_url=${encodeURIComponent(BASE_URL)}&sign=${sign}&sign_type=MD5`;

  res.json({ payUrl });
});

// 支付回调
app.post('/pay-notify', (req, res) => {
  const { out_trade_no, money, trade_status } = req.body;
  if (trade_status !== 'TRADE_SUCCESS') return res.end('fail');

  const now = Date.now();
  let expire = 0;
  if (money == 5) expire = now + 86400000;
  if (money == 15) expire = now + 7 * 86400000;
  if (money == 30) expire = now + 30 * 86400000;

  db.run(`REPLACE INTO users (userId, freeToday, expireTime) VALUES (?, 999, ?)`, [out_trade_no, expire]);
  res.end('success');
});

// 用户信息
app.get('/user-auth', (req, res) => {
  db.get(`SELECT * FROM users WHERE userId=?`, [req.query.userId], (err, row) => {
    if (!row) row = { freeToday: 3, expireTime: 0 };
    res.json({
      freeToday: row.freeToday,
      isVip: row.expireTime > Date.now()
    });
  });
});

// 聊天逻辑
io.on('connection', (socket) => {
  const userId = socket.id;
  db.run(`INSERT OR IGNORE INTO users (userId) VALUES (?)`, [userId]);

  socket.on('start_match', () => {
    db.get(`SELECT * FROM users WHERE userId=?`, [userId], (err, row) => {
      const isVip = row.expireTime > Date.now();
      const left = isVip ? 999 : (row.freeToday || 0);
      if (!isVip && left <= 0) return socket.emit('match_error', '次数已用完');

      if (waitingUser && waitingUser !== userId) {
        const chatId = `chat_${Date.now()}`;
        userChats[userId] = chatId;
        userChats[waitingUser] = chatId;
        socket.join(chatId);
        io.sockets.sockets.get(waitingUser)?.join(chatId);
        io.to(chatId).emit('match_success');
        if (!isVip) db.run(`UPDATE users SET freeToday=freeToday-1 WHERE userId=?`, [userId]);
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

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
server.listen(process.env.PORT || 3000, () => console.log('启动成功'));
