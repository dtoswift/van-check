'use strict';

/*
 * Monthly van check — server
 *
 * Responsibilities:
 *   1. Serve the static page (public/) and the jsPDF browser bundle.
 *   2. POST /api/send-report: receive one PDF in memory, email it to the
 *      manager address the operative confirmed, then drop it.
 *
 * Nothing is written to disk or a database. The PDF lives only in this
 * request's memory and is released when the response is sent.
 */

require('dotenv').config();

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const nodemailer = require('nodemailer');

const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';
const MAX_PDF_MB = Number(process.env.MAX_PDF_MB || 20);
const ALLOWED_DOMAINS = (process.env.ALLOWED_RECIPIENT_DOMAINS || '')
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

// Without a domain allowlist, anyone who finds the page could use it to send
// PDFs to any address. Refuse to start in production without one.
if (IS_PROD && ALLOWED_DOMAINS.length === 0) {
  console.error('ALLOWED_RECIPIENT_DOMAINS must be set in production (e.g. "yourcompany.co.uk").');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Mail transport
// ---------------------------------------------------------------------------
let transporter;
let devMail = false;

if (process.env.SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true', // true for port 465
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
  transporter.verify().catch((err) => {
    console.warn('SMTP check failed at startup (emails will fail until fixed):', err.code || err.message);
  });
} else if (!IS_PROD) {
  // Local development without SMTP: build the message but don't send it.
  devMail = true;
  transporter = nodemailer.createTransport({ jsonTransport: true });
  console.log('No SMTP_HOST set: running in dev mode, emails are built but NOT sent.');
} else {
  console.error('SMTP_HOST must be set in production.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();

// Behind a hosting proxy (Render, Railway, Azure, Heroku…) set TRUST_PROXY=1
// so the rate limiter sees the real client address.
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY));

app.disable('x-powered-by');
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'script-src': ["'self'"],
        'img-src': ["'self'", 'blob:', 'data:'],
        'connect-src': ["'self'"],
        // Allow plain http when testing on a phone over the local network.
        'upgrade-insecure-requests': IS_PROD ? [] : null,
      },
    },
    // HSTS only makes sense once you're on HTTPS in production.
    strictTransportSecurity: IS_PROD,
  })
);

app.use(
  '/vendor/jspdf',
  express.static(path.join(__dirname, 'node_modules', 'jspdf', 'dist'), {
    maxAge: IS_PROD ? '7d' : 0,
  })
);
app.use(express.static(path.join(__dirname, 'public'), { maxAge: IS_PROD ? '1h' : 0 }));

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Lets the page warn about a wrong email domain before the operative sends.
app.get('/api/config', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ allowedDomains: ALLOWED_DOMAINS, maxPdfMb: MAX_PDF_MB });
});

// ---------------------------------------------------------------------------
// POST /api/send-report
// ---------------------------------------------------------------------------
const upload = multer({
  storage: multer.memoryStorage(), // never touches disk
  limits: {
    fileSize: MAX_PDF_MB * 1024 * 1024,
    files: 1,
    fields: 10,
    fieldSize: 2000,
  },
});

const sendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.SEND_LIMIT_PER_15_MIN || 10),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    ok: false,
    message: 'Too many emails have been sent from this connection. Wait 15 minutes and try again, or download the PDF instead.',
  },
});

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Strip line breaks (header-injection guard) and cap length.
const clean = (value, max) => String(value || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);

const prettyDate = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
};

function receivePdf(req, res, next) {
  upload.single('pdf')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        ok: false,
        message: `The PDF is bigger than ${MAX_PDF_MB} MB. Go back, remove a few photos and create it again.`,
      });
    }
    return res.status(400).json({
      ok: false,
      message: 'The upload didn’t arrive in one piece. Check your signal and try again.',
    });
  });
}

app.post('/api/send-report', sendLimiter, receivePdf, async (req, res) => {
  res.set('Cache-Control', 'no-store');

  const managerEmail = clean(req.body.managerEmail, 254).toLowerCase();
  const operativeName = clean(req.body.operativeName, 100);
  const employeeId = clean(req.body.employeeId, 40);
  const checkDate = clean(req.body.checkDate, 10);
  const pdf = req.file;

  const fail = (status, message) => res.status(status).json({ ok: false, message });

  if (!EMAIL_RE.test(managerEmail)) return fail(400, 'That manager email address doesn’t look right. Check it and try again.');
  const domain = managerEmail.split('@')[1];
  if (ALLOWED_DOMAINS.length && !ALLOWED_DOMAINS.includes(domain)) {
    return fail(400, `Reports can only be emailed to ${ALLOWED_DOMAINS.map((d) => '@' + d).join(' or ')} addresses.`);
  }
  if (!operativeName || !employeeId) return fail(400, 'Your name or employee ID is missing. Go back and fill them in.');
  if (!DATE_RE.test(checkDate)) return fail(400, 'The date of the check is missing. Go back and fill it in.');
  if (!pdf || !pdf.buffer || pdf.buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    return fail(400, 'The PDF didn’t arrive properly. Try sending again.');
  }

  // Keep the page's file name (so the email matches the download), made safe.
  const safeId = employeeId.replace(/[^A-Za-z0-9_-]/g, '');
  const sentName = String(pdf.originalname || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 120);
  const filename = /^[A-Za-z0-9_-]+\.pdf$/.test(sentName) ? sentName : `vehicle-check_${safeId || 'operative'}_${checkDate}.pdf`;
  const when = prettyDate(checkDate);

  try {
    const info = await transporter.sendMail({
      from: process.env.MAIL_FROM || 'Van checks <no-reply@localhost>',
      to: managerEmail,
      subject: `Monthly van check: ${operativeName} (${employeeId}), ${when}`,
      text: [
        `${operativeName} (employee ID ${employeeId}) has completed their monthly van check dated ${when}.`,
        '',
        'The full report, with every answer and the van photos, is attached as a PDF.',
        '',
        'This email was sent from the van check page. The report isn’t stored anywhere else, so save the attachment if you need to keep it.',
      ].join('\n'),
      attachments: [{ filename, content: pdf.buffer, contentType: 'application/pdf' }],
    });

    if (devMail) {
      console.log(`[dev] Would have emailed ${managerEmail}: ${filename} (${Math.round(pdf.size / 1024)} KB)`);
    }
    void info;
    return res.json({ ok: true, dev: devMail || undefined });
  } catch (err) {
    // Log the failure type only, never the content or addresses.
    console.error('Email send failed:', err.code || err.name || 'unknown');
    return fail(502, 'The email server didn’t accept the report.');
  } finally {
    if (req.file) req.file.buffer = null; // release the PDF immediately
  }
});

app.use('/api', (_req, res) => res.status(404).json({ ok: false, message: 'Not found.' }));

// Last-resort error handler: plain message, no stack traces to the client.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err.code || err.name || 'unknown');
  res.status(500).json({ ok: false, message: 'Something went wrong on the server. Try again.' });
});

app.listen(PORT, () => {
  console.log(`Van check running on http://localhost:${PORT}`);
});
