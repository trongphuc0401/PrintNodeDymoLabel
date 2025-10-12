const express = require('express');
const PDFDocument = require('pdfkit');
const axios = require('axios');
const path = require('path');
const mongoose = require('mongoose');
const pLimit = require('p-limit'); // SỬA DÒNG NÀY: Bỏ .default
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// --- TỐI ƯU HÓA: TẠO LOGGER ĐƠN GIẢN ---
const logger = {
  log: (...args) => {
    // Chỉ log chi tiết khi không ở môi trường production
    if (process.env.NODE_ENV !== 'production') {
      console.log(...args);
    }
  },
  info: console.log, // Luôn log các thông tin quan trọng
  error: console.error, // Luôn log lỗi
};

// Khởi tạo p-limit trực tiếp
const limit = pLimit(3);

// --- KẾT NỐI MONGODB ---
// Mongoose sẽ tự động đệm các thao tác cho đến khi kết nối thành công
mongoose.connect(process.env.MONGODB_URI)
  .then(() => logger.info('✅ MongoDB connection initiated.'))
  .catch(err => logger.error('❌ MongoDB initial connection error:', err.message));

// --- 3. ĐỊNH NGHĨA MONGOOSE SCHEMAS VÀ MODELS ---
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
  retry_data: String, // Vẫn là JSON string để dễ dàng parse lại
}, { timestamps: { createdAt: 'created_at' } });

const PrintJob = mongoose.model('PrintJob', PrintJobSchema);

const PrintNodeEventSchema = new mongoose.Schema({
  event_type: String,
  content: mongoose.Schema.Types.Mixed, // Lưu toàn bộ object event
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

// --- CÁC HÀM TIỆN ÍCH (Không đổi) ---
async function createProductLabelPDF(orderItem, orderInfo) {
  // ... (Nội dung hàm này giữ nguyên, không cần thay đổi)
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
  // ... (Nội dung hàm này giữ nguyên, không cần thay đổi)
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

// --- 4. CẬP NHẬT CÁC ROUTE ĐỂ DÙNG MONGOOSE ---

// Dashboard Route
app.get('/', async (req, res) => {
  try {
    const jobsFromDb = await PrintJob.find().sort({ created_at: -1 }).limit(100);
    
    // THÊM DÒNG NÀY ĐỂ KIỂM TRA
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
    logger.error("❌ Error fetching jobs for dashboard:", error);
    res.status(500).send("Error loading dashboard data. Check server logs.");
  }
});

// API endpoint to get current jobs
app.get('/api/jobs', async (req, res) => {
  const jobsFromDb = await PrintJob.find().sort({ created_at: -1 }).limit(100);
  res.json(jobsFromDb); // Trả về document trực tiếp
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

// Page to display PrintNode webhook events
app.get('/printnode-status', async (req, res) => {
  const eventsFromDb = await PrintNodeEvent.find().sort({ received_at: -1 }).limit(100);
  res.render('status', {
    events: eventsFromDb.map(e => e.content), // Lấy nội dung gốc để hiển thị
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

// Hàm xử lý nền
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

  // 3. Tạo một mảng để chứa tất cả các tác vụ in
  const printTasks = [];

  for (const item of lineItems) {
    for (let j = 0; j < item.quantity; j++) {
      const jobAttemptId = `${orderNumber}-${item.id || 'no-id'}-${j + 1}`;
      const retryData = JSON.stringify({ item, orderInfo });

      // 4. Đưa tác vụ vào hàng đợi của p-limit
      // Mỗi tác vụ là một hàm async được bọc bởi `limit()`
      const task = limit(async () => {
        // Tạo job với trạng thái 'pending'
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

          // Cập nhật khi thành công
          newJob.status = 'sent';
          newJob.printnode_job_id = printResponse;
          await newJob.save();
          logger.log(`✅ Print job for ${item.title} (Copy ${j + 1}) sent successfully (Job ID: ${printResponse})`);
        } catch (error) {
          logger.error(`❌ Failed to print item ${item.title}, Copy ${j + 1}:`, error.message);
          // Cập nhật khi thất bại
          newJob.status = 'failed';
          newJob.error_message = error.message;
          await newJob.save();
        }
      });
      printTasks.push(task);
    }
  }

  // 5. Chạy tất cả các tác vụ trong hàng đợi
  try {
    await Promise.all(printTasks);
    logger.info(`✅ Finished all tasks for order ${orderNumber}`);
  } catch (error) {
    // Lỗi này thường không xảy ra vì chúng ta đã bắt lỗi bên trong mỗi task
    logger.error(`🚨 An unexpected error occurred while processing the print queue for order ${orderNumber}:`, error);
  }
}

// API endpoint to retry a job
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

    // Tạo một bản ghi job MỚI cho lần retry với ĐẦY ĐỦ thông tin
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
      retry_data: originalJob.retry_data // Vẫn lưu lại retry_data để có thể retry tiếp
    });

    logger.info(`✅ Retry successful! New PrintNode Job ID: ${printResponse}, New DB Job ID: ${newJobAttemptId}`);
    res.json({ success: true, message: 'Job successfully retried as a new print job.' });
  } catch (error) {
    logger.error(`❌ Retry failed for job ${jobAttemptId}:`, error.message);
    res.status(500).json({ success: false, message: 'Failed to retry job.', error: error.message });
  }
});

// Test endpoint
app.post('/api/test-print', async (req, res) => {
  // ... (Hàm này giữ nguyên, không cần thay đổi)
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

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), apiConfigured: !!PRINTNODE_API_KEY });
});

// --- KHỞI ĐỘNG SERVER (CHO MÔI TRƯỜNG LOCAL/PM2) ---
// Đoạn code này sẽ kiểm tra xem tệp có được chạy trực tiếp hay không
if (require.main === module) {
  app.listen(PORT, () => {
    logger.info(`🚀 Server running for local/PM2 on http://localhost:${PORT}`);
  });
}

// --- XUẤT APP (CHO MÔI TRƯỜNG SERVERLESS) ---
// Luôn xuất đối tượng app để các nền tảng như Vercel có thể sử dụng
module.exports = app;
