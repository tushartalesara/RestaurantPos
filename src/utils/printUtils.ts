import { Platform } from "react-native"
import * as Print from "expo-print"
import type { ReceiptOrder } from "../types"
import { escapeReceiptHtml, formatReceiptDate, getReceiptNumericString } from "./formatters"

function getReceiptBodyMarkup(order: ReceiptOrder, restaurantName: string): string {
  const itemRows = (order.items || order.order_items || [])
    .map((item) => {
      const name = escapeReceiptHtml(String(item.name || item.item_name || "").toUpperCase())
      const quantity = escapeReceiptHtml(String(item.quantity || item.qty || 1))
      const price = getReceiptNumericString(item.price || item.unit_price || 0)
      return `
        <tr>
          <td class="desc">${name}</td>
          <td class="qty">${quantity}</td>
          <td class="price">&#8377;${price}</td>
        </tr>
      `
    })
    .join("")

  const total = getReceiptNumericString(order.total_amount || order.total || 0)
  const orderCode = escapeReceiptHtml(String(order.short_code || order.id || ""))
  const customerName = escapeReceiptHtml(String(order.customer_name || order.contact_name || "Guest"))
  const phone = escapeReceiptHtml(String(order.customer_phone || order.contact_phone || "").trim())
  const notes = escapeReceiptHtml(String(order.notes || order.special_instructions || "").trim())
  const dateStr = escapeReceiptHtml(formatReceiptDate(order.created_at))
  const status = escapeReceiptHtml(String(order.status || "PENDING").toUpperCase())
  const safeRestaurantName = escapeReceiptHtml(restaurantName || "Restaurant")

  return `
    <div class="restaurant-name">${safeRestaurantName}</div>
    <div class="tagline">Voice Ordering System</div>
    <div class="divider divider-solid">================================</div>

    <div class="order-number">ORDER #${orderCode}</div>
    <div class="status-row">
      <span class="status-badge">${status}</span>
    </div>
    <div class="divider">--------------------------------</div>

    <div class="meta-row">
      <span>Date:</span>
      <span>${dateStr}</span>
    </div>
    <div class="meta-row">
      <span>Customer:</span>
      <span class="bold">${customerName}</span>
    </div>
    ${phone ? `<div class="meta-row"><span>Phone:</span><span>${phone}</span></div>` : ""}
    ${notes ? `<div class="meta-row"><span>Notes:</span><span>${notes}</span></div>` : ""}
    <div class="divider">--------------------------------</div>

    <table>
      <thead>
        <tr>
          <th class="desc">Item</th>
          <th class="qty">Qty</th>
          <th class="price">Price</th>
        </tr>
      </thead>
      <tbody>
        ${itemRows}
      </tbody>
    </table>
    <div class="divider divider-solid">================================</div>

    <div class="total-row">
      <span>TOTAL</span>
      <span>&#8377;${total}</span>
    </div>
    <div class="divider">--------------------------------</div>

    <div class="footer">
      <div class="thankyou">Thank You!</div>
      <div>Order placed via Voice AI &#127897;</div>
      <div>Please retain this receipt</div>
    </div>
  `
}

function getReceiptStyles(paperWidth: "58mm" | "80mm" = "80mm"): string {
  return `
    @page {
      size: ${paperWidth} auto;
      margin: 0mm;
    }
    html, body {
      width: ${paperWidth};
      margin: 0 !important;
      padding: 0 !important;
      background: #fff;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: 'Courier New', Courier, monospace;
      font-size: 11px;
      line-height: 1.4;
      color: #000;
      width: ${paperWidth};
      padding: 4mm 3mm;
      background: #fff;
    }
    .bold { font-weight: bold; }
    .restaurant-name {
      font-size: 20px;
      font-weight: bold;
      text-align: center;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 2px;
    }
    .tagline {
      font-size: 10px;
      text-align: center;
      color: #555;
      margin-bottom: 6px;
    }
    .divider {
      font-size: 8px;
      text-align: center;
      margin: 5px 0;
      white-space: nowrap;
      overflow: hidden;
    }
    .divider-solid {
      font-weight: bold;
    }
    .meta-row {
      display: flex;
      justify-content: space-between;
      font-size: 12px;
      gap: 8px;
      margin: 2px 0;
    }
    .meta-row span:last-child {
      text-align: right;
      overflow-wrap: anywhere;
    }
    .order-number {
      font-size: 18px;
      font-weight: bold;
      text-align: center;
      margin: 5px 0 2px 0;
      letter-spacing: 2px;
    }
    .status-row {
      text-align: center;
      margin-bottom: 4px;
    }
    .status-badge {
      display: inline-block;
      border: 1.5px solid #000;
      background: transparent;
      color: #000;
      padding: 1px 6px;
      border-radius: 3px;
      font-size: 9px;
      font-weight: bold;
      letter-spacing: 0.5px;
      text-transform: uppercase;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 4px 0;
    }
    th, td {
      font-size: 11px;
      padding: 2px 0;
      vertical-align: top;
    }
    thead tr th {
      font-size: 11px;
      font-weight: bold;
      text-transform: uppercase;
      border-bottom: 1px solid #000;
    }
    .desc { width: 55%; text-align: left; }
    .qty { width: 10%; text-align: center; }
    .price { width: 35%; text-align: right; }
    .total-row {
      display: flex;
      justify-content: space-between;
      font-size: 16px;
      font-weight: bold;
      padding: 4px 0 2px 0;
    }
    .footer {
      text-align: center;
      font-size: 10px;
      color: #444;
      margin-top: 8px;
      line-height: 1.6;
    }
    .footer .thankyou {
      font-size: 13px;
      font-weight: bold;
      margin-bottom: 2px;
    }
    @media print {
      html, body {
        width: ${paperWidth};
        margin: 0;
        padding: 0;
      }
    }
  `
}

export function generateReceiptHTML(order: ReceiptOrder, restaurantName: string, paperWidth: "58mm" | "80mm" = "80mm"): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Receipt #${escapeReceiptHtml(String(order.short_code || order.id || ""))}</title>
  <style>${getReceiptStyles(paperWidth)}</style>
</head>
<body>${getReceiptBodyMarkup(order, restaurantName)}</body>
</html>`
}

export function generateCombinedReceiptHTML(
  orders: ReceiptOrder[],
  restaurantName: string,
  paperWidth: "58mm" | "80mm" = "80mm",
): string {
  const receiptDocuments = orders
    .map((order) => `<section class="receipt-page">${getReceiptBodyMarkup(order, restaurantName)}</section>`)
    .join(`<div style="page-break-after: always;"></div>`)

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Receipts</title>
  <style>
    ${getReceiptStyles(paperWidth)}
    .receipt-page { break-inside: avoid; }
  </style>
</head>
<body>${receiptDocuments}</body>
</html>`
}

export function printHtmlInHiddenIframe(html: string) {
  if (Platform.OS !== "web" || typeof document === "undefined") {
    return
  }

  const iframe = document.createElement("iframe")
  iframe.style.position = "fixed"
  iframe.style.right = "0"
  iframe.style.bottom = "0"
  iframe.style.width = "0"
  iframe.style.height = "0"
  iframe.style.border = "none"
  document.body.appendChild(iframe)

  const iframeWindow = iframe.contentWindow
  const doc = iframeWindow?.document
  if (!iframeWindow || !doc) {
    document.body.removeChild(iframe)
    throw new Error("Could not prepare print preview.")
  }

  doc.open()
  doc.write(html)
  doc.close()

  const cleanup = () => {
    try {
      document.body.removeChild(iframe)
    } catch {}
  }

  iframe.onload = () => {
    setTimeout(() => {
      try {
        iframeWindow.focus()
        iframeWindow.print()
      } finally {
        setTimeout(cleanup, 1000)
      }
    }, 300)
  }

  setTimeout(() => {
    try {
      iframeWindow.focus()
      iframeWindow.print()
    } catch {}
  }, 500)
}

export async function printReceiptHtml(html: string) {
  if (Platform.OS === "web") {
    printHtmlInHiddenIframe(html)
    return
  }

  await Print.printAsync({ html })
}
