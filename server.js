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

// ==== 旧文档 V1 配置（固定不变）====
const PID = "3653";
const KEY = "8QZZ8RuzhfizCVvaaufkRZu9AKcfurC0";
const BASE_URL = "https://random-chat-app-production-a19a.up.railway.app";

const db = new sqlite3.Database('./users.db');
db.run(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, freeToday INTEGER DEFAULT 3, expireTime INTEGER DEFAULT 0)`);

let waitingUser = null;
let userChats = {};

// ==== 100% 按旧文档生成支付链接 ====
app.post('/create-order', (req, res) => {
  const { userId, price } = req.body;

  // 1. 订单号（唯一）
  const out_trade_no = crypto.randomBytes(16).toString('hex');

  // 2. 金额（强制两位小数）
  const money = parseFloat(price).toFixed(2);

  // 3. 商品名称（自动urlencode，旧文档要求）
  const name = encodeURIComponent("BlindTouch会员");

  // 4. 固定参数
  const type = "alipay";
  const notify_url = encodeURIComponent(BASE_URL + "/pay-notify");
  const return_url = encodeURIComponent(BASE_URL);

  // 5. 按旧文档：参数名ASCII升序
  const params = {
    money,
    name,
    notify_url,
    out_trade_no,
    pid: PID,
    return_url,
    type
  };

  // 6. 拼接签名字符串
  let signStr = '';
  Object.keys(params).sort().forEach(k => {
    signStr += `${k}=${params[k]}&`;
  });
  signStr += `key=${KEY}`;

  // 7. MD5 小写（旧文档要求）
  const sign = crypto.createHash('md5').update(signStr, 'utf8').digest('hex');

  // 8. 最终支付链接（旧版GET方式）
  const payUrl = `https://api.payqixiang.cn/?money=${money}&name=${name}&notify_url=${notify_url}&out_trade_no=${out_trade_no}&pid=${PID}&return_url=${return_url}&type=${type}&sign=${sign}&sign_type=MD5`;

  res.json({ payUrl });
});

// ==== 异步回调（旧文档要求：直接返回success）====
app.post('/pay-notify', (req, res) => {
  const { money, trade_status, out_trade_no } = req.body;

  // 仅支付成功才处理
  if (trade_status !== 'TRADE_SUCCESS') {
    return res.end('fail');
  }

  const now = Date.now();
  let expireTime = 0;
  if (money === '5.00') expireTime = now + 86400000;      // 1天
  if (money === '15.00') expireTime = now + 604800000;    // 7天
  if (money === '30.00') expireTime = now + 2592000000;  // 30天

  // 开通会员
  db.run(`REPLACE INTO users (userId, freeToday, expireTime) VALUES (?, 999, ?)`, [out_trade_no, expireTime]);

  // 旧文档强制：纯文本success
  res.end('success');
});

// ==== 以下聊天逻辑不变 ====
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
server.listen(process.env.PORT || 3000, () => console.log('✅ 旧文档版支付已启动'));
