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

logger.info('🔍 MongoDB URI check:', mongoUri ? '✅ Set' : '❌ NOT SET');

if (!mongoUri) {
  logger.error('❌ CRITICAL: MONGODB_URI environment variable is not set!');
}

const connectMongo = async () => {
  try {
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      connectTimeoutMS: 15000,
      retryWrites: true,
      maxPoolSize: 10,
      family: 4 // Force IPv4
    });
    logger.info('✅ MongoDB connection established successfully');
    return true;
  } catch (err) {
    logger.error('❌ MongoDB connection error:', err.message);
    return false;
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
  printnode_job_id: Number,
  job_attempt_id: { type: String, unique: true, required: true },
  order_id: { type: String, index: true },
  product_name: String,
  variant_title: String,
  sku: String,
  quantity: Number,
  price: String,
  status: { type: String, enum: ['pending', 'sent', 'failed'], default: 'pending' },
  error_message: String,
  retry_data: String,
}, { timestamps: { createdAt: 'created_at' } });

const PrintJob = mongoose.model('PrintJob', PrintJobSchema);

const PrintNodeEventSchema = new mongoose.Schema({
  event_type: String,
  content: mongoose.Schema.Types.Mixed,
}, { timestamps: { createdAt: 'received_at' } });

const PrintNodeEvent = mongoose.model('PrintNodeEvent', PrintNodeEventSchema);

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, './'));

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

// Shopify Webhook Handler
app.post('/webhooks', async (req, res) => {
  const order = req.body;
  const orderNumber = order.name || order.order_number;
  logger.info(`📦 Received webhook for order: ${orderNumber}`);

  const existingJob = await PrintJob.findOne({ order_id: orderNumber });
  if (existingJob) {
    logger.log(`⚠️ Order ${orderNumber} already processed. Ignoring duplicate webhook.`);
    return res.status(200).json({ success: true, message: 'Duplicate webhook ignored.' });
  }

  res.status(200).json({ success: true, message: `Order ${orderNumber} accepted.` });
  processOrderInBackground(order);
});

// Background Processing Function
async function processOrderInBackground(order) {
  const orderNumber = order.name || order.order_number;
  const lineItems = order.line_items || [];
  logger.info(`⚙️  Starting background processing for order ${orderNumber}`);

  const orderInfo = {
    orderId: order.id,
    orderNumber: orderNumber,
    currency: order.currency,
    customerName: order.customer ? `${order.customer.first_name} ${order.customer.last_name}` : null,
    shippingAddress: order.shipping_address,
    note: order.note
  };

  const printTasks = [];

  for (const item of lineItems) {
    for (let j = 0; j < item.quantity; j++) {
      const jobAttemptId = `${orderNumber}-${item.id || 'no-id'}-${j + 1}`;
      const retryData = JSON.stringify({ item, orderInfo });

      const task = limit(async () => {
        const newJob = new PrintJob({
          job_attempt_id: jobAttemptId,
          order_id: orderNumber,
          product_name: item.title,
          variant_title: item.variant_title,
          sku: item.sku,
          quantity: item.quantity,
          price: item.price,
          status: 'pending',
          retry_data: retryData
        });
        await newJob.save();

        try {
          logger.log(`🖨️  Processing item (Copy ${j + 1}/${item.quantity}): ${item.title}`);
          const pdfBase64 = await createProductLabelPDF(item, orderInfo);
          const printTitle = `${orderNumber} - ${item.title}${item.variant_title ? ' - ' + item.variant_title : ''} (${j + 1}/${item.quantity})`;
          const printResponse = await sendToPrintNode(pdfBase64, printTitle);

          newJob.status = 'sent';
          newJob.printnode_job_id = printResponse;
          await newJob.save();
          logger.log(`✅ Print job for ${item.title} (Copy ${j + 1}) sent successfully (Job ID: ${printResponse})`);
        } catch (error) {
          logger.error(`❌ Failed to print item ${item.title}, Copy ${j + 1}:`, error.message);
          newJob.status = 'failed';
          newJob.error_message = error.message;
          await newJob.save();
        }
      });
      printTasks.push(task);
    }
  }

  try {
    await Promise.all(printTasks);
    logger.info(`✅ Finished all tasks for order ${orderNumber}`);
  } catch (error) {
    logger.error(`🚨 An unexpected error occurred while processing the print queue for order ${orderNumber}:`, error);
  }
}

// Retry Job Endpoint
app.post('/api/retry-job/:jobAttemptId', async (req, res) => {
  const { jobAttemptId } = req.params;
  const originalJob = await PrintJob.findOne({ job_attempt_id: jobAttemptId });

  if (!originalJob || !originalJob.retry_data) {
    return res.status(404).json({ success: false, message: 'Job not found or not retryable.' });
  }

  try {
    const { item, orderInfo } = JSON.parse(originalJob.retry_data);
    logger.info(`🔁 Retrying print for: ${item.title} from Order ${orderInfo.orderNumber}`);

    const pdfBase64 = await createProductLabelPDF(item, orderInfo);
    const printTitle = `[RETRY] ${orderInfo.orderNumber} - ${item.title}${item.variant_title ? ' - ' + item.variant_title : ''}`;
    const printResponse = await sendToPrintNode(pdfBase64, printTitle);

    const newJobAttemptId = `${originalJob.job_attempt_id}-retry-${Date.now()}`;
    await PrintJob.create({
      job_attempt_id: newJobAttemptId,
      printnode_job_id: printResponse,
      order_id: orderInfo.orderNumber,
      product_name: item.title,
      variant_title: item.variant_title,
      sku: item.sku,
      quantity: item.quantity,
      price: item.price,
      status: 'sent',
      retry_data: originalJob.retry_data
    });

    logger.info(`✅ Retry successful! New PrintNode Job ID: ${printResponse}, New DB Job ID: ${newJobAttemptId}`);
    res.json({ success: true, message: 'Job successfully retried as a new print job.' });
  } catch (error) {
    logger.error(`❌ Retry failed for job ${jobAttemptId}:`, error.message);
    res.status(500).json({ success: false, message: 'Failed to retry job.', error: error.message });
  }
});

// Test Print Endpoint
app.post('/api/test-print', async (req, res) => {
  try {
    const testItems = [{ title: 'Bạc xỉu pha máy', variant_title: 'ICED', quantity: 2, sku: 'PIC BAS 003', price: '56' }];
    const testOrderInfo = { orderId: '820982911946154508', orderNumber: '#9999', currency: 'VND', note: 'Cafe it duong, nhieu da' };
    const results = [];
    for (let i = 0; i < testItems.length; i++) {
      const item = testItems[i];
      logger.log(`Testing print ${i + 1}/${testItems.length}: ${item.title}`);
      const pdfBase64 = await createProductLabelPDF(item, testOrderInfo);
      const jobId = await sendToPrintNode(pdfBase64, `Test ${testOrderInfo.orderNumber} - ${item.title}`);
      results.push({ item: item.title, variant: item.variant_title, jobId: jobId });
      if (i < testItems.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    res.json({ success: true, message: `Sent ${testItems.length} print jobs`, results: results });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), apiConfigured: !!PRINTNODE_API_KEY });
});

// --- KHỞI ĐỘNG SERVER ---
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