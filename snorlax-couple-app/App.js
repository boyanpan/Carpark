import React, { useState, useEffect } from 'react';
import io from 'socket.io-client';

const socket = io.connect("http://localhost:5000");

function App() {
  const [points, setPoints] = useState(0);
  const [message, setMessage] = useState("");
  const [chatLog, setChatLog] = useState([]);

  useEffect(() => {
    // 接收點數更新
    socket.on('update_points', (data) => setPoints(data));
    
    // 接收新訊息
    socket.on('receive_message', (data) => {
      setChatLog((prev) => [...prev, { text: data, type: 'partner' }]);
    });
  }, []);

  const handleCheckIn = () => {
    socket.emit('daily_checkin');
  };

  const sendMessage = () => {
    socket.emit('send_message', message);
    setChatLog((prev) => [...prev, { text: message, type: 'me' }]);
    setMessage("");
  };

  return (
    <div style={{ backgroundColor: '#F2E5BC', minHeight: '100vh', padding: '20px', textAlign: 'center' }}>
      <h1 style={{ color: '#4E8D93' }}>卡比獸情侶窩 💤</h1>
      
      {/* 狀態顯示 */}
      <div style={{ margin: '20px', padding: '15px', border: '2px solid #4E8D93', borderRadius: '15px' }}>
        <h3>目前 CP 點數：{points}</h3>
        <button onClick={handleCheckIn} style={btnStyle}>餵食樹果 (每日簽到)</button>
      </div>

      {/* 簡易聊天視窗 */}
      <div style={chatBoxStyle}>
        {chatLog.map((msg, index) => (
          <p key={index} style={{ textAlign: msg.type === 'me' ? 'right' : 'left' }}>
            <strong>{msg.type === 'me' ? '我' : '另一半'}:</strong> {msg.text}
          </p>
        ))}
      </div>

      <input 
        value={message} 
        onChange={(e) => setMessage(e.target.value)} 
        placeholder="傳送甜蜜訊息..."
      />
      <button onClick={sendMessage} style={btnStyle}>送出</button>
    </div>
  );
}

// 簡單的樣式
const btnStyle = { backgroundColor: '#4E8D93', color: 'white', border: 'none', padding: '10px 20px', borderRadius: '10px', cursor: 'pointer', margin: '5px' };
const chatBoxStyle = { height: '200px', overflowY: 'scroll', border: '1px solid #ccc', margin: '10px auto', width: '80%', padding: '10px', backgroundColor: 'white' };

export default App;