const express = require('express');
const PDFDocument = require('pdfkit');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, './')); // Fix views path

// Store print jobs in memory (use database in production)
let printJobs = [];

// PrintNode Configuration
const PRINTNODE_API_KEY = process.env.PRINTNODE_API_KEY;
const PRINTER_ID = process.env.PRINTER_ID || 74727567;

// Create PDF from order item - 19mm x 51mm label (landscape)
async function createProductLabelPDF(orderItem, orderInfo) {
  return new Promise((resolve, reject) => {
    try {
      // 19mm x 51mm = 53.86pt x 144.57pt (1mm = 2.83465pt)
      const doc = new PDFDocument({ 
        size: [144.57, 53.86], // width x height in points (landscape)
        margin: 5 
      });
      const chunks = [];

      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => {
        const pdfBuffer = Buffer.concat(chunks);
        const base64String = pdfBuffer.toString('base64');
        resolve(base64String);
      });

      // Calculate center position
      const pageWidth = 144.57;
      const pageHeight = 53.86;
      let yPosition = 8;

      // Product Title - centered and bold
      doc.fontSize(9)
         .font('Helvetica-Bold')
         .text(orderItem.title || 'N/A', 5, yPosition, {
           width: pageWidth - 10,
           align: 'center'
         });

      yPosition += 12;

      // Variant Title - centered (if exists)
      if (orderItem.variant_title) {
        doc.fontSize(7)
           .font('Helvetica')
           .text(orderItem.variant_title, 5, yPosition, {
             width: pageWidth - 10,
             align: 'center'
           });
        yPosition += 10;
      }

      // Note - centered and italic (if exists)
      if (orderInfo.note) {
        doc.fontSize(6)
           .font('Helvetica-Oblique') // Oblique = Italic
           .text(orderInfo.note, 5, yPosition, {
             width: pageWidth - 10,
             align: 'center'
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
        content: pdfBase64
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

// Shopify Webhook Handler
app.post('/webhooks/shopify/order-payment', async (req, res) => {
  try {
    const order = req.body;
    const orderId = order.id;
    const orderNumber = order.name || order.order_number; // #9999
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
      
      try {
        console.log(`🖨️  Processing item ${i + 1}/${lineItems.length}: ${item.title} ${item.variant_title ? '- ' + item.variant_title : ''}`);

        // Create separate PDF for this product
        const pdfBase64 = await createProductLabelPDF(item, orderInfo);

        // Build title for print job
        const printTitle = `${orderNumber} - ${item.title}${item.variant_title ? ' - ' + item.variant_title : ''}`;

        // Send to PrintNode - SEPARATE PRINT JOB
        const printResponse = await sendToPrintNode(pdfBase64, printTitle);

        const jobRecord = {
          id: printResponse,
          orderId: orderNumber,
          productName: item.title,
          variantTitle: item.variant_title,
          sku: item.sku,
          quantity: item.quantity,
          status: 'sent',
          timestamp: new Date().toISOString()
        };

        printJobs.unshift(jobRecord);
        printResults.push(jobRecord);

        console.log(`✅ Print job ${i + 1} sent successfully (Job ID: ${printResponse})`);
        
        // Small delay between prints to avoid overwhelming the printer
        if (i < lineItems.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        
      } catch (error) {
        console.error(`❌ Failed to print item ${i + 1} (${item.title}):`, error.message);
        printResults.push({
          orderId: orderNumber,
          productName: item.title,
          variantTitle: item.variant_title,
          sku: item.sku,
          status: 'failed',
          error: error.message,
          timestamp: new Date().toISOString()
        });
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

// Dashboard Routes
app.get('/', (req, res) => {
  res.render('dashboard', {
    printJobs: printJobs,
    printerConfig: {
      printerId: PRINTER_ID,
      apiConfigured: !!PRINTNODE_API_KEY
    }
  });
});

// API endpoint to get jobs
app.get('/api/jobs', (req, res) => {
  res.json(printJobs);
});

// Test endpoint - Test with 2 products
app.post('/api/test-print', async (req, res) => {
  try {
    // Simulate 2 products order
    const testItems = [
      {
        title: 'ZIN PROMENADE Picnic Basket',
        variant_title: 'Large / Blue',
        quantity: 1,
        sku: 'PIC BAS 003',
        price: '56'
      },
      {
        title: 'ZEN Country Picnic Basket',
        variant_title: 'Medium / Red',
        quantity: 1,
        sku: 'PIC BAS 002',
        price: '80'
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