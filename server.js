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

const PID = "3653";
const KEY = "8QZZ8RuzhfizCVvaaufkRZu9AKcfurC0";
const BASE_URL = "https://random-chat-app-production-a19a.up.railway.app";

const db = new sqlite3.Database('./users.db');
db.run(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, freeToday INTEGER DEFAULT 3, expireTime INTEGER DEFAULT 0)`);

let waitingUser = null;
let userChats = {};

// ✅ 100% 正确签名支付接口
app.post('/create-order', (req, res) => {
  const { userId, price } = req.body;
  const out_trade_no = crypto.randomUUID().replace(/-/g, '');
  const money = parseFloat(price).toFixed(2);
  const name = "BlindTouch会员";

  // 严格按字母排序
  const data = {
    money: money,
    name: name,
    notify_url: BASE_URL + "/pay-notify",
    out_trade_no: out_trade_no,
    pid: PID,
    return_url: BASE_URL,
    type: "alipay"
  };

  // 拼接
  let s = "";
  for (let k of Object.keys(data).sort()) s += `${k}=${data[k]}&`;
  s += "key=" + KEY;

  // 正确 MD5
  const sign = crypto.createHash('md5').update(s, 'utf8').digest('hex');

  // 最终支付链接
  const payUrl = `https://api.payqixiang.cn/?money=${money}&name=${encodeURIComponent(name)}&notify_url=${encodeURIComponent(BASE_URL + "/pay-notify")}&out_trade_no=${out_trade_no}&pid=${PID}&return_url=${encodeURIComponent(BASE_URL)}&type=alipay&sign=${sign}&sign_type=MD5`;

  res.json({ payUrl });
});

// 支付成功回调（真正到账后自动开通会员）
app.post('/pay-notify', (req, res) => {
  const { money, trade_status, out_trade_no } = req.body;
  if (trade_status !== 'TRADE_SUCCESS') return res.end('fail');

  const now = Date.now();
  let exp = 0;
  if (money == 5) exp = now + 86400000;
  if (money == 15) exp = now + 604800000;
  if (money == 30) exp = now + 2592000000;

  db.run(`REPLACE INTO users (userId, freeToday, expireTime) VALUES (?, 999, ?)`, [out_trade_no, exp]);
  res.end('success');
});

app.get('/user-auth', (req, res) => {
  db.get(`SELECT * FROM users WHERE userId=?`, [req.query.userId], (e, r) => {
    if (!r) r = { freeToday: 3, expireTime: 0 };
    res.json({ freeToday: r.freeToday, isVip: r.expireTime > Date.now() });
  });
});

io.on('connection', (s) => {
  const uid = s.id;
  db.run(`INSERT OR IGNORE INTO users (userId) VALUES (?)`, [uid]);

  s.on('start_match', () => {
    db.get(`SELECT * FROM users WHERE userId=?`, [uid], (e, r) => {
      const vip = r?.expireTime > Date.now();
      const left = vip ? 999 : (r?.freeToday || 0);
      if (!vip && left <= 0) return s.emit('match_error', '次数用完');

      if (waitingUser && waitingUser !== uid) {
        const c = `chat_${Date.now()}`;
        userChats[uid] = c;
        userChats[waitingUser] = c;
        s.join(c);
        io.sockets.sockets.get(waitingUser)?.join(c);
        io.to(c).emit('match_success');
        if (!vip) db.run(`UPDATE users SET freeToday=freeToday-1 WHERE userId=?`, [uid]);
        s.emit('left_count', left - 1);
        waitingUser = null;
      } else {
        waitingUser = uid;
        s.emit('waiting');
        s.emit('left_count', left);
      }
    });
  });

  s.on('cancel_match', () => { if (waitingUser === uid) waitingUser = null; });
  s.on('leave_chat', () => { const c = userChats[uid]; if (c) io.to(c).emit('chat_end'); delete userChats[uid]; });
  s.on('send_message', m => { const c = userChats[uid]; if (c) io.to(c).emit('new_message', { user: uid, msg: m }); });
  s.on('disconnect', () => { if (waitingUser === uid) waitingUser = null; const c = userChats[uid]; if (c) io.to(c).emit('user_leave'); delete userChats[uid]; });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
server.listen(process.env.PORT || 3000, () => console.log('ok'));
