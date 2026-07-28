/**
 * ============================================================
 *  孩子定位追踪 - 后端服务器（MongoDB 云数据库版）
 * ============================================================
 *  功能说明：
 *    1. 接收安卓App上报的GPS位置数据（POST /api/location）
 *    2. 提供设备注册接口（POST /api/device/register）
 *    3. 提供最新位置查询（GET /api/location/latest）
 *    4. 提供历史轨迹查询（GET /api/location/history）
 *    5. 同时托管Web前端静态文件
 *
 *  数据存储：MongoDB Atlas（持久化，Render 重启不丢数据）
 *  环境变量：
 *    PORT          - 服务端口（Render 自动设置）
 *    MONGODB_URI   - MongoDB 连接字符串（必填）
 * ============================================================
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { MongoClient, ServerApiVersion } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

// ============ 中间件 ============
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ============ MongoDB 连接 ============
let client = null;
let db = null;
let devicesCollection = null;
let locationsCollection = null;

/**
 * 初始化 MongoDB 连接
 */
async function initMongoDB() {
  if (!MONGODB_URI) {
    throw new Error('缺少环境变量 MONGODB_URI，请在 Render 中配置 MongoDB 连接字符串');
  }

  try {
    client = new MongoClient(MONGODB_URI, {
      serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
      },
      // 连接池配置，适合 Serverless/云平台
      maxPoolSize: 10,
      minPoolSize: 1,
    });

    await client.connect();
    db = client.db('child_tracker');
    devicesCollection = db.collection('devices');
    locationsCollection = db.collection('locations');

    // 创建索引，加速查询
    await devicesCollection.createIndex({ device_id: 1 }, { unique: true });
    await locationsCollection.createIndex({ device_id: 1, timestamp: -1 });

    console.log('[MongoDB] 连接成功');
  } catch (err) {
    console.error('[MongoDB] 连接失败:', err.message);
    throw err;
  }
}

// ============ API 路由 ============

/**
 * POST /api/device/register
 * 注册新设备（安卓App首次启动时调用）
 *
 * 请求体：{ device_name: "小明的手机", pin_code: "1234" }
 * 返回：{ device_id: "xxxx-xxxx-xxxx" }
 */
app.post('/api/device/register', async (req, res) => {
  try {
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

    const deviceDoc = {
      device_id: deviceId,
      device_name: device_name,
      pin_code: pin_code,
      created_at: createdAt
    };

    await devicesCollection.insertOne(deviceDoc);

    console.log(`[注册] 新设备：${device_name} (ID: ${deviceId})`);
    res.json({ device_id: deviceId, device_name, pin_code });
  } catch (err) {
    console.error('[注册] 失败:', err.message);
    res.status(500).json({ error: '注册失败：' + err.message });
  }
});

/**
 * POST /api/location
 * 上报位置数据（安卓App定时调用）
 */
app.post('/api/location', async (req, res) => {
  try {
    const { device_id, latitude, longitude, altitude, accuracy, speed, bearing, timestamp, battery_level, is_charging } = req.body;

    // 参数校验
    if (!device_id || latitude == null || longitude == null) {
      return res.status(400).json({ error: '缺少必要参数：device_id, latitude, longitude' });
    }

    // 验证设备是否存在
    const device = await devicesCollection.findOne({ device_id });
    if (!device) {
      return res.status(404).json({ error: '设备未注册，请先注册设备' });
    }

    // 如果没有提供时间戳，使用当前时间
    const ts = timestamp || new Date().toISOString();

    const locationDoc = {
      device_id: device_id,
      latitude: latitude,
      longitude: longitude,
      altitude: altitude || null,
      accuracy: accuracy || null,
      speed: speed || null,
      bearing: bearing || null,
      timestamp: ts,
      battery_level: battery_level != null ? battery_level : null,    // 电量百分比 0-100
      is_charging: is_charging != null ? is_charging : null,          // 是否充电中
      created_at: new Date()
    };

    await locationsCollection.insertOne(locationDoc);

    console.log(`[定位] ${device.device_name}: ${latitude}, ${longitude} @ ${ts} | 电量: ${battery_level != null ? battery_level + '%' : '--'}`);
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('[定位] 失败:', err.message);
    res.status(500).json({ error: '上报失败：' + err.message });
  }
});

/**
 * POST /api/location/batch
 * 批量上报位置数据（安卓App网络恢复后批量上传）
 */
app.post('/api/location/batch', async (req, res) => {
  try {
    const { device_id, locations } = req.body;

    if (!device_id || !Array.isArray(locations) || locations.length === 0) {
      return res.status(400).json({ error: '缺少必要参数或位置列表为空' });
    }

    const device = await devicesCollection.findOne({ device_id });
    if (!device) {
      return res.status(404).json({ error: '设备未注册' });
    }

    // 批量添加位置记录
    const docs = locations.map(loc => ({
      device_id: device_id,
      latitude: loc.latitude,
      longitude: loc.longitude,
      altitude: loc.altitude || null,
      accuracy: loc.accuracy || null,
      speed: loc.speed || null,
      bearing: loc.bearing || null,
      timestamp: loc.timestamp || new Date().toISOString(),
      battery_level: loc.battery_level != null ? loc.battery_level : null,
      is_charging: loc.is_charging != null ? loc.is_charging : null,
      created_at: new Date()
    }));

    await locationsCollection.insertMany(docs);

    console.log(`[批量定位] ${device.device_name}: ${locations.length} 条记录`);
    res.json({ status: 'ok', count: locations.length });
  } catch (err) {
    console.error('[批量定位] 失败:', err.message);
    res.status(500).json({ error: '批量上报失败：' + err.message });
  }
});

/**
 * GET /api/location/latest?device_id=xxx&pin_code=xxx
 * 获取设备最新位置（Web端调用）
 */
app.get('/api/location/latest', async (req, res) => {
  try {
    const { device_id, pin_code } = req.query;

    if (!device_id || !pin_code) {
      return res.status(400).json({ error: '缺少必要参数：device_id, pin_code' });
    }

    const device = await devicesCollection.findOne({ device_id });
    if (!device) {
      return res.status(404).json({ error: '设备不存在' });
    }
    if (device.pin_code !== pin_code) {
      return res.status(403).json({ error: 'PIN码错误' });
    }

    // 查找该设备的最新位置（按时间戳倒序，取第一条）
    const latest = await locationsCollection
      .find({ device_id })
      .sort({ timestamp: -1 })
      .limit(1)
      .next();

    res.json({
      device_name: device.device_name,
      location: latest || null
    });
  } catch (err) {
    console.error('[最新位置] 失败:', err.message);
    res.status(500).json({ error: '查询失败：' + err.message });
  }
});

/**
 * GET /api/location/history?device_id=xxx&pin_code=xxx&start=xxx&end=xxx
 * 获取历史轨迹（Web端调用）
 */
app.get('/api/location/history', async (req, res) => {
  try {
    const { device_id, pin_code, start, end } = req.query;

    if (!device_id || !pin_code) {
      return res.status(400).json({ error: '缺少必要参数：device_id, pin_code' });
    }

    const device = await devicesCollection.findOne({ device_id });
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

    const startDate = new Date(startTime);
    const endDate = new Date(endTime);

    // 查询时间范围内的位置记录
    const history = await locationsCollection
      .find({
        device_id: device_id,
        timestamp: {
          $gte: startDate.toISOString(),
          $lte: endDate.toISOString()
        }
      })
      .sort({ timestamp: 1 })
      .toArray();

    console.log(`[历史轨迹] ${device.device_name}: ${history.length} 条记录`);
    res.json({
      device_name: device.device_name,
      start: startTime,
      end: endTime,
      count: history.length,
      points: history
    });
  } catch (err) {
    console.error('[历史轨迹] 失败:', err.message);
    res.status(500).json({ error: '查询失败：' + err.message });
  }
});

/**
 * GET /api/device/info?device_id=xxx&pin_code=xxx
 * 获取设备信息
 */
app.get('/api/device/info', async (req, res) => {
  try {
    const { device_id, pin_code } = req.query;

    if (!device_id || !pin_code) {
      return res.status(400).json({ error: '缺少必要参数：device_id, pin_code' });
    }

    const device = await devicesCollection.findOne({ device_id });
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
  } catch (err) {
    console.error('[设备信息] 失败:', err.message);
    res.status(500).json({ error: '查询失败：' + err.message });
  }
});

// ============ 静态文件托管（Web前端） ============
app.use('/web', express.static(path.join(__dirname, 'web')));

// 根路径重定向到Web页面
app.get('/', (req, res) => {
  res.redirect('/web');
});

// ============ 启动服务器 ============
async function startServer() {
  try {
    await initMongoDB();

    app.listen(PORT, '0.0.0.0', () => {
      console.log('═══════════════════════════════════════════');
      console.log(`  孩子定位追踪服务已启动`);
      console.log(`  Web页面:  http://localhost:${PORT}/web`);
      console.log(`  API地址:  http://localhost:${PORT}/api`);
      console.log(`  数据库:   MongoDB Atlas`);
      console.log('═══════════════════════════════════════════');
    });
  } catch (err) {
    console.error('服务器启动失败:', err.message);
    process.exit(1);
  }
}

// 应用关闭时清理 MongoDB 连接
process.on('SIGINT', async () => {
  if (client) {
    await client.close();
    console.log('[MongoDB] 连接已关闭');
  }
  process.exit(0);
});

startServer();
