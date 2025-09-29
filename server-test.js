const fs = require('fs');
const PDFDocument = require('pdfkit');

// === Import function của bạn ===
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

// === TEST ===
(async () => {
  try {
    const orderItem = {
      title: "Nike Air Force 1",
      variant_title: "Size 42 - White",
      note:"cafe it duong"
    };

    const orderInfo = {
      id: 123456,
      name: "#1001",
      note:"cafe it duong"
    };

    const base64PDF = await createProductLabelPDF(orderItem, orderInfo);

    // Lưu file để xem kết quả
    fs.writeFileSync('test-label1.pdf', Buffer.from(base64PDF, 'base64'));

    console.log("✅ PDF label created: test-label.pdf");
  } catch (err) {
    console.error("❌ Error:", err);
  }
})();
