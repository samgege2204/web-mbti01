require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

// 加载支付宝 SDK
let AlipaySdk;
try {
  const sdk = require('alipay-sdk');
  AlipaySdk = sdk.AlipaySdk || sdk.default || sdk;
  if (typeof AlipaySdk !== 'function') {
    throw new Error('AlipaySdk 不是构造函数，导出内容: ' + Object.keys(sdk).join(', '));
  }
} catch (e) {
  console.error('支付宝 SDK 加载失败:', e.message);
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 静态文件托管
app.use(express.static(path.join(__dirname)));

// ============ 支付宝配置 ============
const ALIPAY_CONFIG = {
  // 应用ID（从支付宝开放平台获取）
  appId: process.env.ALIPAY_APP_ID || '',
  // 应用私钥（从支付宝开放平台获取）
  privateKey: process.env.ALIPAY_PRIVATE_KEY || '',
  // 支付宝公钥（从支付宝开放平台获取）
  alipayPublicKey: process.env.ALIPAY_PUBLIC_KEY || '',
  // 网关地址：沙箱环境 / 生产环境
  gateway: process.env.ALIPAY_GATEWAY || 'https://openapi.alipaydev.com/gateway.do',
  // 签名类型
  signType: process.env.ALIPAY_SIGN_TYPE || 'RSA2',
};

// 服务器基础URL（用于回调地址）
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

// 内存订单存储（生产环境请改用 Redis / 数据库）
const orders = new Map();

// 初始化支付宝 SDK
let alipaySdk;
try {
  alipaySdk = new AlipaySdk({
    appId: ALIPAY_CONFIG.appId,
    privateKey: ALIPAY_CONFIG.privateKey,
    alipayPublicKey: ALIPAY_CONFIG.alipayPublicKey,
    gateway: ALIPAY_CONFIG.gateway,
    signType: ALIPAY_CONFIG.signType,
    timeout: 15000,
  });
  console.log('✅ 支付宝 SDK 初始化成功');
  console.log(`   网关: ${ALIPAY_CONFIG.gateway}`);
  console.log(`   AppID: ${ALIPAY_CONFIG.appId || '未配置'}`);
} catch (err) {
  console.warn('⚠️ 支付宝 SDK 初始化失败（可能是配置未填写）:', err.message);
}

// ============ 工具函数 ============

// 判断请求来自移动端还是PC端
function isMobile(userAgent) {
  if (!userAgent) return false;
  const mobileRegex = /(phone|pad|pod|iPhone|iPod|ios|iPad|Android|Mobile|BlackBerry|IEMobile|MQQBrowser|JUC|Fennec|wOSBrowser|BrowserNG|WebOS|Symbian|Windows Phone)/i;
  return mobileRegex.test(userAgent);
}

// 生成订单号
function generateOrderId() {
  const date = new Date().toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `ABYSS${date}${random}`;
}

// ============ API 路由 ============

/**
 * POST /api/create-order
 * 创建支付订单
 * Body: { amount: number, productName: string }
 * Response: { success: boolean, orderId: string, html?: string, message?: string }
 */
app.post('/api/create-order', async (req, res) => {
  try {
    // 检查配置
    if (!ALIPAY_CONFIG.appId || !ALIPAY_CONFIG.privateKey) {
      return res.status(503).json({
        success: false,
        message: '支付宝支付尚未配置，请先配置 ALIPAY_APP_ID 和 ALIPAY_PRIVATE_KEY',
      });
    }

    const { amount = 3.00, productName = '深渊回响 - 再次觉醒' } = req.body;
    const orderId = generateOrderId();
    const userAgent = req.headers['user-agent'] || '';
    const mobile = isMobile(userAgent);

    // 保存订单信息
    orders.set(orderId, {
      id: orderId,
      amount: parseFloat(amount).toFixed(2),
      productName,
      status: 'PENDING', // PENDING | PAID | CLOSED
      createTime: new Date().toISOString(),
      payTime: null,
      buyerLogonId: null,
      mobile,
    });

    console.log(`📝 创建订单: ${orderId}, 金额: ${amount}, 终端: ${mobile ? '移动端' : 'PC端'}`);

    // 回调地址
    const notifyUrl = `${BASE_URL}/api/notify`;
    const returnUrl = `${BASE_URL}/?payment=success&orderId=${orderId}`;

    // 根据终端类型选择接口
    const method = mobile ? 'alipay.trade.wap.pay' : 'alipay.trade.page.pay';
    const productCode = mobile ? 'QUICK_WAP_WAY' : 'FAST_INSTANT_TRADE_PAY';

    // 调用支付宝 SDK 创建订单
    const formHtml = await alipaySdk.exec(method, {
      notify_url: notifyUrl,
      return_url: returnUrl,
      bizContent: {
        out_trade_no: orderId,
        total_amount: parseFloat(amount).toFixed(2),
        subject: productName,
        product_code: productCode,
        timeout_express: '15m', // 15分钟支付超时
      },
    }, { formData: true });

    return res.json({
      success: true,
      orderId,
      html: formHtml, // 前端需要自动提交这个 form
    });
  } catch (error) {
    console.error('创建订单失败:', error);
    return res.status(500).json({
      success: false,
      message: error.message || '创建订单失败',
    });
  }
});

/**
 * POST /api/notify
 * 支付宝异步通知（支付结果回调）
 */
app.post('/api/notify', async (req, res) => {
  try {
    const notifyData = req.body;
    console.log('📨 收到支付宝异步通知:', notifyData.out_trade_no);

    // 验证签名
    const signVerified = await alipaySdk.checkNotifySign(notifyData);
    if (!signVerified) {
      console.warn('❌ 异步通知签名验证失败');
      return res.send('fail');
    }

    const { out_trade_no, trade_status, buyer_logon_id, gmt_payment } = notifyData;

    // 处理支付成功状态
    if (trade_status === 'TRADE_SUCCESS' || trade_status === 'TRADE_FINISHED') {
      const order = orders.get(out_trade_no);
      if (order) {
        order.status = 'PAID';
        order.payTime = gmt_payment || new Date().toISOString();
        order.buyerLogonId = buyer_logon_id;
        console.log(`✅ 订单支付成功: ${out_trade_no}`);
      }
    }

    // 必须返回 success，否则支付宝会持续重发通知
    res.send('success');
  } catch (error) {
    console.error('处理异步通知失败:', error);
    res.send('fail');
  }
});

/**
 * GET /api/order-status?orderId=xxx
 * 查询订单状态
 */
app.get('/api/order-status', (req, res) => {
  const { orderId } = req.query;
  if (!orderId) {
    return res.status(400).json({ success: false, message: '缺少订单号' });
  }

  const order = orders.get(orderId);
  if (!order) {
    return res.status(404).json({ success: false, message: '订单不存在' });
  }

  return res.json({
    success: true,
    order: {
      id: order.id,
      status: order.status,
      amount: order.amount,
      payTime: order.payTime,
    },
  });
});

/**
 * GET /api/health
 * 健康检查
 */
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: '深渊回响支付服务运行中',
    alipayConfigured: !!(ALIPAY_CONFIG.appId && ALIPAY_CONFIG.privateKey),
    timestamp: new Date().toISOString(),
  });
});

// ============ 启动服务 ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════╗
║                                                        ║
║     🐙 深渊回响 - 支付服务已启动                        ║
║                                                        ║
║     本地访问: http://localhost:${PORT}                     ║
║     健康检查: http://localhost:${PORT}/api/health          ║
║                                                        ║
╚════════════════════════════════════════════════════════╝
  `);
});
