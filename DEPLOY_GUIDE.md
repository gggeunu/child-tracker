# ============================================================
#  孩子定位追踪 - 云部署指南（Render.com 免费）
# ============================================================
#
#  问题：电脑关机后服务器就停了，孩子手机无法上报位置。
#  解决：把服务器部署到 Render.com 云平台，24小时不间断运行。
#
#  费用：完全免费（Render Free Tier）
#  缺点：免费版15分钟无访问会休眠，首次唤醒约30秒
#        数据存储在临时磁盘上，服务重启后数据可能丢失
#
#  对于定位追踪来说：休眠问题不大（手机上报会唤醒服务）
#  数据丢失问题：家庭级数据量不大，偶尔重注册即可
#
# ============================================================

## 部署步骤（总共约10分钟）

### 第一步：注册 GitHub 账号（如果没有）
1. 打开 https://github.com/signup
2. 注册一个免费账号
3. 记住你的 GitHub 用户名

### 第二步：创建 GitHub 仓库
1. 登录 GitHub 后，点击右上角 "+" → "New repository"
2. 仓库名填：child-tracker
3. 选择 Public（公开）
4. 不要勾选 "Add a README file"
5. 点击 "Create repository"

### 第三步：上传代码到 GitHub
1. 在你的电脑上，打开文件夹：
   C:\Users\Administrator\WorkBuddy\2026-07-28-16-22-22\child-tracker\cloud-deploy
2. 这个文件夹里有 git 仓库，但还没推送到 GitHub
3. 在命令行中执行：
   cd C:\Users\Administrator\WorkBuddy\2026-07-28-16-22-22\child-tracker\cloud-deploy
   git remote add origin https://github.com/你的用户名/child-tracker.git
   git push -u origin main

   （把"你的用户名"替换成你的 GitHub 用户名）
4. 推送时会要求输入 GitHub 用户名和密码
   - 用户名：你的 GitHub 用户名
   - 密码：需要用 Personal Access Token（不能直接用密码）
   - 创建 Token：GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token
   - 勾选 repo 权限，生成后复制 token 作为密码使用

### 第四步：注册 Render 账号
1. 打开 https://dashboard.render.com/register
2. 用 GitHub 账号直接注册登录（点击 "Sign up with GitHub"）

### 第五步：创建 Web Service
1. 登录 Render Dashboard 后，点击 "New +" → "Web Service"
2. 在 "Connect a repository" 中，找到并选择你的 child-tracker 仓库
3. 如果看不到仓库，点击 "Configure" 授权 Render 访问你的 GitHub
4. 填写配置：
   - Name: child-tracker
   - Runtime: Node
   - Build Command: npm install
   - Start Command: node server.js
   - Plan: Free
5. 点击 "Create Web Service"

### 第六步：等待部署完成
1. Render 会自动部署（约2-3分钟）
2. 部署完成后，会给你一个公网地址，例如：
   https://child-tracker-xxxx.onrender.com
3. 这就是你的永久访问地址！

### 第七步：验证
1. 在浏览器打开：https://child-tracker-xxxx.onrender.com/web
2. 应该能看到定位追踪的网页界面
3. 测试注册设备：用 curl 或手机 App 发送注册请求

### 第八步：更新孩子手机的配置
1. 打开孩子手机上的「孩子定位追踪」App
2. 服务器地址改为：https://child-tracker-xxxx.onrender.com
3. （不用加端口，HTTPS 默认443）
4. 注册新设备，然后启动定位服务

## 注意事项

- **数据持久性**：Render Free Tier 的磁盘是临时的
  服务重启（比如每天休眠后唤醒）可能导致数据丢失
  解决方案：偶尔备份，或在 App 中保留重新注册的能力

- **休眠唤醒**：15分钟无请求后服务会休眠
  首次唤醒约需30秒，之后的请求正常响应
  手机上报位置时会自动唤醒，所以影响不大

- **HTTPS**：Render 自动提供 HTTPS
  Android App 需要访问 HTTPS 地址（App 已配置了 network_security_config）

- **后续更新代码**：修改后推送 git 即可
  cd cloud-deploy && git add -A && git commit -m "更新" && git push
  Render 会自动检测并重新部署

