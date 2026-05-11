const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.json());

// ---------- 数据存储（内存）----------
const waitingUsers = new Set(); // 等待匹配的用户
const userMap = new Map();       // socket.id => { userId, dailyMatches, paid }
const rooms = new Map();          // roomId => { user1, user2, msgCount }

// 生成唯一ID
function genId() {
  return Math.random().toString(36).slice(2, 10);
}

// ---------- 匹配逻辑 ----------
function matchUsers() {
  if (waitingUsers.size >= 2) {
    const [id1, id2] = Array.from(waitingUsers).slice(0,2);
    waitingUsers.delete(id1);
    waitingUsers.delete(id2);
    const roomId = genId();
    rooms.set(roomId, { user1: id1, user2: id2, msgCount: 0 });
    io.to(id1).emit('matched', { roomId, peer: ' Stranger' });
    io.to(id2).emit('matched', { roomId, peer: ' Stranger' });
  }
}

// ---------- Socket 连接 ----------
io.on('connection', (socket) => {
  console.log('用户上线:', socket.id);

  // 初始化用户：每天3次免费，未付费
  userMap.set(socket.id, {
    userId: socket.id,
    dailyMatches: 0,
    paid: false
  });

  // 开始匹配
  socket.on('startMatch', () => {
    const u = userMap.get(socket.id);
    // 免费次数用完且未付费 → 拒绝
    if (u.dailyMatches >=3 && !u.paid) {
      return socket.emit('error', '今日3次免费匹配已用完，请付费解锁');
    }
    waitingUsers.add(socket.id);
    socket.emit('waiting');
    matchUsers();
  });

  // 发送消息
  socket.on('sendMsg', (roomId, text) => {
    const room = rooms.get(roomId);
    if (!room) return;
    // 每条≤30字
    if (text.length >30) return socket.emit('error', '消息不能超过30字');
    // 每人限20条
    if (room.msgCount >=20) return socket.emit('error', '已达20条，对话结束');
    room.msgCount++;
    // 发给对方
    const peer = room.user1 === socket.id ? room.user2 : room.user1;
    io.to(peer).emit('newMsg', text);
    // 满20条 → 强制结束
    if (room.msgCount >=20) {
      io.to(room.user1).emit('chatEnd');
      io.to(room.user2).emit('chatEnd');
      rooms.delete(roomId);
    }
  });

  // 离开聊天
  socket.on('leaveChat', (roomId) => {
    rooms.delete(roomId);
    socket.broadcast.to(roomId).emit('chatEnd');
  });

  // ---------- 支付回调：自动解锁次数 ----------
  // 易支付回调地址：/payCallback
  app.post('/payCallback', (req, res) => {
    const { userId, success } = req.body;
    if (success === '1') {
      // 找到对应用户 → 标记已付费，次数清零
      for (let [sid, u] of userMap) {
        if (u.userId === userId) {
          u.paid = true;
          u.dailyMatches = 0; // 付费后重置次数
          io.to(sid).emit('unlocked'); // 前端提示解锁成功
        }
      }
    }
    res.send('ok');
  });

  socket.on('disconnect', () => {
    waitingUsers.delete(socket.id);
    userMap.delete(socket.id);
    // 清理房间
    for (let [rid, r] of rooms) {
      if (r.user1 === socket.id || r.user2 === socket.id) {
        rooms.delete(rid);
        io.to(r.user1).emit('chatEnd');
        io.to(r.user2).emit('chatEnd');
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('运行在端口', PORT));