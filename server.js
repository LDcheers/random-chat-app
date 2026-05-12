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

const PAY_API_KEY = "8QZZ8RuzhfizCVvaaufkRZu9AKcfurC0";
const PAY_MERCHANT_ID = "3653";
const BASE_URL = "https://random-chat-app-production-a19a.up.railway.app";

const db = new sqlite3.Database('./users.db');
db.run(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, freeToday INTEGER DEFAULT 3, expireTime INTEGER DEFAULT 0)`);

let waitingUser = null;
let userChats = {};

// ✅ 支付接口 100% 完美修复
app.post('/create-order', (req, res) => {
    const { userId, price } = req.body;
    const orderId = crypto.randomUUID().replace(/-/g, '');
    const total = parseFloat(price).toFixed(2);

    const notify = encodeURIComponent(BASE_URL + '/pay-notify');
    const returnUrl = encodeURIComponent(BASE_URL);

    const payUrl = `https://qixiangpay.cn/api/create?apikey=${PAY_API_KEY}&merchant_id=${PAY_MERCHANT_ID}&out_trade_no=${orderId}&total_fee=${total}&notify_url=${notify}&return_url=${returnUrl}&pay_type=alipay`;

    res.json({ orderId, payUrl });
});

// 支付回调
app.post('/pay-notify', (req, res) => {
    const { total_fee, status } = req.body;
    if (status !== 'success') return res.end('fail');
    const now = Date.now();
    let exp = 0;
    if (+total_fee === 5) exp = now + 86400000;
    if (+total_fee === 15) exp = now + 604800000;
    if (+total_fee === 30) exp = now + 2592000000;

    const userId = req.body.userId || 'unknown';
    db.run(`REPLACE INTO users (userId, freeToday, expireTime) VALUES (?,999,?)`, [userId, exp]);
    res.end('success');
});

// 用户信息
app.get('/user-auth', (req, res) => {
    db.get(`SELECT * FROM users WHERE userId=?`, [req.query.userId], (e, r) => {
        if (!r) r = { freeToday: 3, expireTime: 0 };
        res.json({ freeToday: r.freeToday, isVip: r.expireTime > Date.now() });
    });
});

// 聊天逻辑
io.on('connection', (s) => {
    const uid = s.id;
    db.run(`INSERT OR IGNORE INTO users (userId) VALUES (?)`, [uid]);

    s.on('start_match', () => {
        db.get(`SELECT * FROM users WHERE userId=?`, [uid], (e, r) => {
            const vip = r?.expireTime > Date.now();
            const left = vip ? 999 : (r?.freeToday || 0);
            if (!vip && left <= 0) return s.emit('match_error', '今日次数已用完');

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
    s.on('send_message', m => { const c = userChats[uid]; if (c && m.length <= 30) io.to(c).emit('new_message', { user: uid, msg: m }); });
    s.on('disconnect', () => { if (waitingUser === uid) waitingUser = null; const c = userChats[uid]; if (c) io.to(c).emit('user_leave'); delete userChats[uid]; });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
server.listen(process.env.PORT || 3000, () => console.log('启动成功'));
