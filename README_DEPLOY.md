# 深渊回响 - 支付宝支付接入指南

## 项目结构

```
mbti/
├── index.html          # 前端页面（已接入支付逻辑）
├── server.js           # Node.js 后端服务（支付宝接口）
├── package.json        # 项目依赖
├── .env                # 支付宝配置（你需要创建）
├── .env.example        # 配置模板
└── README_DEPLOY.md    # 本文件
```

---

## 第一步：本地测试（使用支付宝沙箱）

### 1. 创建配置文件

```bash
cp .env.example .env
```

编辑 `.env` 文件，填入你的支付宝沙箱参数。

### 2. 获取支付宝沙箱参数

1. 访问 [支付宝开放平台](https://open.alipay.com/)
2. 登录后进入 **控制台 → 开发助手 → 沙箱环境**
3. 记录以下信息：
   - **APPID** → 填入 `ALIPAY_APP_ID`
   - **应用私钥** → 填入 `ALIPAY_PRIVATE_KEY`
   - **支付宝公钥** → 填入 `ALIPAY_PUBLIC_KEY`（注意：是支付宝公钥，不是应用公钥！）

沙箱网关已默认配置为 `https://openapi.alipaydev.com/gateway.do`

### 3. 安装依赖并启动

```bash
npm install
npm start
```

服务启动后：
- 网页访问：http://localhost:3000
- 健康检查：http://localhost:3000/api/health

### 4. 测试支付流程

1. 打开 http://localhost:3000 完成首次测试（免费）
2. 再次点击「唤醒沉睡的灵魂」进入支付页
3. 点击「确认支付」，页面会跳转到支付宝沙箱收银台
4. 使用沙箱账号登录并完成支付
5. 支付成功后自动跳转回首页并开始测试

沙箱测试账号在开放平台沙箱环境页面查看。

---

## 第二步：正式环境上线

### 前置条件

| 条件 | 说明 |
|------|------|
| 营业执照 | 个体户或企业均可 |
| ICP备案域名 | 支付宝要求网站域名必须备案 |
| 云服务器 | 需要固定公网IP和HTTPS |

### 1. 申请正式支付宝应用

1. 登录 [支付宝开放平台](https://open.alipay.com/)
2. 控制台 → 创建应用 → 网页/移动应用 → 支付接入
3. 完善应用信息，提交审核（通常1-2小时通过）
4. 进入应用详情 → 开发设置 → **接口加签方式**，生成密钥对
5. 记录 **AppID**、**应用私钥**、**支付宝公钥**
6. 产品中心 → 签约 **电脑网站支付** 和 **手机网站支付**

### 2. 购买域名并备案

- 在阿里云/腾讯云购买域名
- 完成 ICP 备案（约7-20个工作日）
- 配置 HTTPS 证书（推荐用 Let's Encrypt 免费证书）

### 3. 部署到云服务器

推荐使用以下平台：

| 平台 | 价格 | 特点 |
|------|------|------|
| 阿里云 ECS | 99元/年起 | 国内访问快，备案方便 |
| 腾讯云轻量 | 82元/年起 | 性价比高，一键部署 |
| 华为云 | 类似 | 企业级稳定 |

部署步骤示例（阿里云 ECS + Ubuntu）：

```bash
# 1. 连接服务器
ssh root@你的服务器IP

# 2. 安装 Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 3. 上传项目文件（本地终端执行）
scp -r /Users/mac/Downloads/dev/mbti root@你的服务器IP:/opt/

# 4. 服务器端安装依赖并启动
cd /opt/mbti
npm install

# 5. 创建 .env 生产配置
cat > .env << 'EOF'
PORT=3000
BASE_URL=https://你的域名
ALIPAY_APP_ID=你的正式AppID
ALIPAY_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n你的私钥\n-----END RSA PRIVATE KEY-----"
ALIPAY_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\n支付宝公钥\n-----END PUBLIC KEY-----"
ALIPAY_GATEWAY=https://openapi.alipay.com/gateway.do
ALIPAY_SIGN_TYPE=RSA2
EOF

# 6. 使用 PM2 守护进程运行
npm install -g pm2
pm2 start server.js --name abyss-pay
pm2 startup
pm2 save

# 7. 配置 Nginx 反向代理 + HTTPS
sudo apt install nginx certbot python3-certbot-nginx -y

# 编辑 Nginx 配置
sudo tee /etc/nginx/sites-available/abyss << 'EOF'
server {
    listen 80;
    server_name 你的域名;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name 你的域名;

    ssl_certificate /etc/letsencrypt/live/你的域名/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/你的域名/privkey.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
EOF

sudo ln -s /etc/nginx/sites-available/abyss /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx

# 申请 SSL 证书
sudo certbot --nginx -d 你的域名
```

### 4. 配置支付宝回调地址

在支付宝开放平台 → 你的应用 → 开发设置中：

- **授权回调地址**: `https://你的域名`
- **应用网关地址**: `https://你的域名/api/notify`

---

## 支付流程说明

```
用户点击"确认支付"
    ↓
前端 POST /api/create-order (金额¥3.00)
    ↓
后端生成订单 → 调用支付宝 SDK → 返回支付表单 HTML
    ↓
前端自动提交表单 → 跳转支付宝收银台
    ↓
用户完成支付
    ↓
支付宝同步回调: https://你的域名/?payment=success&orderId=xxx
支付宝异步通知: POST https://你的域名/api/notify
    ↓
页面检测到 payment=success → 标记已支付 → 自动开始测试
```

---

## 常见问题

**Q: 没有营业执照能接入吗？**
A: 支付宝官方接口必须有营业执照（个体户即可）。如果没有，可以考虑用爱发电等第三方创作者平台。

**Q: 为什么需要后端？**
A: 支付签名和密钥必须在服务端完成，不能暴露在前端，否则会有安全风险。

**Q: 可以只接微信支付吗？**
A: 可以，但微信支付网页端（H5支付）类目审核更严格，部分类目需要额外资质。支付宝对普通网站更友好。

**Q: 沙箱支付跳转报错？**
A: 确保 BASE_URL 配置正确。本地测试用 `http://localhost:3000`，注意支付宝沙箱回调不支持 localhost，但同步回调可以正常跳转回本地。

---

## 费用概览

| 项目 | 费用 |
|------|------|
| 支付宝手续费 | 0.6%（¥3.00 交易收取 ¥0.018） |
| 域名 | ~30-70元/年 |
| 云服务器 | ~100元/年起 |
| ICP备案 | 免费 |
| SSL证书 | Let's Encrypt 免费 |

---

**技术栈**: Node.js + Express + 支付宝官方 SDK
**作者**: 深渊回响开发团队 🐙
