import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pdf = require("pdf-parse");

console.log("PDF Type:", typeof pdf);
console.log("PDFParse Type:", typeof pdf.PDFParse);

// If it's the one I think it is, it might be a class or a function
if (typeof pdf.PDFParse === 'function') {
    console.log("Calling pdf.PDFParse...");
    // Try to call it with empty buffer to see if it throws "not a function" or something else
    try {
        pdf.PDFParse(Buffer.from([]));
        console.log("Call success (on empty buffer)");
    } catch (e) {
        console.log("Call error:", e.message);
    }
}
