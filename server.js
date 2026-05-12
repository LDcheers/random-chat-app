const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// 固定让网页能访问，绝对不会报错
app.use(express.static(path.join(__dirname, '.')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.use(express.json());

// 下面是你原来的聊天逻辑，我完整保留了
let waitingUser = null;
let userChats = {};
let userMessageCounts = {};
let userDailyMatches = {};

io.on('connection', (socket) => {
  console.log('用户连接:', socket.id);

  socket.on('start_match', () => {
    const userId = socket.id;
    const today = new Date().toDateString();

    if (!userDailyMatches[userId]) userDailyMatches[userId] = {};
    const todayMatches = userDailyMatches[userId][today] || 0;

    if (todayMatches >= 3) {
      socket.emit('match_error', '今日免费匹配次数已用完，支付9.9元解锁无限匹配！');
      return;
    }

    if (waitingUser && waitingUser !== socket.id) {
      const chatId = `chat_${Date.now()}`;
      userChats[socket.id] = chatId;
      userChats[waitingUser] = chatId;
      userMessageCounts[socket.id] = 0;
      userMessageCounts[waitingUser] = 0;

      socket.join(chatId);
      io.sockets.sockets.get(waitingUser).join(chatId);

      io.to(chatId).emit('match_success', '匹配成功！开始聊天吧~');
      waitingUser = null;

      userDailyMatches[userId][today] = todayMatches + 1;
    } else {
      waitingUser = socket.id;
      socket.emit('waiting', '正在寻找匹配...');
    }
  });

  socket.on('send_message', (msg) => {
    const chatId = userChats[socket.id];
    if (!chatId) return;

    if (msg.length > 30) {
      socket.emit('message_error', '消息长度不能超过30字！');
      return;
    }

    userMessageCounts[socket.id]++;
    if (userMessageCounts[socket.id] > 20) {
      socket.emit('message_error', '已达到最大消息次数，对话结束！');
      io.to(chatId).emit('chat_end', '对话已结束');
      return;
    }

    io.to(chatId).emit('new_message', {
      user: socket.id,
      msg: msg
    });
  });

  socket.on('disconnect', () => {
    if (waitingUser === socket.id) waitingUser = null;
    delete userChats[socket.id];
    delete userMessageCounts[socket.id];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`服务运行在端口 ${PORT}`);
});
