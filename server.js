const express = require('express');
const PDFDocument = require('pdfkit');
const axios = require('axios');
const path = require('path');
const Database = require('better-sqlite3'); // 1. Import thư viện
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// 2. Khởi tạo kết nối CSDL
// Thao tác này sẽ tạo file `print_system.db` nếu nó chưa tồn tại
const db = new Database('print_system.db', { verbose: console.log });

// 3. Tạo bảng nếu chưa có
// Bảng này sẽ lưu các sự kiện từ PrintNode
db.exec(`
  CREATE TABLE IF NOT EXISTS printnode_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT,
    content TEXT,
    received_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
// Bạn cũng nên tạo một bảng cho `printJobs` theo cách tương tự

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, './')); // Fix views path

// Store print jobs in memory (use database in production)
let printJobs = []; // Sẽ được thay thế bằng CSDL
// Store PrintNode webhook events in memory
// let printNodeEvents = []; // Dòng này không còn cần thiết

// PrintNode Configuration
const PRINTNODE_API_KEY = process.env.PRINTNODE_API_KEY;
const PRINTER_ID = process.env.PRINTER_ID || 74652384;
const PRINTNODE_WEBHOOK_SECRET = process.env.PRINTNODE_WEBHOOK_SECRET; // Add this

async function createProductLabelPDF(orderItem, orderInfo) {
  return new Promise((resolve, reject) => {
    try {
      // Gốc: 51mm ngang x 19mm dọc
      const pageWidth = 164.57; // 51mm
      const pageHeight = 53.86; // 19mm

      const doc = new PDFDocument({
        size: [pageWidth, pageHeight],
        margin: 0
      });


      try {
        doc.registerFont('Roboto-Bold', path.join(__dirname, 'fonts', 'Roboto-Bold.ttf'));
        doc.registerFont('Roboto-Regular', path.join(__dirname, 'fonts', 'Roboto-Regular.ttf'));
        doc.registerFont('Roboto-Italic', path.join(__dirname, 'fonts', 'Roboto-Italic.ttf'));
      } catch (fontError) {
        console.error('Lỗi đăng ký font:', fontError.message);
        // Nếu không tìm thấy file font, sử dụng font mặc định để tránh crash
        // Lưu ý: Font mặc định có thể không hiển thị tiếng Việt
        doc.font('Helvetica-Bold'); 
      }
      // --- KẾT THÚC THAY ĐỔI ---

      const chunks = [];

      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => {
        const pdfBuffer = Buffer.concat(chunks);
        const base64String = pdfBuffer.toString('base64');
        resolve(base64String);
      });

      // 👉 Nếu muốn lật ngược 180 độ (in upside down)
      // doc.rotate(180, { origin: [pageWidth/2, pageHeight/2] });

      // Layout params
      let yPosition = 7; 
      const contentWidth = pageWidth;
  
   // Order Number
      doc.fontSize(6)
        .font('Roboto-Bold')
        .text(orderInfo.orderNumber || 'N/A', 5, yPosition, {
          width: contentWidth,
          align: 'center'
        });

      yPosition += 9;

      // Product Title
      doc.fontSize(7)
        .font('Roboto-Bold')
        .text(orderItem.title || 'N/A', 45, yPosition, {
          width: contentWidth,
          align: 'center',
          ellipsis: true
        });

      yPosition += 9;

      // Variant Title
      if (orderItem.variant_title) {
        doc.fontSize(6)
          .font('Roboto-Regular')
          .text(orderItem.variant_title, 45, yPosition, {
            width: contentWidth,
            align: 'center',
            ellipsis: true
          });
        yPosition += 8;
      }

      // Note
      if (orderInfo.note) {
        doc.fontSize(5)
          .font('Roboto-Italic')
          .text(orderInfo.note, 45, yPosition, {
            width: contentWidth,
            align: 'center',
            ellipsis: true
          });
      }

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}


// Send print job to PrintNode
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
        // BỎ HẾT OPTIONS - Để driver máy in tự xử lý
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
    console.error('PrintNode Error:', error.response?.data || error.message);
    throw error;
  }
}


// Dashboard Route
app.get('/', (req, res) => {
  // Sort jobs by timestamp descending before rendering
  const sortedJobs = [...printJobs].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  
  const printerConfig = {
    printerId: PRINTER_ID,
    apiConfigured: !!PRINTNODE_API_KEY
  };

  res.render('dashboard', {
    printJobs: sortedJobs,
    printerConfig: printerConfig
  });
});

// API endpoint to get current jobs (for dashboard auto-refresh)
app.get('/api/jobs', (req, res) => {
  const sortedJobs = [...printJobs].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  res.json(sortedJobs);
});

// PrintNode Webhook Receiver
app.post('/printnode-webhook', (req, res) => {
  const receivedSecret = req.headers['x-printnode-webhook-secret'];

  // 1. Validate the secret
  if (!PRINTNODE_WEBHOOK_SECRET || receivedSecret !== PRINTNODE_WEBHOOK_SECRET) {
    console.warn('⚠️ Received webhook with invalid secret.');
    return res.status(401).send('Unauthorized');
  }

  // 2. Process the events and save to DB
  const events = req.body;
  if (Array.isArray(events)) {
    console.log(`🔔 Received ${events.length} event(s) from PrintNode webhook.`);
    
    // Chuẩn bị câu lệnh để chèn dữ liệu
    const insert = db.prepare('INSERT INTO printnode_events (event_type, content) VALUES (?, ?)');

    // Chạy transaction để chèn nhiều bản ghi hiệu quả hơn
    const insertMany = db.transaction((items) => {
      for (const item of items) {
        // Lưu toàn bộ object event dưới dạng chuỗi JSON
        insert.run(item.event, JSON.stringify(item));
      }
    });

    insertMany(events);
  }

  // 3. Respond correctly to PrintNode
  res.set('X-PrintNode-Webhook-Status', 'OK').status(200).send('OK');
});

// Page to display PrintNode webhook events
app.get('/printnode-status', (req, res) => {
  // 1. Lấy 100 sự kiện gần nhất từ CSDL
  const stmt = db.prepare('SELECT * FROM printnode_events ORDER BY received_at DESC LIMIT 100');
  const eventsFromDb = stmt.all();

  // 2. Chuyển đổi content từ chuỗi JSON thành object để hiển thị
  const formattedEvents = eventsFromDb.map(row => {
    const content = JSON.parse(row.content);
    return {
      ...content, // Giữ lại các trường gốc như timestamp, event
      received_at: row.received_at // Thêm thời gian nhận được từ CSDL
    };
  });

  // 3. Render trang 'status.ejs' với dữ liệu đã lấy được
  res.render('status', { 
    events: formattedEvents,
    webhookConfigured: !!PRINTNODE_WEBHOOK_SECRET
  });
});


// Shopify Webhook Handler
app.post('/webhooks', async (req, res) => {
  try {
    const order = req.body;
    const orderId = order.id;
    const orderNumber = order.name || order.order_number;
    const lineItems = order.line_items || [];
    const currency = order.currency || 'VND';
    const shippingAddress = order.shipping_address;
    const customerName = order.customer ? `${order.customer.first_name} ${order.customer.last_name}` : null;

    console.log(`📦 Received order: ${orderNumber} (${orderId}) with ${lineItems.length} items`);

    // Prepare order info for PDF
    const orderInfo = {
      orderId,
      orderNumber,
      currency,
      customerName,
      shippingAddress,
      note: order.note // Add note from order
    };

    // Process each line item - EACH ITEM GETS ITS OWN PDF
    const printResults = [];
    for (let i = 0; i < lineItems.length; i++) {
      const item = lineItems[i];
      
      // Loop for the quantity of each item
      for (let j = 0; j < item.quantity; j++) {
        // Generate a unique ID for this specific print attempt, including the copy number
        const jobAttemptId = `${orderNumber}-${item.id || i}-${j + 1}`;

        try {
          console.log(`🖨️  Processing item ${i + 1}/${lineItems.length} (Copy ${j + 1}/${item.quantity}): ${item.title}`);

          // Create separate PDF for this product
          const pdfBase64 = await createProductLabelPDF(item, orderInfo);

          // Build title for print job
          const printTitle = `${orderNumber} - ${item.title}${item.variant_title ? ' - ' + item.variant_title : ''} (${j + 1}/${item.quantity})`;

          // Send to PrintNode - SEPARATE PRINT JOB
          const printResponse = await sendToPrintNode(pdfBase64, printTitle);

          const jobRecord = {
            id: printResponse, // From PrintNode
            jobAttemptId: jobAttemptId, // Our internal ID
            orderId: orderNumber,
            productName: item.title,
            variantTitle: item.variant_title,
            sku: item.sku,
            quantity: item.quantity, // Keep original quantity for info
            status: 'sent',
            timestamp: new Date().toISOString()
          };

          printJobs.unshift(jobRecord);
          printResults.push(jobRecord);

          console.log(`✅ Print job for ${item.title} (Copy ${j + 1}) sent successfully (Job ID: ${printResponse})`);
          
          // Small delay between EACH print to avoid overwhelming the printer
          await new Promise(resolve => setTimeout(resolve, 500));
          
        } catch (error) {
          console.error(`❌ Failed to print item ${i + 1} (${item.title}), Copy ${j + 1}:`, error.message);
          const failedJobRecord = {
            id: null, // No PrintNode ID on failure
            jobAttemptId: jobAttemptId, // Our internal ID
            orderId: orderNumber,
            productName: item.title,
            variantTitle: item.variant_title,
            sku: item.sku,
            status: 'failed',
            error: error.message,
            timestamp: new Date().toISOString(),
            // Store data needed for retry
            retryData: {
              item: item,
              orderInfo: orderInfo
            }
          };
          printJobs.unshift(failedJobRecord);
          printResults.push(failedJobRecord);
        }
      }
    }

    // Keep only last 100 jobs
    if (printJobs.length > 100) {
      printJobs = printJobs.slice(0, 100);
    }

    console.log(`✅ Order ${orderNumber} completed: ${printResults.filter(r => r.status === 'sent').length}/${lineItems.length} items printed successfully`);

    res.status(200).json({
      success: true,
      message: `Processed ${lineItems.length} items from order ${orderNumber}`,
      printed: printResults.filter(r => r.status === 'sent').length,
      failed: printResults.filter(r => r.status === 'failed').length,
      results: printResults
    });

  } catch (error) {
    console.error('❌ Webhook processing error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// API endpoint to retry a failed job
app.post('/api/retry-job/:jobAttemptId', async (req, res) => {
  const { jobAttemptId } = req.params;
  const jobToRetry = printJobs.find(job => job.jobAttemptId === jobAttemptId);

  if (!jobToRetry) {
    return res.status(404).json({ success: false, message: 'Job not found.' });
  }

  if (jobToRetry.status !== 'failed') {
    return res.status(400).json({ success: false, message: 'Job is not in a failed state.' });
  }

  if (!jobToRetry.retryData) {
    return res.status(400).json({ success: false, message: 'No retry data available for this job.' });
  }

  try {
    const { item, orderInfo } = jobToRetry.retryData;
    console.log(`🔁 Retrying print for: ${item.title}`);

    // 1. Re-create PDF
    const pdfBase64 = await createProductLabelPDF(item, orderInfo);

    // 2. Re-build title
    const printTitle = `${orderInfo.orderNumber} - ${item.title}${item.variantTitle ? ' - ' + item.variantTitle : ''}`;

    // 3. Send to PrintNode
    const printResponse = await sendToPrintNode(pdfBase64, printTitle);

    // 4. Update job record on success
    jobToRetry.id = printResponse; // New PrintNode ID
    jobToRetry.status = 'sent';
    jobToRetry.timestamp = new Date().toISOString();
    jobToRetry.error = null;
    delete jobToRetry.retryData; // Clean up retry data

    console.log(`✅ Retry successful! New PrintNode Job ID: ${printResponse}`);

    res.json({
      success: true,
      message: 'Job successfully retried.',
      job: jobToRetry
    });

  } catch (error) {
    // 5. Update job record on another failure
    jobToRetry.error = error.message;
    jobToRetry.timestamp = new Date().toISOString();
    console.error(`❌ Retry failed for job ${jobAttemptId}:`, error.message);
    res.status(500).json({ success: false, message: 'Failed to retry job.', error: error.message });
  }
});

// Test endpoint - Test with 2 products
app.post('/api/test-print', async (req, res) => {
  try {
    // Simulate 2 products order
    const testItems = [
      {
        title: 'Bạc xỉu pha máy',
        variant_title: 'ICED',
        quantity: 2,
        sku: 'PIC BAS 003',
        price: '56'
      }
    ];

    const testOrderInfo = {
      orderId: '820982911946154508',
      orderNumber: '#9999',
      currency: 'VND',
      note: 'Cafe it duong, nhieu da' // Test note
    };

    const results = [];

    // Print each item separately
    for (let i = 0; i < testItems.length; i++) {
      const item = testItems[i];
      console.log(`Testing print ${i + 1}/${testItems.length}: ${item.title}`);
      
      const pdfBase64 = await createProductLabelPDF(item, testOrderInfo);
      const jobId = await sendToPrintNode(
        pdfBase64, 
        `Test ${testOrderInfo.orderNumber} - ${item.title}`
      );
      
      results.push({
        item: item.title,
        variant: item.variant_title,
        jobId: jobId
      });

      // Small delay between prints
      if (i < testItems.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    res.json({ 
      success: true, 
      message: `Sent ${testItems.length} print jobs`,
      results: results
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    apiConfigured: !!PRINTNODE_API_KEY
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📝 Webhook URL: http://localhost:${PORT}/webhooks/shopify/order-payment`);
  console.log(`🖨️  Printer ID: ${PRINTER_ID}`);
  console.log(`🔑 API Key configured: ${!!PRINTNODE_API_KEY}`);
});
