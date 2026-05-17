const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "http://localhost:3000", // 假設你的 React 跑在 3000 埠
    methods: ["GET", "POST"]
  }
});

// 模擬資料庫（實際開發建議使用 MongoDB）
let coupleData = {
  cpPoints: 0,
  lastCheckIn: null
};

io.on('connection', (socket) => {
  console.log('一隻卡比獸上線了：', socket.id);

  // 監聽傳送訊息
  socket.on('send_message', (data) => {
    // 轉發訊息給對方
    socket.broadcast.emit('receive_message', data);
    
    // 每次聊天小幅增加點數
    coupleData.cpPoints += 1;
    io.emit('update_points', coupleData.cpPoints);
  });

  // 監聽簽到任務
  socket.on('daily_checkin', () => {
    coupleData.cpPoints += 50; // 簽到大加分
    io.emit('update_points', coupleData.cpPoints);
    socket.emit('checkin_success', { msg: "卡比獸吃飽了！CP點數上升！" });
  });
});

server.listen(5000, () => {
  console.log('後端伺服器運行在 http://localhost:5000');
});