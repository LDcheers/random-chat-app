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

// 支付配置
const PID = "3653";
const KEY = "8QZZ8RuzhfizCVvaaufkRZu9AKcfurC0";
const BASE_URL = "https://random-chat-app-production-a19a.up.railway.app";
const API_URL = "https://api.payqixiang.cn/submit.php";

// 数据库初始化
const db = new sqlite3.Database('./users.db');

// 游客表（旧）
db.run(`CREATE TABLE IF NOT EXISTS users (
  userId TEXT PRIMARY KEY,
  freeToday INTEGER DEFAULT 3,
  expireTime INTEGER DEFAULT 0
)`);

// 账号用户表（新注册登录）
db.run(`CREATE TABLE IF NOT EXISTS account_users (
  username TEXT PRIMARY KEY,
  password TEXT NOT NULL,
  freeToday INTEGER DEFAULT 3,
  expireTime INTEGER DEFAULT 0,
  createTime INTEGER
)`);

let waitingUser = null;
let userChats = {};
let messageCount = {}; // 聊天消息计数

// ========== 支付接口 原样保留 ==========
app.post('/create-order', (req, res) => {
  const { userId, price } = req.body;
  const out_trade_no = crypto.randomUUID().replace(/-/g, '');
  const money = parseFloat(price).toFixed(2);
  const name = "BlindTouch会员";

  const params = {
    money: money,
    name: name,
    notify_url: `${BASE_URL}/pay-notify`,
    out_trade_no: out_trade_no,
    pid: PID,
    return_url: BASE_URL,
    type: "alipay"
  };

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

  db.get(`SELECT username FROM account_users WHERE username=?`, [out_trade_no], (err, row) => {
    if (row) {
      db.run(`UPDATE account_users SET expireTime=? WHERE username=?`, [exp, out_trade_no]);
    } else {
      db.run(`REPLACE INTO users (userId, freeToday, expireTime) VALUES (?,999,?)`, [out_trade_no, exp]);
    }
  });
  res.end('success');
});

// ========== 账号注册 登录接口 ==========
app.post('/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ code: -1, msg: '账号密码不能为空' });
  if (username.length < 3) return res.json({ code: -1, msg: '账号至少3位' });

  db.get(`SELECT username FROM account_users WHERE username=?`, [username], (err, row) => {
    if (row) return res.json({ code: -1, msg: '账号已存在' });
    const t = Date.now();
    db.run(`INSERT INTO account_users (username,password,freeToday,expireTime,createTime) VALUES (?,?,3,0,?)`,
      [username, password, t],
      () => {
        res.json({ code: 0, msg: '注册成功' });
      });
  });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  db.get(`SELECT * FROM account_users WHERE username=? AND password=?`, [username, password], (err, row) => {
    if (!row) return res.json({ code: -1, msg: '账号或密码错误' });
    res.json({
      code: 0,
      data: {
        username: row.username,
        freeToday: row.freeToday,
        expireTime: row.expireTime
      }
    });
  });
});

app.get('/getAccountUser', (req, res) => {
  const { username } = req.query;
  db.get(`SELECT freeToday,expireTime FROM account_users WHERE username=?`, [username], (err, row) => {
    if (!row) return res.json({ freeToday: 3, expireTime: 0 });
    res.json(row);
  });
});

app.get('/user-auth', (req, res) => {
  db.get(`SELECT * FROM users WHERE userId=?`, [req.query.userId], (e, r) => {
    if (!r) r = { freeToday: 3, expireTime: 0 };
    res.json({ freeToday: r.freeToday, isVip: r.expireTime > Date.now() });
  });
});

// ========== 聊天匹配逻辑（已修复重复消息 + 恢复计数） ==========
io.on('connection', (socket) => {
  const uid = socket.id;
  db.run(`INSERT OR IGNORE INTO users(userId) VALUES(?)`, [uid]);

  socket.on('start_match', () => {
    db.get(`SELECT * FROM users WHERE userId=?`, [uid], (e, r) => {
      const vip = r?.expireTime > Date.now();
      const left = vip ? 999 : (r?.freeToday || 0);
      if (!vip && left <= 0) return socket.emit('match_error', '今日免费次数已用完');

      if (waitingUser && waitingUser !== uid) {
        const room = `chat_${Date.now()}`;
        userChats[uid] = room;
        userChats[waitingUser] = room;
        messageCount[room] = 0;

        socket.join(room);
        io.sockets.sockets.get(waitingUser).join(room);
        io.to(room).emit('match_success');

        if (!vip) {
          db.run(`UPDATE users SET freeToday=freeToday-1 WHERE userId=?`, [uid]);
          socket.emit('left_count', left - 1);
        }

        waitingUser = null;
      } else {
        waitingUser = uid;
        socket.emit('waiting');
        socket.emit('left_count', left);
      }
    });
  });

  // ✅ 修复：只发送纯文本消息，不再发对象！！！
  socket.on('send_message', (msg) => {
    const room = userChats[uid];
    if (!room) return;
    // 只发文字，不发对象！！！
    socket.to(room).emit('new_message', msg);

    messageCount[room] = (messageCount[room] || 0) + 1;
    io.to(room).emit('chat_count', messageCount[room]);
  });

  socket.on('cancel_match', () => { if (waitingUser === uid) waitingUser = null; });
  
  socket.on('leave_chat', () => {
    const room = userChats[uid];
    if (room) {
      io.to(room).emit('chat_end');
      delete userChats[uid];
    }
  });

  socket.on('disconnect', () => {
    if (waitingUser === uid) waitingUser = null;
    const room = userChats[uid];
    if (room) {
      io.to(room).emit('user_leave');
      delete userChats[uid];
    }
  });
});


// ========== 管理员：查看所有注册用户 ==========
app.get('/admin/users', (req, res) => {
  db.all(`SELECT username, password, freeToday, expireTime, createTime FROM account_users`, (err, rows) => {
    if (err) return res.send('错误：' + err.message);
    let html = `
    <!DOCTYPE html>
    <html>
    <head>
    <meta charset="utf-8">
    <title>用户列表</title>
    <style>body{background:#111;color:#fff;padding:20px;font-family:Arial}</style>
    </head>
    <body>
    <h2>BlindTouch 注册用户列表</h2>
    <table border="1" cellpadding="8" cellspacing="0">
      <tr>
        <th>账号</th>
        <th>密码</th>
        <th>免费次数</th>
        <th>VIP到期时间</th>
        <th>注册时间</th>
      </tr>`;

    rows.forEach(u => {
      let vipExpire = u.expireTime > Date.now() ? new Date(u.expireTime).toLocaleString() : "非VIP";
      let regTime = new Date(u.createTime).toLocaleString();
      html += `
      <tr>
        <td>${u.username}</td>
        <td>${u.password}</td>
        <td>${u.freeToday}</td>
        <td>${vipExpire}</td>
        <td>${regTime}</td>
      </tr>`;
    });

    html += `</table></body></html>`;
    res.send(html);
  });
});


app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('运行正常'));
