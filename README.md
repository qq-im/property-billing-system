# 物业账单管家（服务器版）

物业与租户综合账单管理系统，支持账号登录、MySQL 数据库存储、Docker 一键部署。

## 主要功能

- 工作台统计、合同临期提醒
- 租户管理（支持一户多水表/电表）
- 月度抄表，自动追溯上期读数
- 一键生成账单（租金 + 水电 + 其他费用）
- 电子公章、收款码、PDF/PNG 导出
- Excel 导入旧台账
- 账号登录与权限管理

## 技术栈

- 后端：Node.js 20+
- 数据库：MySQL 8.0（推荐）/ SQLite（本地测试）
- 认证：JWT + bcrypt
- 部署：Docker / Docker Compose

## 本地快速体验（SQLite）

```bash
# 1. 安装依赖
npm install

# 2. 默认 .env 已配置为 SQLite，直接启动
node server.js

# 3. 访问
http://localhost:3000

# 默认账号：admin
# 默认密码：admin123
```

## 生产环境部署（MySQL + Docker）

### 方式一：Docker Compose 一键部署（推荐）

服务器要求：已安装 Docker 和 Docker Compose。

```bash
# 1. 克隆代码到服务器
git clone https://github.com/juntiy/property-billing-system.git
cd property-billing-system

# 2. 编辑环境变量
vim .env
```

`.env` 示例（生产）：

```env
PORT=3000
HOST=0.0.0.0
DB_TYPE=mysql
DB_HOST=mysql
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_strong_password
DB_NAME=property_billing
JWT_SECRET=your-super-secret-key-at-least-32-chars
DEFAULT_PASSWORD=your_admin_password
```

```bash
# 3. 启动（会自动创建 MySQL 容器和应用容器）
docker compose up -d

# 4. 访问
http://服务器IP:3000
```

### 方式二：宝塔面板 / 云服务器手动部署

#### 1. 服务器准备

- 安装 Node.js 20+
- 安装 MySQL 8.0 并创建数据库：

```sql
CREATE DATABASE property_billing CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

#### 2. 上传代码并安装依赖

```bash
cd /www/wwwroot/property-billing
npm install --production
```

#### 3. 配置环境变量

```bash
cp .env.example .env
# 修改数据库密码、JWT 密钥等
vim .env
```

#### 4. 用 PM2 启动

```bash
npm install -g pm2
pm2 start server.js --name property-billing
pm2 save
pm2 startup
```

#### 5. Nginx 反向代理

在宝塔「网站」中新建反向代理，目标地址 `http://127.0.0.1:3000`，绑定域名并开启 HTTPS。

## 安全配置

1. **务必修改默认密码**：首次登录后，通过 `POST /api/auth/change-password` 或直接在数据库中修改。
2. **修改 JWT_SECRET**：生产环境请设置随机长字符串。
3. **开启 HTTPS**：公网访问必须配置 SSL 证书。
4. **数据库安全**：不要用空密码的 root，建议创建独立数据库用户。

## 创建额外账号

管理员可以调用以下接口创建新账号：

```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Authorization: Bearer <admin_token>" \
  -H "Content-Type: application/json" \
  -d '{"username":"user1","password":"123456","role":"user"}'
```

## 环境变量说明

| 变量 | 说明 | 默认值 |
|------|------|--------|
| PORT | 服务端口 | 3000 |
| HOST | 监听地址 | 0.0.0.0 |
| DB_TYPE | 数据库类型：mysql / sqlite | mysql |
| DB_HOST | MySQL 主机 | localhost |
| DB_PORT | MySQL 端口 | 3306 |
| DB_USER | MySQL 用户名 | root |
| DB_PASSWORD | MySQL 密码 | 空 |
| DB_NAME | MySQL 数据库名 | property_billing |
| JWT_SECRET | JWT 签名密钥 | dev-secret-key |
| DEFAULT_PASSWORD | 首次启动创建的 admin 密码 | admin123 |
| SQLITE_PATH | SQLite 文件路径 | ./data/app.db |

## 数据备份

- **MySQL**：备份整个 `property_billing` 数据库。
- **SQLite**：备份 `data/app.db` 文件即可。

## 升级

```bash
git pull
npm install --production
docker compose up -d --build
# 或 PM2：pm2 restart property-billing
```
