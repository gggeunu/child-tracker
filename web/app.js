/**
 * ============================================================
 *  孩子定位追踪 - Web前端逻辑
 * ============================================================
 *  功能模块：
 *    1. 登录鉴权（设备ID + PIN码）
 *    2. Leaflet地图初始化（高德瓦片 + WGS-84转GCJ-02）
 *    3. 实时位置展示（自动刷新）
 *    4. 历史轨迹查询与绘制
 *    5. 轨迹回放播放器
 *    6. 轨迹统计（点数、距离、时长）
 * ============================================================
 */

// ==================== 全局配置 ====================
// API基础地址
// 云端部署时：页面和API在同一域名下，走同源（留空即可）
// 本地开发时：如果通过 WorkBuddy 预览代理访问（端口不是3000），自动指向同主机的 3000 端口
// 也可以通过环境变量 API_BASE_URL 强制指定（在 index.html 中注入）
const API_BASE = window.__API_BASE__ || (function() {
  const host = window.location.hostname;
  const port = window.location.port;
  const protocol = window.location.protocol;

  // 本地开发环境：访问页面不是 3000 端口时，指向本机的 3000 端口后端
  // 例如 WorkBuddy 预览在 12480 端口，需要跳转到 3000
  if ((host === 'localhost' || host === '127.0.0.1') && port !== '3000') {
    return `${protocol}//${host}:3000`;
  }

  // 其他情况（包括云端部署、局域网 IP 直接访问）：走同源，不附加端口
  return '';
})();
const AUTO_REFRESH_INTERVAL = 60000; // 自动刷新间隔：60秒（与App上报间隔一致）

// ==================== 全局状态 ====================
let map = null;                  // Leaflet地图实例
let currentMarker = null;        // 当前位置标记
let trackPolyline = null;        // 轨迹连线
let trackPointsLayer = null;     // 轨迹点图层组
let playbackMarker = null;       // 回放标记
let trackData = [];              // 当前加载的轨迹数据
let playbackTimer = null;        // 回放定时器
let playbackIndex = 0;           // 回放当前位置索引
let autoRefreshTimer = null;     // 自动刷新定时器
let session = {                  // 登录会话
  deviceId: '',
  pinCode: '',
  deviceName: ''
};

// ★ v1.5.0：摄像头照片轮询相关
let photoPollingTimer = null;    // 照片轮询定时器
let photoPollingCount = 0;       // 轮询计数（超过30次=60秒后停止）
let currentCameraType = 'front'; // 当前拍照的摄像头类型："front" 或 "back"
// ★ v1.5.2：记录上次显示的照片信息，用于"重新拍照"时跳过旧照片
let lastPhotoCreatedAt = null;   // 上次显示照片的 created_at（ISO时间戳）
let currentRequestId = null;     // 当前拍照命令的 request_id

// ==================== WGS-84 转 GCJ-02 坐标转换 ====================
// GPS原始坐标(WGS-84)需要转换为火星坐标(GCJ-02)才能在高德地图上正确显示
// 这是中国地图偏移标准，详见：https://en.wikipedia.org/wiki/Restrictions_on_geographic_data_in_China

const PI = Math.PI;
const A = 6378245.0;                    // 长半轴
const EE = 0.00669342162296594323;      // 偏心率平方

/**
 * 判断坐标是否在中国境外（境外不需要偏移）
 */
function outOfChina(lng, lat) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(y * PI) + 40.0 * Math.sin(y / 3.0 * PI)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin(y / 12.0 * PI) + 320 * Math.sin(y * PI / 30.0)) * 2.0 / 3.0;
  return ret;
}

function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(x * PI) + 40.0 * Math.sin(x / 3.0 * PI)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin(x / 12.0 * PI) + 300.0 * Math.sin(x / 30.0 * PI)) * 2.0 / 3.0;
  return ret;
}

/**
 * WGS-84 转 GCJ-02
 * @param {number} wgsLng - WGS-84经度
 * @param {number} wgsLat - WGS-84纬度
 * @returns {{lng: number, lat: number}} GCJ-02坐标
 */
function wgs84ToGcj02(wgsLng, wgsLat) {
  if (outOfChina(wgsLng, wgsLat)) {
    return { lng: wgsLng, lat: wgsLat };
  }
  let dLat = transformLat(wgsLng - 105.0, wgsLat - 35.0);
  let dLng = transformLng(wgsLng - 105.0, wgsLat - 35.0);
  const radLat = wgsLat / 180.0 * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((A * (1 - EE)) / (magic * sqrtMagic) * PI);
  dLng = (dLng * 180.0) / (A / sqrtMagic * Math.cos(radLat) * PI);
  return {
    lng: wgsLng + dLng,
    lat: wgsLat + dLat
  };
}

// ==================== 地图初始化 ====================

/**
 * 初始化Leaflet地图
 * 使用高德地图瓦片（无需API Key），配合坐标转换实现准确定位
 */
function initMap() {
  map = L.map('map', {
    zoomControl: true,
    attributionControl: false
  }).setView([39.9042, 116.4074], 13); // 默认北京中心

  // 高德地图瓦片层（标准地图样式）
  L.tileLayer('https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}', {
    subdomains: ['1', '2', '3', '4'],
    maxZoom: 19,
    attribution: '高德地图'
  }).addTo(map);

  // 叠加高德卫星图层（可切换）
  // L.tileLayer('https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}', {
  //   subdomains: ['1', '2', '3', '4'],
  //   maxZoom: 19
  // }).addTo(map);
}

// ==================== API 请求封装 ====================

/**
 * 发送GET请求
 * 使用 window.location.origin 作为基础URL，并自动对参数编码
 * 增强容错：先读取文本再解析JSON，避免服务器返回空body时直接崩溃
 */
async function apiGet(endpoint, params = {}) {
  // 强制使用当前页面的协议+主机作为API基础地址，避免路径前缀干扰
  const baseUrl = window.location.origin || (window.location.protocol + '//' + window.location.host);
  const url = new URL(`${API_BASE}${endpoint}`, baseUrl);
  Object.entries(params).forEach(([k, v]) => {
    if (v != null) url.searchParams.append(k, v);
  });

  let resp;
  try {
    resp = await fetch(url.toString());
  } catch (netErr) {
    throw new Error(`网络请求失败，请检查服务器是否运行。URL: ${url}`);
  }

  const text = await resp.text();
  if (!text) {
    throw new Error(`服务器返回空响应 (HTTP ${resp.status} ${resp.statusText})，请确认API地址正确：${url}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (parseErr) {
    throw new Error(`服务器返回非JSON数据 (HTTP ${resp.status})，URL: ${url}`);
  }

  if (!resp.ok) {
    throw new Error(data.error || `请求失败 (HTTP ${resp.status})`);
  }
  return data;
}

// ==================== 登录处理 ====================

/**
 * 处理登录表单提交
 */
async function handleLogin(e) {
  e.preventDefault();
  const deviceId = document.getElementById('deviceId').value.trim();
  const pinCode = document.getElementById('pinCode').value.trim();
  const errorEl = document.getElementById('loginError');
  errorEl.textContent = '';

  // 基础校验
  if (!deviceId) {
    errorEl.textContent = '请输入设备ID';
    return;
  }
  if (!pinCode) {
    errorEl.textContent = '请输入PIN码';
    return;
  }
  if (!/^[0-9a-fA-F-]{36}$/.test(deviceId) && !/^[0-9a-zA-Z-]{10,}$/.test(deviceId)) {
    // 不是常见的UUID格式，提醒用户
    errorEl.textContent = '设备ID格式不正确，请从App中复制完整的设备ID（不是设备名称）';
    return;
  }

  try {
    // 验证设备ID和PIN码
    const data = await apiGet('/api/device/info', { device_id: deviceId, pin_code: pinCode });
    session = {
      deviceId: deviceId,
      pinCode: pinCode,
      deviceName: data.device_name
    };

    // 切换到主页面
    showMainPage();
  } catch (err) {
    errorEl.textContent = err.message;
  }
}

/**
 * 显示主页面
 */
function showMainPage() {
  document.getElementById('loginPage').style.display = 'none';
  document.getElementById('mainPage').style.display = 'grid';
  document.getElementById('deviceName').textContent = session.deviceName;

  // 初始化地图
  initMap();

  // 设置默认日期为今天
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('dateStart').value = today;
  document.getElementById('dateEnd').value = today;

  // 立即获取最新位置
  fetchLatestLocation();
}

/**
 * 退出登录
 */
function handleLogout() {
  // 停止自动刷新
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
  // 停止回放
  stopPlayback();
  // 清理地图
  clearTrack();
  if (currentMarker) {
    map.removeLayer(currentMarker);
    currentMarker = null;
  }
  // 重置会话
  session = { deviceId: '', pinCode: '', deviceName: '' };
  // 显示登录页
  document.getElementById('mainPage').style.display = 'none';
  document.getElementById('loginPage').style.display = 'flex';
  document.getElementById('loginForm').reset();
}

// ==================== 实时位置 ====================

/**
 * 获取并展示最新位置
 */
async function fetchLatestLocation() {
  try {
    const data = await apiGet('/api/location/latest', {
      device_id: session.deviceId,
      pin_code: session.pinCode
    });

    if (!data.location) {
      document.getElementById('lastUpdate').textContent = '暂无位置数据';
      return;
    }

    const loc = data.location;
    // 坐标转换：WGS-84 → GCJ-02
    const gcj = wgs84ToGcj02(loc.longitude, loc.latitude);

    // 更新或创建位置标记
    if (currentMarker) {
      currentMarker.setLatLng([gcj.lat, gcj.lng]);
    } else {
      // 自定义标记图标
      const icon = L.divIcon({
        className: 'live-marker',
        html: '<div style="width:20px;height:20px;background:#e94560;border-radius:50%;border:3px solid white;box-shadow:0 0 10px rgba(233,69,96,0.8);"></div>',
        iconSize: [20, 20],
        iconAnchor: [10, 10]
      });
      currentMarker = L.marker([gcj.lat, gcj.lng], { icon }).addTo(map);
    }

    // 弹窗信息（包含电量）
    const batteryText = loc.battery_level != null ? `${loc.battery_level}%${loc.is_charging ? ' 🔌充电中' : ''}` : '--';
    const popupContent = `
      <div style="font-size:14px;">
        <strong>${session.deviceName}</strong><br/>
        📍 ${loc.latitude.toFixed(6)}, ${loc.longitude.toFixed(6)}<br/>
        🎯 精度: ${loc.accuracy ? loc.accuracy.toFixed(1) + 'm' : '--'}<br/>
        🔋 电量: ${batteryText}<br/>
        🕐 ${formatTime(loc.timestamp)}
      </div>
    `;
    currentMarker.bindPopup(popupContent).openPopup();

    // 移动到该位置
    map.setView([gcj.lat, gcj.lng], 16);

    // 更新信息面板
    updateLocationInfo(loc);
  } catch (err) {
    document.getElementById('lastUpdate').textContent = '获取失败: ' + err.message;
  }
}

/**
 * 更新侧边面板的位置信息
 */
function updateLocationInfo(loc) {
  document.getElementById('currentCoord').textContent =
    `${loc.latitude.toFixed(6)}, ${loc.longitude.toFixed(6)}`;
  document.getElementById('currentAccuracy').textContent =
    loc.accuracy ? `${loc.accuracy.toFixed(1)} m` : '--';
  document.getElementById('currentSpeed').textContent =
    loc.speed ? `${(loc.speed * 3.6).toFixed(1)} km/h` : '静止';

  // 电量显示：百分比 + 充电状态
  const batteryEl = document.getElementById('currentBattery');
  if (loc.battery_level != null && loc.battery_level >= 0) {
    let batteryStr = `${loc.battery_level}%`;
    if (loc.is_charging) batteryStr += ' 🔌充电中';
    // 低电量标红
    if (loc.battery_level <= 20 && !loc.is_charging) {
      batteryEl.style.color = '#e94560';
    } else {
      batteryEl.style.color = '';
    }
    batteryEl.textContent = batteryStr;
  } else {
    batteryEl.textContent = '--';
    batteryEl.style.color = '';
  }

  document.getElementById('currentTimestamp').textContent = formatTime(loc.timestamp);
  document.getElementById('lastUpdate').textContent = `更新于 ${formatTime(loc.timestamp, true)}`;
}

// ==================== 历史轨迹 ====================

/**
 * 查询历史轨迹
 */
async function fetchHistory() {
  const dateStart = document.getElementById('dateStart').value;
  const dateEnd = document.getElementById('dateEnd').value;

  // 构造时间范围（开始日期的00:00 到 结束日期的23:59:59）
  const start = dateStart ? new Date(dateStart + 'T00:00:00').toISOString() : null;
  const end = dateEnd ? new Date(dateEnd + 'T23:59:59').toISOString() : null;

  try {
    const data = await apiGet('/api/location/history', {
      device_id: session.deviceId,
      pin_code: session.pinCode,
      start: start,
      end: end
    });

    trackData = data.points;
    drawTrack(trackData);
    updateTrackStats(trackData);

    // 启用回放控件
    if (trackData.length > 0) {
      document.getElementById('btnPlay').disabled = false;
      document.getElementById('progressSlider').disabled = false;
      document.getElementById('progressSlider').max = trackData.length - 1;
    }
  } catch (err) {
    alert('查询轨迹失败: ' + err.message);
  }
}

/**
 * 绘制轨迹到地图上
 */
function drawTrack(points) {
  // 先清除旧轨迹
  clearTrack();
  if (points.length === 0) return;

  // 坐标转换并构建路径
  const latlngs = points.map(p => {
    const gcj = wgs84ToGcj02(p.longitude, p.latitude);
    return [gcj.lat, gcj.lng];
  });

  // 绘制轨迹线（渐变色效果用多段线模拟）
  trackPolyline = L.polyline(latlngs, {
    color: '#e94560',
    weight: 4,
    opacity: 0.8,
    lineJoin: 'round',
    lineCap: 'round'
  }).addTo(map);

  // 绘制轨迹点
  trackPointsLayer = L.layerGroup();
  points.forEach((p, i) => {
    const gcj = wgs84ToGcj02(p.longitude, p.latitude);
    // 起点（绿色）、终点（红色）、中间点（小圆点）
    let color = '#4ecca3';
    let radius = 6;
    if (i === 0) { color = '#4ecca3'; radius = 8; }        // 起点
    else if (i === points.length - 1) { color = '#e94560'; radius = 8; } // 终点
    else { color = '#e94560'; radius = 3; }                 // 中间点

    const dot = L.circleMarker([gcj.lat, gcj.lng], {
      radius: radius,
      fillColor: color,
      color: '#fff',
      weight: 1,
      opacity: 1,
      fillOpacity: 0.8
    });

    // 弹窗信息（含电量）
    const ptBattery = p.battery_level != null ? `${p.battery_level}%${p.is_charging ? ' 🔌' : ''}` : '--';
    dot.bindPopup(`
      <div style="font-size:13px;">
        <strong>第 ${i + 1} 个点</strong><br/>
        📍 ${p.latitude.toFixed(6)}, ${p.longitude.toFixed(6)}<br/>
        🎯 ${p.accuracy ? p.accuracy.toFixed(1) + 'm' : '--'}<br/>
        🔋 ${ptBattery}<br/>
        🕐 ${formatTime(p.timestamp)}
      </div>
    `);
    trackPointsLayer.addLayer(dot);
  });
  trackPointsLayer.addTo(map);

  // 自动缩放地图到轨迹范围
  map.fitBounds(trackPolyline.getBounds(), { padding: [50, 50] });
}

/**
 * 清除地图上的轨迹
 */
function clearTrack() {
  if (trackPolyline) {
    map.removeLayer(trackPolyline);
    trackPolyline = null;
  }
  if (trackPointsLayer) {
    map.removeLayer(trackPointsLayer);
    trackPointsLayer = null;
  }
  stopPlayback();
  trackData = [];
  document.getElementById('btnPlay').disabled = true;
  document.getElementById('btnPause').disabled = true;
  document.getElementById('progressSlider').disabled = true;
  document.getElementById('progressSlider').value = 0;
  document.getElementById('progressLabel').textContent = '0 / 0';
}

/**
 * 更新轨迹统计信息
 */
function updateTrackStats(points) {
  document.getElementById('trackPoints').textContent = `${points.length} 个`;

  // 计算总距离（使用Haversine公式）
  let totalDistance = 0;
  for (let i = 1; i < points.length; i++) {
    totalDistance += haversineDistance(
      points[i - 1].latitude, points[i - 1].longitude,
      points[i].latitude, points[i].longitude
    );
  }
  document.getElementById('trackDistance').textContent =
    totalDistance > 1000 ? `${(totalDistance / 1000).toFixed(2)} km` : `${totalDistance.toFixed(0)} m`;

  // 计算时间跨度
  if (points.length >= 2) {
    const start = new Date(points[0].timestamp);
    const end = new Date(points[points.length - 1].timestamp);
    const duration = end - start;
    document.getElementById('trackDuration').textContent = formatDuration(duration);
  } else {
    document.getElementById('trackDuration').textContent = '--';
  }
}

/**
 * Haversine公式计算两点之间的距离（米）
 */
function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000; // 地球半径（米）
  const dLat = (lat2 - lat1) * PI / 180;
  const dLng = (lng2 - lng1) * PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * PI / 180) * Math.cos(lat2 * PI / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ==================== 轨迹回放 ====================

/**
 * 开始/继续回放
 */
function startPlayback() {
  if (trackData.length === 0) return;
  document.getElementById('btnPlay').disabled = true;
  document.getElementById('btnPause').disabled = false;

  playbackTimer = setInterval(() => {
    if (playbackIndex >= trackData.length) {
      stopPlayback();
      return;
    }

    const point = trackData[playbackIndex];
    const gcj = wgs84ToGcj02(point.longitude, point.latitude);

    // 更新回放标记
    if (playbackMarker) {
      playbackMarker.setLatLng([gcj.lat, gcj.lng]);
    } else {
      const icon = L.divIcon({
        className: '',
        html: '<div style="width:16px;height:16px;background:#4ecca3;border-radius:50%;border:3px solid white;box-shadow:0 0 15px rgba(78,204,163,0.9);"></div>',
        iconSize: [16, 16],
        iconAnchor: [8, 8]
      });
      playbackMarker = L.marker([gcj.lat, gcj.lng], { icon }).addTo(map);
    }

    // 更新进度条
    document.getElementById('progressSlider').value = playbackIndex;
    document.getElementById('progressLabel').textContent = `${playbackIndex + 1} / ${trackData.length}`;

    playbackIndex++;
  }, 500); // 每500ms前进一个点
}

/**
 * 暂停回放
 */
function pausePlayback() {
  if (playbackTimer) {
    clearInterval(playbackTimer);
    playbackTimer = null;
  }
  document.getElementById('btnPlay').disabled = false;
  document.getElementById('btnPause').disabled = true;
}

/**
 * 停止回放
 */
function stopPlayback() {
  pausePlayback();
  if (playbackMarker) {
    map.removeLayer(playbackMarker);
    playbackMarker = null;
  }
  playbackIndex = 0;
  document.getElementById('progressSlider').value = 0;
}

// ==================== 自动刷新 ====================

/**
 * 切换自动刷新
 */
function toggleAutoRefresh() {
  const enabled = document.getElementById('autoRefresh').checked;
  if (enabled) {
    autoRefreshTimer = setInterval(fetchLatestLocation, AUTO_REFRESH_INTERVAL);
  } else {
    if (autoRefreshTimer) {
      clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
    }
  }
}

// ==================== 工具函数 ====================

/**
 * 格式化时间显示
 */
function formatTime(ts, short = false) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  if (short) {
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 格式化时长
 */
function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}小时${m}分钟`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}

// ==================== 快捷时间选择 ====================

/**
 * 快捷选择最近N小时
 */
function quickSelectHours(hours) {
  const now = new Date();
  const start = new Date(now.getTime() - hours * 60 * 60 * 1000);

  document.getElementById('dateStart').value = start.toISOString().split('T')[0];
  document.getElementById('dateEnd').value = now.toISOString().split('T')[0];

  // 直接查询（用精确时间范围）
  queryWithTimeRange(start.toISOString(), now.toISOString());
}

/**
 * 使用精确时间范围查询
 */
async function queryWithTimeRange(startISO, endISO) {
  try {
    const data = await apiGet('/api/location/history', {
      device_id: session.deviceId,
      pin_code: session.pinCode,
      start: startISO,
      end: endISO
    });
    trackData = data.points;
    drawTrack(trackData);
    updateTrackStats(trackData);
    if (trackData.length > 0) {
      document.getElementById('btnPlay').disabled = false;
      document.getElementById('progressSlider').disabled = false;
      document.getElementById('progressSlider').max = trackData.length - 1;
    }
  } catch (err) {
    alert('查询轨迹失败: ' + err.message);
  }
}

// ==================== ★ v1.4.0：实时位置与摄像头拍照 ====================

/**
 * 获取实时位置（点击"实时位置"按钮）
 * 立即调用 API 获取最新位置，不需要等60秒自动刷新
 */
async function fetchLiveLocation() {
  const btn = document.getElementById('btnLiveLocation');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '📍 定位中...';
  }

  try {
    await fetchLatestLocation();
  } finally {
    // 恢复按钮状态
    setTimeout(() => {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '📍 实时位置';
      }
    }, 1000);
  }
}

/**
 * 请求摄像头拍照（点击"前置"或"后置"按钮）
 *
 * ★ v1.5.0：新增 cameraType 参数，支持 "front"（前置）和 "back"（后置）
 *
 * 流程：
 * 1. 显示加载弹窗（标题显示前置/后置）
 * 2. POST /api/command 发送对应拍照命令到服务器
 * 3. 每2秒轮询 GET /api/photo/latest?camera=xxx 获取对应摄像头照片
 * 4. 获取到照片后显示
 * 5. 60秒内没获取到则显示超时错误
 *
 * @param {string} cameraType - "front"（前置）或 "back"（后置）
 */
async function requestCameraPhoto(cameraType) {
  // 设置当前摄像头类型（用于轮询时过滤）
  currentCameraType = cameraType || 'front';
  const cameraLabel = currentCameraType === 'front' ? '前置' : '后置';
  const commandStr = currentCameraType === 'front' ? 'take_photo_front' : 'take_photo_back';

  // 显示弹窗（传入摄像头类型更新标题）
  showPhotoModal(currentCameraType);

  // 重置轮询状态
  photoPollingCount = 0;
  if (photoPollingTimer) {
    clearInterval(photoPollingTimer);
    photoPollingTimer = null;
  }

  try {
    // Step 1: 发送拍照命令（command 区分前置/后置）
    const cmdUrl = `${API_BASE}/api/command`;
    const resp = await fetch(cmdUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_id: session.deviceId,
        pin_code: session.pinCode,
        command: commandStr
      })
    });

    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({}));
      showPhotoError('发送拍照命令失败: ' + (errData.error || resp.statusText));
      return;
    }

    const cmdData = await resp.json();
    console.log(`${cameraLabel}拍照命令已发送:`, cmdData);

    // ★ v1.5.2：保存本次命令的 request_id，轮询时用来匹配新照片
    currentRequestId = cmdData.request_id || null;

    // Step 2: 更新加载提示
    document.querySelector('#photoLoading p').textContent = `等待手机${cameraLabel}摄像头拍照并上传...`;
    document.querySelector('#photoLoading small').textContent = '手机收到指令后将自动拍照（约5-10秒）';

    // Step 3: 开始轮询获取照片（按摄像头类型过滤）
    photoPollingTimer = setInterval(pollForPhoto, 2000); // 每2秒查一次

  } catch (err) {
    showPhotoError('网络错误: ' + err.message);
  }
}

/**
 * 轮询获取照片
 * 每2秒调用 GET /api/photo/latest?camera=xxx 检查是否有新照片
 * 最多轮询30次（60秒），超时则提示错误
 *
 * ★ v1.5.0：使用 currentCameraType 过滤，只获取对应摄像头的照片
 * ★ v1.5.2：跳过已显示过的旧照片，只在收到新照片时才显示
 *           判断方式：request_id 匹配 或 created_at 比上次的更新
 */
async function pollForPhoto() {
  photoPollingCount++;

  // 超过30次（60秒）停止轮询
  if (photoPollingCount > 30) {
    if (photoPollingTimer) {
      clearInterval(photoPollingTimer);
      photoPollingTimer = null;
    }
    showPhotoError('等待超时（60秒）。手机可能不在线或未授予相机权限。');
    return;
  }

  try {
    // ★ v1.5.0：传入 camera 参数，只获取对应摄像头的最新照片
    const data = await apiGet('/api/photo/latest', {
      device_id: session.deviceId,
      pin_code: session.pinCode,
      camera: currentCameraType
    });

    if (data.photo_base64) {
      // ★ v1.5.2：判断是否为新照片（跳过旧照片）
      const photoCreatedAt = data.created_at || null;
      const photoRequestId = data.request_id || null;
      let isNewPhoto = false;

      if (currentRequestId && photoRequestId) {
        // 有 request_id → 用 request_id 精确匹配
        // 只有当照片的 request_id 与本次命令的 request_id 一致时才认为是新照片
        isNewPhoto = (photoRequestId === currentRequestId);
      } else if (photoCreatedAt) {
        // 没有 request_id → 用 created_at 时间戳判断
        // 新照片的 created_at 必须比上次显示的更晚
        isNewPhoto = (lastPhotoCreatedAt === null || photoCreatedAt > lastPhotoCreatedAt);
      } else {
        // 服务器没返回 created_at 也没 request_id（旧版服务器）
        // 用 timestamp 字符串判断（兜底方案）
        const photoTs = data.timestamp || '';
        isNewPhoto = (lastPhotoCreatedAt === null || photoTs !== lastPhotoCreatedAt);
      }

      if (!isNewPhoto) {
        // 是旧照片，继续等待新照片
        console.log(`[${photoPollingCount}/30] 收到旧照片，继续等待新照片...`);
        return;
      }

      // ★ 是新照片！停止轮询并显示
      if (photoPollingTimer) {
        clearInterval(photoPollingTimer);
        photoPollingTimer = null;
      }

      // ★ v1.5.2：记录本次显示的照片信息（供下次"重新拍照"时对比）
      if (photoCreatedAt) {
        lastPhotoCreatedAt = photoCreatedAt;
      } else if (data.timestamp) {
        lastPhotoCreatedAt = data.timestamp; // 兜底：用 timestamp 字符串
      }

      // 显示照片
      const img = document.getElementById('photoImage');
      img.src = 'data:image/jpeg;base64,' + data.photo_base64;
      img.style.display = 'block';

      // 隐藏加载提示
      document.getElementById('photoLoading').style.display = 'none';

      // 显示照片信息（包含摄像头类型）
      const cameraLabel = (data.camera === 'back') ? '后置' : '前置';
      const infoEl = document.getElementById('photoInfo');
      infoEl.textContent = `${cameraLabel}摄像头 · 拍摄时间: ` + (data.timestamp || '未知');
      infoEl.style.display = 'block';

      // 显示重新拍照按钮
      document.getElementById('btnRetakePhoto').style.display = 'inline-block';

      console.log(`${cameraLabel}照片获取成功（新照片）`);
    }
    // 如果没有照片或是旧照片，继续等待下一次轮询
  } catch (err) {
    console.error('轮询照片失败:', err.message);
    // 不中断轮询，继续等待
  }
}

/**
 * 显示照片弹窗（加载状态）
 *
 * ★ v1.5.0：根据摄像头类型更新弹窗标题和重新拍照按钮样式
 *
 * @param {string} cameraType - "front"（前置）或 "back"（后置）
 */
function showPhotoModal(cameraType) {
  const cameraLabel = cameraType === 'back' ? '后置' : '前置';

  // ★ v1.5.0：更新弹窗标题
  const titleEl = document.getElementById('photoModalTitle');
  if (titleEl) {
    titleEl.textContent = `📷 ${cameraLabel}摄像头照片`;
  }

  // ★ v1.5.0：更新重新拍照按钮文字和样式
  const retakeBtn = document.getElementById('btnRetakePhoto');
  if (retakeBtn) {
    retakeBtn.textContent = `📷 重新拍照（${cameraLabel}）`;
    // 切换按钮样式类
    retakeBtn.classList.remove('btn-camera-front', 'btn-camera-back');
    retakeBtn.classList.add(cameraType === 'back' ? 'btn-camera-back' : 'btn-camera-front');
  }

  document.getElementById('photoModal').style.display = 'flex';
  // 重置为加载状态
  document.getElementById('photoLoading').style.display = 'flex';
  document.getElementById('photoImage').style.display = 'none';
  document.getElementById('photoError').style.display = 'none';
  document.getElementById('photoInfo').style.display = 'none';
  document.getElementById('btnRetakePhoto').style.display = 'none';
}

/**
 * 隐藏照片弹窗
 */
function hidePhotoModal() {
  document.getElementById('photoModal').style.display = 'none';
  if (photoPollingTimer) {
    clearInterval(photoPollingTimer);
    photoPollingTimer = null;
  }
}

/**
 * 显示照片错误
 */
function showPhotoError(message) {
  document.getElementById('photoLoading').style.display = 'none';
  const errEl = document.getElementById('photoError');
  errEl.textContent = '❌ ' + message;
  errEl.style.display = 'block';
  document.getElementById('btnRetakePhoto').style.display = 'inline-block';
}

// ==================== 事件绑定 ====================

document.addEventListener('DOMContentLoaded', () => {
  // 登录表单提交
  document.getElementById('loginForm').addEventListener('submit', handleLogin);

  // 刷新按钮
  document.getElementById('btnRefresh').addEventListener('click', fetchLatestLocation);

  // ★ v1.4.0：实时位置按钮（立即获取，不等60秒）
  document.getElementById('btnLiveLocation').addEventListener('click', fetchLiveLocation);

  // ★ v1.5.0：前置和后置摄像头按钮（分别发送不同命令）
  document.getElementById('btnCameraFront').addEventListener('click', () => requestCameraPhoto('front'));
  document.getElementById('btnCameraBack').addEventListener('click', () => requestCameraPhoto('back'));

  // ★ v1.5.0：照片弹窗关闭按钮（重新拍照使用当前摄像头类型）
  document.getElementById('btnClosePhoto').addEventListener('click', hidePhotoModal);
  document.getElementById('btnRetakePhoto').addEventListener('click', () => requestCameraPhoto(currentCameraType));

  // ★ v1.4.0：点击弹窗背景关闭
  document.getElementById('photoModal').addEventListener('click', (e) => {
    if (e.target.id === 'photoModal') hidePhotoModal();
  });

  // 退出按钮
  document.getElementById('btnLogout').addEventListener('click', handleLogout);

  // 查询轨迹按钮
  document.getElementById('btnQueryHistory').addEventListener('click', fetchHistory);

  // 快捷时间选择
  document.querySelectorAll('.btn-quick').forEach(btn => {
    btn.addEventListener('click', () => {
      quickSelectHours(parseInt(btn.dataset.hours));
    });
  });

  // 自动刷新开关
  document.getElementById('autoRefresh').addEventListener('change', toggleAutoRefresh);

  // 回放控制
  document.getElementById('btnPlay').addEventListener('click', startPlayback);
  document.getElementById('btnPause').addEventListener('click', pausePlayback);
  document.getElementById('btnClear').addEventListener('click', clearTrack);

  // 进度条拖动
  document.getElementById('progressSlider').addEventListener('input', (e) => {
    if (trackData.length === 0) return;
    playbackIndex = parseInt(e.target.value);
    if (playbackMarker && playbackIndex < trackData.length) {
      const point = trackData[playbackIndex];
      const gcj = wgs84ToGcj02(point.longitude, point.latitude);
      playbackMarker.setLatLng([gcj.lat, gcj.lng]);
    }
    document.getElementById('progressLabel').textContent = `${playbackIndex + 1} / ${trackData.length}`;
  });
});
