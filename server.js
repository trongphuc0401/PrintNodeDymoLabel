const express = require('express');
const PDFDocument = require('pdfkit');
const axios = require('axios');
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// --- LOGGER ---
const logger = {
  log: (...args) => {
    if (process.env.NODE_ENV !== 'production') {
      console.log(...args);
    }
  },
  info: console.log,
  error: console.error,
};

// --- TẠO LIMIT FUNCTION ĐƠN GIẢN (Thay thế p-limit) ---
function createLimit(concurrency) {
  let running = 0;
  const queue = [];

  const process = async () => {
    if (running >= concurrency || queue.length === 0) return;

    running++;
    const { fn, resolve, reject } = queue.shift();

    try {
      const result = await fn();
      resolve(result);
    } catch (error) {
      reject(error);
    } finally {
      running--;
      process();
    }
  };

  return (fn) => {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      process();
    });
  };
}

const limit = createLimit(3);

// --- KẾT NỐI MONGODB ---
const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) {
  logger.error('❌ MONGODB_URI is not set in .env file. Exiting.');
  process.exit(1);
}

// --- TỐI ƯU HÓA KẾT NỐI MONGODB ---
let cachedDb = null;

const connectMongo = async () => {
  if (cachedDb && mongoose.connections[0].readyState) {
    logger.log('🚀 Using cached MongoDB connection.');
    return cachedDb;
  }
  try {
    logger.info('🔥 Creating new MongoDB connection...');
    cachedDb = await mongoose.connect(mongoUri);
    logger.info('✅ MongoDB connected successfully.');
    return cachedDb;
  } catch (error) {
    logger.error('❌ MongoDB connection error:', error.message);
    throw error;
  }
};

// Initial connection
connectMongo();

// Log connection events
mongoose.connection.on('connected', () => logger.info('✅ Mongoose connected to MongoDB'));
mongoose.connection.on('disconnected', () => logger.info('⚠️ Mongoose disconnected from MongoDB'));
mongoose.connection.on('error', (err) => logger.error('❌ Mongoose connection error:', err.message));

// --- SCHEMAS VÀ MODELS ---
const PrintJobSchema = new mongoose.Schema({
  order_id: { type: String, index: true, unique: true }, // Order ID là duy nhất
  status: { type: String, enum: ['pending', 'processing', 'completed', 'failed'], default: 'pending' },
  items_to_print: [{
    product_name: String,
    variant_title: String,
    sku: String,
    quantity: Number,
    price: String,
    // Dữ liệu gốc của item để có thể retry
    original_item_data: mongoose.Schema.Types.Mixed,
  }],
  processing_details: [{
    item_sku: String,
    printnode_job_id: Number,
    status: String, // 'sent' hoặc 'failed'
    error_message: String,
    timestamp: Date,
  }],
  last_error: String,
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

const PrintJob = mongoose.model('PrintJob', PrintJobSchema);

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));
app.set('view engine', 'ejs');

// SỬA DÒNG NÀY:
// Thay vì trỏ vào thư mục gốc, hãy trỏ vào thư mục 'views' theo chuẩn
app.set('views', path.join(__dirname, 'views'));


// --- 4. CẬP NHẬT CÁC ROUTE ĐỂ DÙNG MONGOOSE ---
// Middleware: Wait for MongoDB connection before processing requests
app.use(async (req, res, next) => {
  if (mongoose.connection.readyState === 1) {
    return next();
  }
  
  // If not connected, wait up to 5 seconds
  const maxWait = 5000;
  const startTime = Date.now();
  
  while (mongoose.connection.readyState !== 1 && Date.now() - startTime < maxWait) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  if (mongoose.connection.readyState === 1) {
    logger.log('✅ MongoDB connected after waiting');
    return next();
  }
  
  logger.error('❌ MongoDB still not connected after waiting');
  return res.status(503).json({ 
    error: 'Database connection initializing. Please try again in a few seconds.',
    dbState: mongoose.connection.readyState
  });
});

// PrintNode Configuration
const PRINTNODE_API_KEY = process.env.PRINTNODE_API_KEY;
const PRINTER_ID = process.env.PRINTER_ID || 74652384;
const PRINTNODE_WEBHOOK_SECRET = process.env.PRINTNODE_WEBHOOK_SECRET;

// --- HÀM TIỆN ÍCH ---
async function createProductLabelPDF(orderItem, orderInfo) {
  return new Promise((resolve, reject) => {
    try {
      const pageWidth = 164.57;
      const pageHeight = 53.86;
      const doc = new PDFDocument({ size: [pageWidth, pageHeight], margin: 0 });
      try {
        doc.registerFont('Roboto-Bold', path.join(__dirname, 'fonts', 'Roboto-Bold.ttf'));
        doc.registerFont('Roboto-Regular', path.join(__dirname, 'fonts', 'Roboto-Regular.ttf'));
        doc.registerFont('Roboto-Italic', path.join(__dirname, 'fonts', 'Roboto-Italic.ttf'));
      } catch (fontError) {
        logger.error('Lỗi đăng ký font:', fontError.message);
        doc.font('Helvetica-Bold');
      }
      const chunks = [];
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => {
        const pdfBuffer = Buffer.concat(chunks);
        const base64String = pdfBuffer.toString('base64');
        resolve(base64String);
      });
      let yPosition = 7;
      const contentWidth = pageWidth;
      doc.fontSize(6).font('Roboto-Bold').text(orderInfo.orderNumber || 'N/A', 5, yPosition, { width: contentWidth, align: 'center' });
      yPosition += 9;
      doc.fontSize(7).font('Roboto-Bold').text(orderItem.title || 'N/A', 45, yPosition, { width: contentWidth, align: 'center', ellipsis: true });
      yPosition += 9;
      if (orderItem.variant_title) {
        doc.fontSize(6).font('Roboto-Regular').text(orderItem.variant_title, 45, yPosition, { width: contentWidth, align: 'center', ellipsis: true });
        yPosition += 8;
      }
      if (orderInfo.note) {
        doc.fontSize(5).font('Roboto-Italic').text(orderInfo.note, 45, yPosition, { width: contentWidth, align: 'center', ellipsis: true });
      }
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

async function sendToPrintNode(pdfBase64, title) {
  try {
    const response = await axios.post(
      'https://api.printnode.com/printjobs',
      {
        printerId: parseInt(PRINTER_ID),
        title: title,
        contentType: 'pdf_base64',
        content: pdfBase64,
        source: 'Shopify Print Client'
      },
      {
        headers: {
          'Authorization': `Basic ${PRINTNODE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    return response.data;
  } catch (error) {
    logger.error('PrintNode Error:', error.response?.data || error.message);
    throw error;
  }
}

// --- ROUTES ---

// Dashboard Route
app.get('/', async (req, res) => {
  try {
    // Check if MongoDB is connected
    if (mongoose.connection.readyState !== 1) {
      logger.error('❌ MongoDB is not connected. Current state:', mongoose.connection.readyState);
      return res.status(503).send('Database connection unavailable. Please try again later.');
    }

    const jobsFromDb = await PrintJob.find().sort({ created_at: -1 }).limit(100);
    logger.log(`Found ${jobsFromDb.length} jobs in the database.`);

    const printerConfig = { printerId: PRINTER_ID, apiConfigured: !!PRINTNODE_API_KEY };

    res.render('dashboard', {
      printJobs: jobsFromDb.map(job => ({
        id: job.printnode_job_id,
        jobAttemptId: job.job_attempt_id,
        orderId: job.order_id,
        productName: job.product_name,
        variantTitle: job.variant_title,
        sku: job.sku,
        quantity: job.quantity,
        price: job.price,
        status: job.status,
        error: job.error_message,
        timestamp: job.created_at
      })),
      printerConfig: printerConfig
    });
  } catch (error) {
    logger.error("❌ Error fetching jobs for dashboard:", error.message);
    res.status(500).send("Error loading dashboard data. Check server logs.");
  }
});

// API endpoint to get current jobs
app.get('/api/jobs', async (req, res) => {
  const jobsFromDb = await PrintJob.find().sort({ created_at: -1 }).limit(100);
  res.json(jobsFromDb);
});

// PrintNode Webhook Receiver
app.post('/printnode-webhook', async (req, res) => {
  const receivedSecret = req.headers['x-printnode-webhook-secret'];
  if (!PRINTNODE_WEBHOOK_SECRET || receivedSecret !== PRINTNODE_WEBHOOK_SECRET) {
    return res.status(401).send('Unauthorized');
  }

  const events = req.body;
  if (Array.isArray(events)) {
    logger.info(`🔔 Received ${events.length} event(s) from PrintNode webhook.`);
    const eventDocs = events.map(e => ({ event_type: e.event, content: e }));
    await PrintNodeEvent.insertMany(eventDocs);
  }
  res.set('X-PrintNode-Webhook-Status', 'OK').status(200).send('OK');
});

// PrintNode Status Page
app.get('/printnode-status', async (req, res) => {
  const eventsFromDb = await PrintNodeEvent.find().sort({ received_at: -1 }).limit(100);
  res.render('status', {
    events: eventsFromDb.map(e => e.content),
    webhookConfigured: !!PRINTNODE_WEBHOOK_SECRET
  });
});

// --- WEBHOOK ENDPOINT (TỐI ƯU HÓA) ---
app.post('/webhooks', async (req, res) => {
  try {
    await connectMongo(); // Đảm bảo kết nối DB
    const order = req.body;
    const orderNumber = order.name || order.order_number;
    logger.info(`📦 Webhook received for order: ${orderNumber}`);

    // 1. Kiểm tra xem order đã tồn tại chưa
    const existingJob = await PrintJob.findOne({ order_id: orderNumber });
    if (existingJob) {
      logger.log(`⚠️ Order ${orderNumber} already exists. Ignoring duplicate.`);
      return res.status(200).json({ message: 'Duplicate ignored.' });
    }

    // 2. Tạo một job duy nhất cho cả order
    const newPrintJob = new PrintJob({
      order_id: orderNumber,
      status: 'pending',
      items_to_print: order.line_items.map(item => ({
        product_name: item.title,
        variant_title: item.variant_title,
        sku: item.sku,
        quantity: item.quantity,
        price: item.price,
        original_item_data: item, // Lưu lại toàn bộ item gốc
      })),
    });

    // 3. Lưu vào DB và trả về ngay lập tức
    await newPrintJob.save();
    logger.info(`✅ Order ${orderNumber} saved as a pending job.`);
    
    // Rất quan trọng: Trả về 200 OK ngay lập tức
    res.status(200).json({ success: true, message: 'Order received and queued for printing.' });

  } catch (error) {
    logger.error('❌ Error in webhook endpoint:', error.message);
    res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

// --- API ENDPOINT ĐỂ IN LẠI MỘT ĐƠN HÀNG ---
app.post('/api/retry-order/:orderId', async (req, res) => {
  const { orderId } = req.params;

  try {
    await connectMongo();

    // Tìm job gốc và đặt lại trạng thái của nó
    const updatedJob = await PrintJob.findOneAndUpdate(
      { order_id: orderId },
      { 
        $set: { 
          status: 'pending', // Đặt lại trạng thái về 'pending'
          processing_details: [], // Xóa lịch sử xử lý cũ
          last_error: null, // Xóa lỗi cũ
        } 
      },
      { new: true } // Trả về document đã được cập nhật
    );

    if (!updatedJob) {
      return res.status(404).json({ success: false, message: 'Order not found.' });
    }

    logger.info(`✅ Order ${orderId} has been reset to 'pending' for retry.`);
    res.json({ success: true, message: 'Order successfully queued for retry.' });

  } catch (error) {
    logger.error(`❌ Failed to retry order ${orderId}:`, error.message);
    res.status(500).json({ success: false, message: 'Failed to retry order.', error: error.message });
  }
});

// --- CRON JOB ENDPOINT ĐỂ XỬ LÝ IN ẤN ---
app.get('/api/cron/process-jobs', async (req, res) => {
  // 1. Bảo vệ endpoint
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  try {
    await connectMongo();
    logger.info('⚙️ Cron job started: Looking for pending jobs...');

    // 2. Tìm một job 'pending' để xử lý
    const job = await PrintJob.findOneAndUpdate(
      { status: 'pending' },
      { $set: { status: 'processing' } },
      { new: true, sort: { created_at: 1 } }
    );

    if (!job) {
      logger.info('✅ No pending jobs to process.');
      return res.status(200).json({ message: 'No pending jobs.' });
    }

    logger.info(`🖨️ Processing order ${job.order_id}...`);
    let hasFailedItems = false;

    // 3. Lặp qua từng item và in
    for (const item of job.items_to_print) {
      for (let i = 0; i < item.quantity; i++) {
        try {
          const orderInfo = { orderNumber: job.order_id }; // Đơn giản hóa orderInfo
          const pdfBase64 = await createProductLabelPDF(item.original_item_data, orderInfo);
          const printTitle = `${job.order_id} - ${item.product_name} (${i + 1}/${item.quantity})`;
          const printResponse = await sendToPrintNode(pdfBase64, printTitle);

          job.processing_details.push({
            item_sku: item.sku,
            printnode_job_id: printResponse,
            status: 'sent',
            timestamp: new Date(),
          });
        } catch (error) {
          hasFailedItems = true;
          job.processing_details.push({
            item_sku: item.sku,
            status: 'failed',
            error_message: error.message,
            timestamp: new Date(),
          });
          logger.error(`❌ Failed to print item ${item.sku} for order ${job.order_id}:`, error.message);
        }
      }
    }

    // 4. Cập nhật trạng thái cuối cùng của job
    job.status = hasFailedItems ? 'failed' : 'completed';
    if (hasFailedItems) {
      job.last_error = 'One or more items failed to print. Check processing_details.';
    }
    await job.save();

    logger.info(`✅ Finished processing order ${job.order_id} with status: ${job.status}`);
    res.status(200).json({ success: true, order_id: job.order_id, status: job.status });

  } catch (error) {
    logger.error('🚨 Critical error in cron job processor:', error);
    // Cố gắng cập nhật lại job về 'failed' nếu có lỗi nghiêm trọng
    // (Cần thêm logic để tìm job đang 'processing' và cập nhật)
    res.status(500).json({ success: false, message: 'Cron job failed.' });
  }
});

// --- KHỞI ĐỘNG SERVER (CHO MÔI TRƯỜNG LOCAL/PM2) ---
let isServerRunning = false;

async function startServer() {
  if (isServerRunning) return;
  
  // Đợi MongoDB connected
  const maxAttempts = 30; // 30 giây
  let attempts = 0;
  
  while (mongoose.connection.readyState !== 1 && attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    attempts++;
    logger.log(`⏳ Waiting for MongoDB... (${attempts}/${maxAttempts})`);
  }
  
  if (mongoose.connection.readyState !== 1) {
    logger.error('❌ MongoDB connection failed after 30 seconds. Starting server anyway...');
  } else {
    logger.info('✅ MongoDB connected successfully!');
  }
  
  isServerRunning = true;
  
  if (require.main === module) {
    app.listen(PORT, () => {
      logger.info(`🚀 Server running for local/PM2 on http://localhost:${PORT}`);
    });
  }
}

if (require.main === module) {
  startServer();
}

// --- XUẤT APP (CHO SERVERLESS) ---
module.exports = app;