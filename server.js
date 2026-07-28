/**
 * ============================================================
 *  孩子定位追踪 - 后端服务器
 * ============================================================
 *  功能说明：
 *    1. 接收安卓App上报的GPS位置数据（POST /api/location）
 *    2. 提供设备注册接口（POST /api/device/register）
 *    3. 提供最新位置查询（GET /api/location/latest）
 *    4. 提供历史轨迹查询（GET /api/location/history）
 *    5. 同时托管Web前端静态文件
 *
 *  数据存储：JSON文件（纯JS实现，无需编译原生模块）
 * ============================================================
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ============ 中间件 ============
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ============ JSON文件数据库 ============
// 使用简单的JSON文件存储，适合家庭级应用（数据量不大）
// 数据结构：{ devices: {}, locations: {} }

const DB_FILE = path.join(__dirname, 'tracker_db.json');

// 内存中的数据缓存（定期写入文件）
let db = {
  devices: {},    // { device_id: { device_name, pin_code, created_at } }
  locations: []   // [{ id, device_id, latitude, longitude, altitude, accuracy, speed, bearing, timestamp }]
};

// 自增ID计数器
let locationIdCounter = 1;

/**
 * 从文件加载数据库
 */
function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf-8');
      db = JSON.parse(raw);
      // 恢复自增ID
      if (db.locations && db.locations.length > 0) {
        locationIdCounter = Math.max(...db.locations.map(l => l.id || 0)) + 1;
      }
      console.log(`[数据库] 已加载: ${Object.keys(db.devices).length} 设备, ${db.locations.length} 位置记录`);
    } else {
      console.log('[数据库] 文件不存在，将创建新数据库');
      saveDB();
    }
  } catch (err) {
    console.error('[数据库] 加载失败:', err.message);
  }
}

/**
 * 保存数据库到文件（同步写入）
 */
function saveDB() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf-8');
  } catch (err) {
    console.error('[数据库] 保存失败:', err.message);
  }
}

// 启动时加载数据
loadDB();

// ============ API 路由 ============

/**
 * POST /api/device/register
 * 注册新设备（安卓App首次启动时调用）
 *
 * 请求体：{ device_name: "小明的手机", pin_code: "1234" }
 * 返回：{ device_id: "xxxx-xxxx-xxxx" }
 */
app.post('/api/device/register', (req, res) => {
  const { device_name, pin_code } = req.body;

  // 参数校验
  if (!device_name || !pin_code) {
    return res.status(400).json({ error: '缺少必要参数：device_name, pin_code' });
  }
  if (pin_code.length < 4) {
    return res.status(400).json({ error: 'PIN码至少4位' });
  }

  // 生成设备ID（UUID格式）
  const deviceId = crypto.randomUUID();
  const createdAt = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

  // 存入数据库
  db.devices[deviceId] = {
    device_id: deviceId,
    device_name: device_name,
    pin_code: pin_code,
    created_at: createdAt
  };
  saveDB();

  console.log(`[注册] 新设备：${device_name} (ID: ${deviceId})`);
  res.json({ device_id: deviceId, device_name, pin_code });
});

/**
 * POST /api/location
 * 上报位置数据（安卓App定时调用）
 *
 * 请求体：{
 *   device_id: "xxxx",
 *   latitude: 39.9042,
 *   longitude: 116.4074,
 *   altitude: 50,
 *   accuracy: 10,
 *   speed: 0,
 *   bearing: 0,
 *   timestamp: "2025-01-01T12:00:00Z"
 * }
 */
app.post('/api/location', (req, res) => {
  const { device_id, latitude, longitude, altitude, accuracy, speed, bearing, timestamp } = req.body;

  // 参数校验
  if (!device_id || latitude == null || longitude == null) {
    return res.status(400).json({ error: '缺少必要参数：device_id, latitude, longitude' });
  }

  // 验证设备是否存在
  const device = db.devices[device_id];
  if (!device) {
    return res.status(404).json({ error: '设备未注册，请先注册设备' });
  }

  // 如果没有提供时间戳，使用当前时间
  const ts = timestamp || new Date().toISOString();

  // 添加位置记录
  db.locations.push({
    id: locationIdCounter++,
    device_id: device_id,
    latitude: latitude,
    longitude: longitude,
    altitude: altitude || null,
    accuracy: accuracy || null,
    speed: speed || null,
    bearing: bearing || null,
    timestamp: ts
  });
  saveDB();

  console.log(`[定位] ${device.device_name}: ${latitude}, ${longitude} @ ${ts}`);
  res.json({ status: 'ok' });
});

/**
 * POST /api/location/batch
 * 批量上报位置数据（安卓App网络恢复后批量上传）
 *
 * 请求体：{ device_id: "xxxx", locations: [ {latitude, longitude, ...}, ... ] }
 */
app.post('/api/location/batch', (req, res) => {
  const { device_id, locations } = req.body;

  if (!device_id || !Array.isArray(locations) || locations.length === 0) {
    return res.status(400).json({ error: '缺少必要参数或位置列表为空' });
  }

  const device = db.devices[device_id];
  if (!device) {
    return res.status(404).json({ error: '设备未注册' });
  }

  // 批量添加位置记录
  for (const loc of locations) {
    const ts = loc.timestamp || new Date().toISOString();
    db.locations.push({
      id: locationIdCounter++,
      device_id: device_id,
      latitude: loc.latitude,
      longitude: loc.longitude,
      altitude: loc.altitude || null,
      accuracy: loc.accuracy || null,
      speed: loc.speed || null,
      bearing: loc.bearing || null,
      timestamp: ts
    });
  }
  saveDB();

  console.log(`[批量定位] ${device.device_name}: ${locations.length} 条记录`);
  res.json({ status: 'ok', count: locations.length });
});

/**
 * GET /api/location/latest?device_id=xxx&pin_code=xxx
 * 获取设备最新位置（Web端调用）
 */
app.get('/api/location/latest', (req, res) => {
  const { device_id, pin_code } = req.query;

  if (!device_id || !pin_code) {
    return res.status(400).json({ error: '缺少必要参数：device_id, pin_code' });
  }

  const device = db.devices[device_id];
  if (!device) {
    return res.status(404).json({ error: '设备不存在' });
  }
  if (device.pin_code !== pin_code) {
    return res.status(403).json({ error: 'PIN码错误' });
  }

  // 查找该设备的最新位置
  const deviceLocations = db.locations.filter(l => l.device_id === device_id);
  const latest = deviceLocations.length > 0
    ? deviceLocations[deviceLocations.length - 1]
    : null;

  res.json({
    device_name: device.device_name,
    location: latest
  });
});

/**
 * GET /api/location/history?device_id=xxx&pin_code=xxx&start=2025-01-01&end=2025-01-02
 * 获取历史轨迹（Web端调用）
 *
 * 参数说明：
 *   start - 起始时间（ISO 8601 或 YYYY-MM-DD 格式）
 *   end   - 结束时间（ISO 8601 或 YYYY-MM-DD 格式）
 *   不传 start/end 时默认查最近24小时
 */
app.get('/api/location/history', (req, res) => {
  const { device_id, pin_code, start, end } = req.query;

  if (!device_id || !pin_code) {
    return res.status(400).json({ error: '缺少必要参数：device_id, pin_code' });
  }

  const device = db.devices[device_id];
  if (!device) {
    return res.status(404).json({ error: '设备不存在' });
  }
  if (device.pin_code !== pin_code) {
    return res.status(403).json({ error: 'PIN码错误' });
  }

  // 默认查询最近24小时的数据
  const now = new Date();
  const startTime = start || new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const endTime = end || now.toISOString();

  // 将输入时间转为Date对象用于比较
  const startDate = new Date(startTime);
  const endDate = new Date(endTime);

  // 筛选时间范围内的位置记录
  const history = db.locations
    .filter(l => l.device_id === device_id)
    .filter(l => {
      const locDate = new Date(l.timestamp);
      return locDate >= startDate && locDate <= endDate;
    })
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  console.log(`[历史轨迹] ${device.device_name}: ${history.length} 条记录`);
  res.json({
    device_name: device.device_name,
    start: startTime,
    end: endTime,
    count: history.length,
    points: history
  });
});

/**
 * GET /api/device/info?device_id=xxx&pin_code=xxx
 * 获取设备信息
 */
app.get('/api/device/info', (req, res) => {
  const { device_id, pin_code } = req.query;

  if (!device_id || !pin_code) {
    return res.status(400).json({ error: '缺少必要参数：device_id, pin_code' });
  }

  const device = db.devices[device_id];
  if (!device) {
    return res.status(404).json({ error: '设备不存在' });
  }
  if (device.pin_code !== pin_code) {
    return res.status(403).json({ error: 'PIN码错误' });
  }

  res.json({
    device_id: device.device_id,
    device_name: device.device_name,
    created_at: device.created_at
  });
});

// ============ 静态文件托管（Web前端） ============
// 云部署版本：web 目录在同级目录下
app.use('/web', express.static(path.join(__dirname, 'web')));

// 根路径重定向到Web页面
app.get('/', (req, res) => {
  res.redirect('/web');
});

// ============ 启动服务器 ============
// Render等云平台会自动设置 PORT 环境变量
app.listen(PORT, '0.0.0.0', () => {
  console.log('═══════════════════════════════════════════');
  console.log(`  孩子定位追踪服务已启动`);
  console.log(`  Web页面:  http://localhost:${PORT}/web`);
  console.log(`  API地址:  http://localhost:${PORT}/api`);
  console.log(`  数据库:   ${DB_FILE}`);
  console.log('═══════════════════════════════════════════');
});
