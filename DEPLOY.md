# 部署到 Render（免费）+ GitHub

## 注意

GitHub Pages 只能托管静态网页，**无法运行 Node.js 后端和 MySQL 数据库**。

这里使用 **Render（免费 Web 服务）+ PlanetScale（免费 MySQL 数据库）** 来完整部署本系统。

---

## 第一步：创建 GitHub 仓库并推送代码

1. 登录 https://github.com
2. 新建一个仓库，名称比如 `property-billing-system`
3. 不要勾选 README、.gitignore、license
4. 复制仓库地址，例如：`https://github.com/你的用户名/property-billing-system.git`

在项目目录执行：

```bash
cd D:\\Backup\\Documents\\ChatGPT\\公寓\\property-billing-system-main

# 初始化 git（如果还没初始化）
git init

# 添加所有文件
git add .

# 提交
git commit -m "feat: 添加登录、MySQL 数据库、服务器部署配置"

# 关联远程仓库（把下面地址换成你的）
git remote add origin https://github.com/你的用户名/property-billing-system.git

# 推送
git branch -M main
git push -u origin main
```

---

## 第二步：申请免费 MySQL 数据库（PlanetScale）

1. 打开 https://planetscale.com 注册账号
2. 创建新数据库，选择 **Free tier**
3. 创建完成后，进入数据库 → Connect → Connect with: **Node.js**
4. 复制连接信息，格式类似：

```
Host: aws.connect.psdb.cloud
Username: xxxxxxxx
Password: pscale_pw_xxxxxxxx
Database: property_billing
```

---

## 第三步：部署到 Render

1. 打开 https://render.com 注册账号（可直接用 GitHub 登录）
2. 点击 **New +** → **Blueprint**
3. 选择你刚才推送的 GitHub 仓库
4. Render 会自动识别 `render.yaml`
5. 填写环境变量：

| 变量 | 值 |
|------|-----|
| DB_HOST | PlanetScale 的 Host |
| DB_PORT | 3306 |
| DB_USER | PlanetScale 的 Username |
| DB_PASSWORD | PlanetScale 的 Password |
| DB_NAME | property_billing |
| JWT_SECRET | 随机长字符串（至少 32 位） |
| DEFAULT_PASSWORD | 你想设置的 admin 初始密码 |

6. 点击 **Apply**
7. 等待部署完成，Render 会给你一个网址，例如 `https://property-billing-system-xxx.onrender.com`

---

## 第四步：首次访问

打开 Render 给你的网址 + `/login.html`：

```
https://property-billing-system-xxx.onrender.com/login.html
```

用你设置的 `DEFAULT_PASSWORD` 登录 admin 账号。

---

## 免费额度说明

- **Render Free**：Web Service 会在 15 分钟无访问后休眠，首次访问需等待 30 秒左右唤醒
- **PlanetScale Free**：5GB 存储、10 亿行读取/月，个人/小型物业完全够用

---

## 后续更新代码

每次修改后推送到 GitHub，Render 会自动重新部署：

```bash
git add .
git commit -m "update"
git push
```
