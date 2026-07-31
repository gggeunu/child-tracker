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
const { MongoClient } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

// 捕获未处理的异常，确保错误信息能输出到日志
process.on('uncaughtException', (err) => {
  console.log('[致命错误] uncaughtException:', err.message);
  console.log('[致命错误] 堆栈:', err.stack);
  setTimeout(() => process.exit(1), 500);
});
process.on('unhandledRejection', (reason) => {
  console.log('[致命错误] unhandledRejection:', reason);
  setTimeout(() => process.exit(1), 500);
});

// ============ 中间件 ============
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ============ MongoDB 连接 ============
let client = null;
let db = null;
let devicesCollection = null;
let locationsCollection = null;

/**
 * 将 mongodb:// 标准连接字符串转换为 mongodb+srv:// 格式
 * 
 * Atlas 的 mongodb:// 格式在 Render 等云平台上存在 TLS 兼容性问题（SSL alert 80），
 * 因为直接连接 shard 主机时，TLS SNI 主机名与 Atlas 证书不匹配。
 * mongodb+srv:// 通过 DNS SRV 记录自动发现可用主机，并正确配置 TLS。
 *
 * 使用 URL 对象解析（比正则更可靠，能正确处理密码中的特殊字符）
 *
 * 示例：
 *   输入: mongodb://user:p%40ss@cluster0-shard-00-00.abcd.mongodb.net:27017,cluster0-shard-00-01.abcd.mongodb.net:27017,cluster0-shard-00-02.abcd.mongodb.net:27017/?ssl=true&replicaSet=atlas-abcd-shard-0&authSource=admin&retryWrites=true&w=majority
 *   输出: mongodb+srv://user:p%40ss@cluster0.abcd.mongodb.net/?authSource=admin&retryWrites=true&w=majority
 */
function convertToSrv(uri) {
  // 只处理 Atlas 的 mongodb:// 格式
  if (!uri.startsWith('mongodb://') || !uri.includes('mongodb.net')) {
    return { uri, converted: false };
  }

  try {
    // ---- 第一步：提取认证部分和主机列表部分 ----
    // mongodb://[user:password@]host1:port1,host2:port2,.../database?params
    // URL 对象无法解析包含多个逗号分隔主机的 URI，需要手动拆分
    
    const protocolEnd = 'mongodb://'.length;
    const atIdx = uri.indexOf('@', protocolEnd);
    
    let authPart = '';
    let hostsAndRest = '';
    
    if (atIdx !== -1) {
      // 有认证信息: mongodb://user:pass@hosts...
      authPart = uri.substring(protocolEnd, atIdx);
      hostsAndRest = uri.substring(atIdx + 1);
    } else {
      // 无认证信息: mongodb://hosts...
      hostsAndRest = uri.substring(protocolEnd);
    }

    // ---- 第二步：从第一个主机名提取 SRV 主机名 ----
    // cluster0-shard-00-00.abcd.mongodb.net:27017 → cluster0.abcd.mongodb.net
    // 找第一个主机名（在逗号或 / 之前，去掉端口）
    const slashIdx = hostsAndRest.indexOf('/');
    const hostsSection = slashIdx !== -1 
      ? hostsAndRest.substring(0, slashIdx) 
      : hostsAndRest.split('?')[0];
    
    // 取第一个主机（逗号之前），去掉端口
    const firstHostWithPort = hostsSection.split(',')[0].trim();
    const firstHost = firstHostWithPort.split(':')[0].trim();
    
    // 移除 -shard-XX-XX 后缀 → 得到 SRV 主机名
    // cluster0-shard-00-00.abcd.mongodb.net → cluster0.abcd.mongodb.net
    const srvHost = firstHost.replace(/-shard-\d+-\d+/, '');

    // ---- 第三步：提取并过滤查询参数 ----
    const queryIdx = hostsAndRest.indexOf('?');
    let params = '';
    if (queryIdx !== -1) {
      const queryString = hostsAndRest.substring(queryIdx + 1);
      // SRV 格式不需要：ssl, tls, replicaSet（驱动自动处理）
      const filtered = queryString
        .split('&')
        .filter(p => {
          const key = p.split('=')[0];
          return key !== 'ssl' && key !== 'tls' && key !== 'replicaSet';
        });
      params = filtered.length > 0 ? '?' + filtered.join('&') : '';
    }

    // ---- 第四步：构建 mongodb+srv:// URI ----
    const authPrefix = authPart ? authPart + '@' : '';
    const newUri = `mongodb+srv://${authPrefix}${srvHost}/${params}`;
    
    return { uri: newUri, converted: true };
  } catch (e) {
    console.log('[转换] 转换失败:', e.message);
    return { uri, converted: false };
  }
}

/**
 * 初始化 MongoDB 连接
 */
async function initMongoDB() {
  // 检查环境变量是否配置
  if (!MONGODB_URI) {
    console.log('========================================');
    console.log('  [错误] 环境变量 MONGODB_URI 未设置！');
    console.log('  请在 Render 后台 → Environment 中添加：');
    console.log('  Key:   MONGODB_URI');
    console.log('  Value: mongodb+srv:// 格式的连接字符串');
    console.log('========================================');
    throw new Error('MONGODB_URI 未设置');
  }

  // 诊断原始连接字符串
  let uri = MONGODB_URI;
  const isSrv = uri.startsWith('mongodb+srv://');
  const isStandard = uri.startsWith('mongodb://');
  
  console.log('[启动] MONGODB_URI 已配置，长度:', uri.length);
  console.log('[启动] 原始协议:', isSrv ? 'mongodb+srv://' : isStandard ? 'mongodb://' : '未知');
  // 打印连接字符串（隐藏密码）
  const masked = uri.replace(/(mongodb(?:\+srv)?:\/\/[^:]+:)[^@]+(@)/, '$1****$2');
  console.log('[启动] 连接字符串（隐藏密码）:', masked);

  // 如果是 mongodb:// 格式，自动转换为 mongodb+srv://
  // Atlas 的 mongodb:// 格式在云平台上有 TLS 兼容性问题
  if (isStandard && uri.includes('mongodb.net')) {
    console.log('[启动] ⚠️ 检测到 mongodb:// 格式，Atlas 需要使用 mongodb+srv://');
    console.log('[启动] 正在自动转换为 mongodb+srv:// ...');
    const result = convertToSrv(uri);
    if (result.converted) {
      const maskedResult = result.uri.replace(/(mongodb\+srv:\/\/[^:]+:)[^@]+(@)/, '$1****$2');
      console.log('[启动] ✅ 转换成功:', maskedResult);
      uri = result.uri;
    } else {
      console.log('[启动] ❌ 自动转换失败！');
      console.log('[启动] 请手动获取 mongodb+srv:// 连接字符串：');
      console.log('[启动]   1. 登录 MongoDB Atlas (cloud.mongodb.com)');
      console.log('[启动]   2. Database → Connect → Connect your application');
      console.log('[启动]   3. Driver: Node.js / Version: 3.6 or later');
      console.log('[启动]   4. 复制 mongodb+srv:// 连接字符串');
      console.log('[启动]   5. 替换 <password> 为实际密码');
      console.log('[启动]   6. 在 Render → Environment → 更新 MONGODB_URI');
      throw new Error('mongodb:// 格式不兼容，需要使用 mongodb+srv://');
    }
  }

  // 如果既不是 mongodb+srv:// 也不是 mongodb://，说明格式有问题
  if (!isSrv && !isStandard) {
    console.log('[启动] ❌ 连接字符串格式不正确！');
    console.log('[启动] 必须以 mongodb:// 或 mongodb+srv:// 开头');
    throw new Error('MONGODB_URI 格式不正确');
  }

  try {
    // mongodb+srv:// 会自动启用 TLS，不需要手动设置
    // 只保留必要的连接池和超时配置
    const clientOptions = {
      maxPoolSize: 10,
      minPoolSize: 1,
      serverSelectionTimeoutMS: 10000,
    };

    client = new MongoClient(uri, clientOptions);

    console.log('[MongoDB] 正在连接...');
    await client.connect();
    console.log('[MongoDB] ✅ connect() 完成');

    db = client.db('child_tracker');
    devicesCollection = db.collection('devices');
    locationsCollection = db.collection('locations');

    // 创建索引，加速查询
    await devicesCollection.createIndex({ device_id: 1 }, { unique: true });
    await devicesCollection.createIndex({ device_fingerprint: 1 }, { sparse: true }); // ★ v1.3.0：设备指纹索引（允许null）
    await locationsCollection.createIndex({ device_id: 1, timestamp: -1 });

    console.log('[MongoDB] ✅ 连接成功，索引创建完成');
  } catch (err) {
    console.log('========================================');
    console.log('[MongoDB] ❌ 连接失败！');
    console.log('错误类型:', err.name);
    console.log('错误信息:', err.message);
    console.log('');
    
    // 针对不同错误类型给出具体建议
    if (err.message.includes('SSL') || err.message.includes('tls') || err.message.includes('ssl3')) {
      console.log('⚡ SSL/TLS 错误排查：');
      console.log('  → 你当前的 MONGODB_URI 可能是 mongodb:// 格式');
      console.log('  → Atlas 要求使用 mongodb+srv:// 格式（自动处理 TLS）');
      console.log('  → 修改步骤：');
      console.log('     1. 登录 MongoDB Atlas (cloud.mongodb.com)');
      console.log('     2. Database → Connect → Connect your application');
      console.log('     3. Driver: Node.js / Version: 3.6 or later');
      console.log('     4. 复制 mongodb+srv:// 连接字符串');
      console.log('     5. 把 <password> 替换为实际密码');
      console.log('     6. 在 Render → Environment → 更新 MONGODB_URI');
    } else if (err.message.includes('ENOTFOUND') || err.message.includes('getaddrinfo')) {
      console.log('⚡ DNS 解析失败排查：');
      console.log('  → 连接字符串中的主机名可能不正确');
      console.log('  → 或 Atlas 集群已暂停 → Atlas → Database → Resume');
    } else if (err.message.includes('Authentication') || err.message.includes('auth')) {
      console.log('⚡ 认证失败排查：');
      console.log('  → 用户名或密码不正确');
      console.log('  → 密码中的特殊字符需要 URL 编码');
      console.log('     @ → %40, : → %3A, / → %2F, ? → %3F, # → %23');
    } else {
      console.log('⚡ 通用排查：');
      console.log('  1. Atlas → Network Access → Add IP → 0.0.0.0/0');
      console.log('  2. Atlas 集群是否暂停 → Database → Resume');
      console.log('  3. MONGODB_URI 是否为 mongodb+srv:// 格式');
    }
    console.log('========================================');
    throw err;
  }
}

// ============ API 路由 ============

/**
 * POST /api/device/register
 * 注册新设备（安卓App首次启动时调用）
 *
 * ★ v1.3.0 新增：设备指纹（device_fingerprint）绑定
 *   - App 使用 Android ID 作为设备指纹（卸载重装不变）
 *   - 如果指纹匹配已有设备 → 返回原有 device_id 和 pin_code（PIN码固定）
 *   - 如果不匹配 → 创建新设备
 *
 * 请求体：{ device_name: "小明的手机", pin_code: "1234", device_fingerprint: "abc123..." }
 * 返回：{ device_id: "xxxx-xxxx-xxxx", device_name: "...", pin_code: "..." }
 */
app.post('/api/device/register', async (req, res) => {
  try {
    const { device_name, pin_code, device_fingerprint } = req.body;

    // 参数校验
    if (!device_name || !pin_code) {
      return res.status(400).json({ error: '缺少必要参数：device_name, pin_code' });
    }
    if (pin_code.length < 4) {
      return res.status(400).json({ error: 'PIN码至少4位' });
    }

    // ★ v1.3.0：如果提供了设备指纹，检查是否已注册过
    // 同一台手机卸载重装 App 后，ANDROID_ID 不变，服务器返回原有设备信息
    if (device_fingerprint) {
      const existingDevice = await devicesCollection.findOne({ device_fingerprint });
      if (existingDevice) {
        // 设备已存在（指纹匹配）→ 返回原有 device_id 和 pin_code
        // 这样卸载重装后 PIN 码保持不变
        console.log(`[注册] 设备已存在（指纹匹配）：${existingDevice.device_name} (ID: ${existingDevice.device_id})`);
        return res.json({
          device_id: existingDevice.device_id,
          device_name: existingDevice.device_name,
          pin_code: existingDevice.pin_code
        });
      }
    }

    // 生成设备ID（UUID格式）
    const deviceId = crypto.randomUUID();
    const createdAt = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

    const deviceDoc = {
      device_id: deviceId,
      device_name: device_name,
      pin_code: pin_code,
      device_fingerprint: device_fingerprint || null,  // ★ v1.3.0：存储设备指纹
      created_at: createdAt
    };

    await devicesCollection.insertOne(deviceDoc);

    console.log(`[注册] 新设备：${device_name} (ID: ${deviceId}, 指纹: ${device_fingerprint ? '有' : '无'})`);
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
  console.log('========================================');
  console.log('  孩子定位追踪服务正在启动...');
  console.log('  Node.js 版本:', process.version);
  console.log('  端口:', PORT);
  console.log('  MONGODB_URI:', MONGODB_URI ? '已设置' : '未设置');
  console.log('========================================');

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
    console.log('========================================');
    console.log('服务器启动失败:', err.message);
    console.log('========================================');
    // 延迟退出，确保日志已刷新到 Render 控制台
    setTimeout(() => process.exit(1), 1000);
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
