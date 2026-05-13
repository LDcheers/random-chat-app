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
const API_URL = "https://api.payqixiang.cn/submit.php";

const db = new sqlite3.Database('./users.db');
db.run(`CREATE TABLE IF NOT EXISTS users (
  userId TEXT PRIMARY KEY,
  freeToday INTEGER DEFAULT 3,
  expireTime INTEGER DEFAULT 0
)`);

let waitingUser = null;
let userChats = {};

// ✅ 完全按官方文档实现的签名算法
app.post('/create-order', (req, res) => {
  const { userId, price } = req.body;
  const out_trade_no = crypto.randomUUID().replace(/-/g, '');
  const money = parseFloat(price).toFixed(2);
  const name = "BlindTouch会员";

  // 按文档要求：所有参数按 ASCII 码升序排序
  const params = {
    money: money,
    name: name,
    notify_url: `${BASE_URL}/pay-notify`,
    out_trade_no: out_trade_no,
    pid: PID,
    return_url: BASE_URL,
    type: "alipay"
  };

  // 按文档规则拼接（无多余&，不编码）
  const sortedKeys = Object.keys(params).sort();
  let signStr = "";
  sortedKeys.forEach(k => {
    signStr += `${k}=${params[k]}`;
    if (k !== sortedKeys[sortedKeys.length - 1]) {
      signStr += "&";
    }
  });
  signStr += KEY;

  const sign = crypto.createHash('md5').update(signStr, 'utf8').digest('hex');

  res.json({
    formUrl: API_URL,
    formData: {
      pid: PID,
      type: "alipay",
      out_trade_no: out_trade_no,
      money: money,
      name: name,
      notify_url: `${BASE_URL}/pay-notify`,
      return_url: BASE_URL,
      sign: sign,
      sign_type: "MD5"
    }
  });
});

// 支付回调
app.post('/pay-notify', (req, res) => {
  const { trade_status, money, out_trade_no } = req.body;
  if (trade_status !== 'TRADE_SUCCESS') return res.end('fail');
  const now = Date.now();
  let exp = 0;
  if (+money == 5) exp = now + 86400000;
  if (+money == 15) exp = now + 604800000;
  if (+money == 30) exp = now + 2592000000;
  db.run(`REPLACE INTO users (userId, freeToday, expireTime) VALUES (?,999,?)`, [out_trade_no, exp]);
  res.end('success');
});

// 其他功能完全不变
app.get('/user-auth', (req, res) => {
  db.get(`SELECT * FROM users WHERE userId=?`, [req.query.userId], (e, r) => {
    if (!r) r = { freeToday: 3, expireTime: 0 };
    res.json({ freeToday: r.freeToday, isVip: r.expireTime > Date.now() });
  });
});

io.on('connection', (socket) => {
  const uid = socket.id;
  db.run(`INSERT OR IGNORE INTO users(userId) VALUES(?)`, [uid]);

  socket.on('start_match', () => {
    db.get(`SELECT * FROM users WHERE userId=?`, [uid], (e, r) => {
      const vip = r?.expireTime > Date.now();
      const left = vip ? 999 : (r?.freeToday || 0);
      if (!vip && left <= 0) return socket.emit('match_error', '今日免费次数已用完');

      if (waitingUser && waitingUser !== uid) {
        const c = `chat_${Date.now()}`;
        userChats[uid] = c;
        userChats[waitingUser] = c;
        socket.join(c);
        io.sockets.sockets.get(waitingUser)?.join(c);
        io.to(c).emit('match_success');
        if (!vip) db.run(`UPDATE users SET freeToday=freeToday-1 WHERE userId=?`, [uid]);
        socket.emit('left_count', left - 1);
        waitingUser = null;
      } else {
        waitingUser = uid;
        socket.emit('waiting');
        socket.emit('left_count', left);
      }
    });
  });

  socket.on('cancel_match', () => { if (waitingUser === uid) waitingUser = null; });
  socket.on('leave_chat', () => { const c = userChats[uid]; if (c) io.to(c).emit('chat_end'); delete userChats[uid]; });
  socket.on('send_message', m => { const c = userChats[uid]; if (c) io.to(c).emit('new_message', { user: uid, msg: m }); });
  socket.on('disconnect', () => { if (waitingUser === uid) waitingUser = null; const c = userChats[uid]; if (c) io.to(c).emit('user_leave'); delete userChats[uid]; });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
server.listen(process.env.PORT || 3000, () => console.log('ok'));
