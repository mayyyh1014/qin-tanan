const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.json());
app.use(express.static(__dirname));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// ===================== 数据存储（内存 + 可选文件备份）=====================
// 注意：Render 免费版磁盘非持久化，服务重启数据会丢失。
// 若需永久保存，建议对接云数据库（如 MongoDB Atlas）。
let scores = [];
let progressData = {};
let onlineStudents = {};

// 尝试从文件读取已有数据（如果存在）
const DATA_FILE = path.join(__dirname, 'scores.json');
const PROGRESS_FILE = path.join(__dirname, 'progress.json');
if (fs.existsSync(DATA_FILE)) {
  try { scores = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch(e) {}
}
if (fs.existsSync(PROGRESS_FILE)) {
  try { progressData = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')); } catch(e) {}
}

function saveScores() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(scores, null, 2)); } catch(e) {}
}
function saveProgress() {
  try { fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progressData, null, 2)); } catch(e) {}
}

// ===================== WebSocket =====================
io.on('connection', (socket) => {
  console.log('🔌 新连接:', socket.id);

  socket.on('student-update', (data) => {
    const { userId, name, currentLevel, currentQuestionIndex, totalCorrect, totalQuestions } = data;
    onlineStudents[userId] = {
      name: name || userId,
      currentLevel,
      currentQuestionIndex,
      totalCorrect,
      totalQuestions,
      lastUpdate: new Date().toISOString(),
      socketId: socket.id
    };
    io.emit('students-update', onlineStudents);
  });

  socket.on('student-complete', (data) => {
    const { userId } = data;
    delete onlineStudents[userId];
    io.emit('students-update', onlineStudents);
  });

  socket.on('teacher-request', () => {
    socket.emit('students-update', onlineStudents);
  });

  socket.on('teacher-clear-online', () => {
    onlineStudents = {};
    io.emit('students-update', onlineStudents);
  });

  socket.on('disconnect', () => {
    console.log('🔌 断开:', socket.id);
  });
});

// ===================== 提交成绩 =====================
app.post('/submit', (req, res) => {
  try {
    const data = req.body;
    if (!data.name || data.rate === undefined || data.time === undefined) {
      return res.status(400).send({ success: false, error: '数据不完整' });
    }
    scores.push(data);
    scores.sort((a, b) => b.rate - a.rate || a.time - b.time);
    saveScores();
    console.log('✅ 提交成绩:', data);
    res.send({ success: true });
  } catch (e) {
    console.error('提交成绩出错:', e);
    res.status(500).send({ success: false });
  }
});

// ===================== 保存进度 =====================
app.post('/api/save-progress', (req, res) => {
  const { userId, progress } = req.body;
  if (!userId) return res.status(400).send({ error: '缺少 userId' });
  if (progress === null) {
    delete progressData[userId];
    delete onlineStudents[userId];
    console.log('🗑️ 清除进度:', userId);
  } else {
    progressData[userId] = { ...progress, lastUpdate: new Date().toISOString() };
    console.log('💾 保存进度:', userId);
  }
  saveProgress();
  io.emit('students-update', onlineStudents);
  res.send({ success: true });
});

// ===================== 获取进度 =====================
app.get('/api/get-progress', (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).send({ error: '缺少 userId' });
  res.send(progressData[userId] || null);
});

// ===================== 排行榜 =====================
app.get('/rank', (req, res) => {
  res.send(scores);
});

// ===================== 教师监考后台 =====================
app.get('/admin', (req, res) => {
  let html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>秦宫探案 · 教师监考后台</title>
  <script src="/socket.io/socket.io.js"></script>
  <script src="https://cdn.bootcdn.net/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; font-family: 'Microsoft YaHei', sans-serif; }
    body { background: #1a1a2e; color: #e8e8e8; padding: 20px; min-height: 100vh; }
    h1 { color: #d4af37; margin-bottom: 20px; text-align: center; }
    h2 { color: #d4af37; margin: 20px 0 10px; font-size: 20px; }
    h3 { color: #d4af37; margin-bottom: 10px; }
    .dashboard { display: grid; grid-template-columns: 1fr 2fr; gap: 20px; }
    .panel { background: rgba(0,0,0,0.3); border: 1px solid #d4af37; border-radius: 8px; padding: 20px; }
    .stats { display: flex; gap: 20px; margin-bottom: 20px; }
    .stat-card { background: rgba(212, 175, 55, 0.1); border: 1px solid #d4af37; border-radius: 8px; padding: 15px; flex: 1; text-align: center; }
    .stat-card .number { font-size: 36px; color: #d4af37; font-weight: bold; }
    .stat-card .label { font-size: 14px; color: #ccc; margin-top: 5px; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
    th, td { border: 1px solid #444; padding: 10px; text-align: center; }
    th { background: rgba(212, 175, 55, 0.2); color: #d4af37; }
    .online-table td { font-size: 14px; }
    .progress-bar { width: 100px; height: 8px; background: #333; border-radius: 4px; overflow: hidden; display: inline-block; margin-left: 5px; }
    .progress-fill { height: 100%; background: #28a745; border-radius: 4px; }
    .btn { background: #d4af37; color: #1a1a2e; border: none; padding: 8px 20px; font-size: 14px; font-weight: bold; border-radius: 4px; cursor: pointer; margin: 5px; }
    .btn:hover { background: #f0c850; }
    .btn-danger { background: #dc3545; color: white; }
    .btn-danger:hover { background: #c82333; }
    .level-tag { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; }
    .level-1 { background: #6c757d; color: white; }
    .level-2 { background: #17a2b8; color: white; }
    .level-3 { background: #fd7e14; color: white; }
    .level-4 { background: #dc3545; color: white; }
    .empty-message { text-align: center; color: #888; padding: 20px; }
    .refresh-time { color: #888; font-size: 12px; text-align: right; margin-top: 5px; }
    .qrcode-box { background: rgba(0,0,0,0.3); border: 1px solid #d4af37; border-radius: 8px; padding: 20px; margin-bottom: 20px; }
    .qrcode-content { display: flex; justify-content: center; align-items: center; gap: 30px; flex-wrap: wrap; }
    #qrcode { background: white; padding: 10px; border-radius: 8px; min-width: 180px; min-height: 180px; display: flex; align-items: center; justify-content: center; }
    #studentUrl { font-size: 18px; font-weight: bold; color: #d4af37; background: #1a1a2e; padding: 10px 20px; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>🏛️ 秦宫探案 · 教师监考后台</h1>

  <div class="qrcode-box">
    <h3>📱 学生访问二维码</h3>
    <div class="qrcode-content">
      <div id="qrcode"></div>
      <div style="text-align: left;">
        <p style="font-size: 16px; margin-bottom: 10px;">访问地址：</p>
        <p id="studentUrl"></p>
        <p style="color: #ccc; margin-top: 10px;">
          请将二维码分享给学生<br>
          若二维码未显示，请直接使用上方地址
        </p>
      </div>
    </div>
  </div>

  <div class="dashboard">
    <div class="panel">
      <h2>📊 总体统计</h2>
      <div class="stats">
        <div class="stat-card"><div class="number" id="totalStudents">0</div><div class="label">在线学生</div></div>
        <div class="stat-card"><div class="number" id="completedCount">0</div><div class="label">已完成</div></div>
        <div class="stat-card"><div class="number" id="avgRate">0%</div><div class="label">平均正确率</div></div>
      </div>
      <h2>📋 成绩排行榜</h2>
      <table><thead><tr><th>排名</th><th>姓名</th><th>正确率</th><th>用时</th></tr></thead><tbody id="rankBody"></tbody></table>
      <div style="margin-top:20px;">
        <button class="btn" onclick="exportData()">📥 导出成绩 Excel</button>
        <button class="btn btn-danger" onclick="clearOnlineList()">🧹 清空在线列表</button>
      </div>
    </div>
    <div class="panel">
      <h2>👁️ 实时监考 · 在线学生</h2>
      <table class="online-table"><thead><tr><th>姓名</th><th>当前关卡</th><th>进度</th><th>答对</th></tr></thead><tbody id="onlineBody"><tr><td colspan="4" class="empty-message">暂无在线学生</td></tr></tbody></table>
      <div class="refresh-time" id="lastUpdate">等待数据更新...</div>
      <h2 style="margin-top:30px;">📖 关卡说明</h2>
      <table><tr><th>关卡</th><th>知识点</th><th>题数</th></tr>
      <tr><td><span class="level-tag level-1">第一关</span></td><td>通假字</td><td>2题</td></tr>
      <tr><td><span class="level-tag level-2">第二关</span></td><td>古今异义</td><td>3题</td></tr>
      <tr><td><span class="level-tag level-3">第三关</span></td><td>实词虚词</td><td>3题</td></tr>
      <tr><td><span class="level-tag level-4">第四关</span></td><td>词类活用与句式</td><td>2题</td></tr></table>
      <p style="margin-top:15px; color:#d4af37;">💡 总计 10 题</p>
    </div>
  </div>
  <script>
    const socket = io();
    let currentScores = [];

    window.onload = function() {
      const studentUrl = window.location.origin;
      document.getElementById('studentUrl').textContent = studentUrl;
      if (typeof QRCode !== 'undefined') {
        new QRCode(document.getElementById('qrcode'), {
          text: studentUrl,
          width: 180,
          height: 180,
          colorDark: "#1a1a2e",
          colorLight: "#ffffff",
          correctLevel: QRCode.CorrectLevel.H
        });
      } else {
        document.getElementById('qrcode').innerHTML = '<div style="padding:20px;color:#d4af37;">二维码库加载失败<br>请直接使用上方地址</div>';
      }
    };

    socket.emit('teacher-request');
    socket.on('students-update', (data) => {
      updateOnlineList(data);
      document.getElementById('lastUpdate').textContent = '最后更新：' + new Date().toLocaleTimeString();
    });

    function loadRank() {
      fetch('/rank').then(r => r.json()).then(data => {
        currentScores = data;
        const tbody = document.getElementById('rankBody');
        tbody.innerHTML = '';
        data.forEach((item, idx) => {
          let tr = document.createElement('tr');
          tr.innerHTML = '<td>' + (idx+1) + '</td><td>' + item.name + '</td><td>' + item.rate + '%</td><td>' + item.time + '秒</td>';
          tbody.appendChild(tr);
        });
        document.getElementById('completedCount').textContent = data.length;
        if (data.length > 0) {
          const avg = data.reduce((sum, s) => sum + s.rate, 0) / data.length;
          document.getElementById('avgRate').textContent = Math.round(avg) + '%';
        } else {
          document.getElementById('avgRate').textContent = '0%';
        }
      });
    }

    function updateOnlineList(students) {
      const tbody = document.getElementById('onlineBody');
      const list = Object.values(students);
      document.getElementById('totalStudents').textContent = list.length;
      if (list.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="empty-message">暂无在线学生</td></tr>';
        return;
      }
      list.sort((a,b) => b.currentLevel - a.currentLevel || b.currentQuestionIndex - a.currentQuestionIndex);
      tbody.innerHTML = '';
      list.forEach(s => {
        const levelNames = ['','通假字','古今异义','实词虚词','活用句式'];
        const baseQuestions = {1:0,2:2,3:5,4:8};
        const totalCompleted = baseQuestions[s.currentLevel] + s.currentQuestionIndex;
        const percent = Math.round((totalCompleted / 10) * 100);
        let tr = document.createElement('tr');
        tr.innerHTML = '<td><strong>' + s.name + '</strong></td>' +
          '<td><span class="level-tag level-' + s.currentLevel + '">第' + s.currentLevel + '关·' + levelNames[s.currentLevel] + '</span></td>' +
          '<td>第' + (s.currentQuestionIndex+1) + '/' + (s.totalQuestions||'?') + '题<div class="progress-bar"><div class="progress-fill" style="width:' + percent + '%"></div></div></td>' +
          '<td><strong style="color:#28a745;">' + (s.totalCorrect||0) + '</strong> / 10</td>';
        tbody.appendChild(tr);
      });
    }

    function exportData() { window.open('/export', '_blank'); }
    function clearOnlineList() { if(confirm('确定清空在线列表？')) socket.emit('teacher-clear-online'); }

    loadRank();
    setInterval(loadRank, 30000);
    setInterval(() => socket.emit('teacher-request'), 10000);
  </script>
</body>
</html>`;
  res.send(html);
});

// ===================== 导出 Excel =====================
app.get('/export', (req, res) => {
  try {
    let csv = "\uFEFF排名,姓名,正确率,用时(秒)\n";
    scores.forEach((s, i) => {
      const name = String(s.name || '').replace(/,/g, '，');
      csv += `${i+1},${name},${s.rate}%,${s.time}\n`;
    });
    res.setHeader('Content-Type', 'application/vnd.ms-excel;charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('成绩表.xls')}`);
    res.send(csv);
  } catch (e) {
    res.status(500).send('导出失败');
  }
});

// ===================== 首页 =====================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ===================== 启动服务 =====================
const PORT = process.env.PORT || 3721;
server.listen(PORT, () => {
  console.log('=====================================');
  console.log('✅ 秦宫探案 · 服务已启动');
  console.log(`📱 访问端口：${PORT}`);
  console.log('=====================================');
});